import type { Redis } from 'ioredis';
import { z } from 'zod';
import {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_PRIORITY,
  MAX_PRIORITY,
  MIN_PRIORITY,
  type CreateJobInput,
  type Job,
  type JobData,
} from '../types/job';
import { createJobId } from '../utils/id';
import { logger } from '../utils/logger';
import { QUEUE_KEYS, type QueueKeySet } from './keys';

/**
 * Producer-side validation of the fields a caller may supply.
 *
 * `.parse()` throws a `ZodError` on bad input. That is intentional: an invalid
 * job should be rejected at the API boundary, never written to Redis where a
 * worker would later have to guess what to do with it.
 */
const createJobInputSchema = z.object({
  type: z.string().trim().min(1, 'job "type" must be a non-empty string'),
  data: z.record(z.string(), z.unknown()).default({}),
  priority: z
    .number()
    .int()
    .min(MIN_PRIORITY)
    .max(MAX_PRIORITY)
    .default(DEFAULT_PRIORITY),
  delay: z.number().int().min(0).default(0),
  maxAttempts: z.number().int().min(1).default(DEFAULT_MAX_ATTEMPTS),
});

/** A delayed job together with the timestamp it is scheduled to run at. */
export interface ScheduledJob {
  job: Job;
  /** Unix epoch ms — the ZSET score. */
  runAt: number;
}

/** Snapshot of queue depths, used for monitoring and the Phase 4 dashboard. */
export interface QueueStats {
  active: number;
  delayed: number;
  processing: number;
  dead: number;
}

/**
 * QueueEngine
 * -----------
 * The write-side (producer) API of the scheduler. It knows *where* a job
 * belongs — the FIFO `active` LIST or the time-scored `delayed` ZSET — and
 * nothing about how jobs are executed (that is the worker's job, Phase 2).
 *
 * Two queues, two very different data structures:
 *
 *   LIST  `active`  : RPUSH/LPUSH semantics. Perfect for "run as soon as
 *                     possible, in arrival order". Consumers pop from the
 *                     opposite end, giving FIFO.
 *
 *   ZSET  `delayed` : members kept sorted by a numeric score. We use the
 *                     *timestamp the job may run at* as the score. Redis then
 *                     answers "which jobs are due?" in O(log N) via
 *                     ZRANGEBYSCORE/ZPOPMIN — no scanning, ever.
 */
export class QueueEngine {
  private readonly redis: Redis;
  private readonly keys: QueueKeySet;

  constructor(redis: Redis, keys: QueueKeySet = QUEUE_KEYS) {
    this.redis = redis;
    this.keys = keys;
  }

  /**
   * Validate a producer request and materialise a complete `Job`.
   * `id`, `attempts` and `createdAt` are engine-owned so callers cannot lie
   * about them.
   */
  createJob<TData extends JobData = JobData>(
    input: CreateJobInput<TData>,
  ): Job<TData> {
    const parsed = createJobInputSchema.parse(input);

    return {
      id: createJobId(),
      type: parsed.type,
      data: parsed.data as TData,
      priority: parsed.priority,
      delay: parsed.delay,
      attempts: 0,
      maxAttempts: parsed.maxAttempts,
      createdAt: Date.now(),
    };
  }

  /**
   * Enqueue a single job, routing it by delay:
   *   delay === 0  -> active  (LIST)  — run now
   *   delay  >  0  -> delayed (ZSET)  — run at `createdAt + delay`
   */
  async add<TData extends JobData = JobData>(
    input: CreateJobInput<TData>,
  ): Promise<Job<TData>> {
    const job = this.createJob(input);

    if (job.delay > 0) {
      await this.enqueueDelayed(job);
    } else {
      await this.enqueueInstant(job);
    }

    logger.debug('Job enqueued', {
      id: job.id,
      type: job.type,
      priority: job.priority,
      delay: job.delay,
      target: job.delay > 0 ? this.keys.delayed : this.keys.active,
    });

    return job;
  }

  /**
   * Enqueue many jobs in one round-trip using a pipeline.
   *
   * Why pipeline instead of a loop of awaited calls? Each awaited command is a
   * full network round-trip (~RTT each). A pipeline batches N commands into a
   * single write and reads all replies together — the difference between
   * "1,000 jobs in ~1s" and "1,000 jobs in ~1000×RTT".
   *
   * (Phase 1 verification explicitly pushes 1,000 tasks; this is how we make
   * that fast.)
   */
  async addMany<TData extends JobData = JobData>(
    inputs: ReadonlyArray<CreateJobInput<TData>>,
  ): Promise<Array<Job<TData>>> {
    if (inputs.length === 0) return [];

    const jobs = inputs.map((input) => this.createJob<TData>(input));
    const pipeline = this.redis.pipeline();

    for (const job of jobs) {
      const payload = QueueEngine.serialize(job);
      if (job.delay > 0) {
        // NX: do not overwrite if a member with this exact payload already
        // exists, so a retried enqueue cannot create a duplicate.
        pipeline.zadd(this.keys.delayed, 'NX', job.createdAt + job.delay, payload);
      } else {
        pipeline.lpush(this.keys.active, payload);
      }
    }

    await pipeline.exec();
    logger.debug('Batch enqueued', { count: jobs.length });

    return jobs;
  }

  /**
   * Push an immediate job onto the active LIST.
   *
   * We LPUSH here. Consumers will pop from the *tail* with RPOPLPUSH/BLMOVE,
   * which (a) yields FIFO order and (b) is the building block of the reliable
   * queue pattern: the job is atomically moved to `processing` in one step, so
   * it exists only in one place at a time. See Phase 2.
   */
  async enqueueInstant(job: Job): Promise<void> {
    await this.redis.lpush(this.keys.active, QueueEngine.serialize(job));
  }

  /**
   * Push a delayed job onto the delayed ZSET.
   *
   * Score = absolute run-at time in ms. Using an *absolute* timestamp (rather
   * than a relative delay) means a job's due time is stable regardless of when
   * a worker next looks at the set.
   */
  async enqueueDelayed(job: Job): Promise<void> {
    const runAt = job.createdAt + job.delay;
    await this.redis.zadd(this.keys.delayed, 'NX', runAt, QueueEngine.serialize(job));
  }

  // ---------------------------------------------------------------------------
  // Read helpers — used for verification now and by workers/monitoring later.
  // ---------------------------------------------------------------------------

  /** Non-atomic snapshot of queue depths (good enough for monitoring). */
  async stats(): Promise<QueueStats> {
    const [active, delayed, processing, dead] = await Promise.all([
      this.redis.llen(this.keys.active),
      this.redis.zcard(this.keys.delayed),
      this.redis.llen(this.keys.processing),
      this.redis.llen(this.keys.dead),
    ]);

    return { active, delayed, processing, dead };
  }

  /** Inspect up to `limit` active jobs without removing them. Newest-first. */
  async peekActive(limit = 10): Promise<Job[]> {
    const raw = await this.redis.lrange(this.keys.active, 0, limit - 1);
    return raw.map((entry) => QueueEngine.deserialize(entry));
  }

  /** Inspect up to `limit` delayed jobs, ordered by soonest run-at first. */
  async peekDelayed(limit = 10): Promise<ScheduledJob[]> {
    // With RESP2 (see redis.ts), ZRANGE ... WITHSCORES returns a FLAT array:
    // [member, score, member, score, ...]. (ioredis types `stop` as string.)
    const raw = await this.redis.zrange(
      this.keys.delayed,
      0,
      String(limit - 1),
      'WITHSCORES',
    );

    const result: ScheduledJob[] = [];
    for (let i = 0; i < raw.length; i += 2) {
      const member = raw[i];
      const score = raw[i + 1];
      if (member === undefined || score === undefined) continue;
      result.push({ job: QueueEngine.deserialize(member), runAt: Number(score) });
    }
    return result;
  }

  /**
   * Delete every queue key owned by this engine. Destructive — intended for
   * tests and the demo's `--reset` flag, never for production paths.
   */
  async clear(): Promise<void> {
    const keys = Object.values(this.keys);
    if (keys.length > 0) {
      await this.redis.del(...keys);
    }
  }

  // ---------------------------------------------------------------------------
  // (De)serialisation — keep JSON handling in one place so it can evolve.
  // ---------------------------------------------------------------------------

  static serialize(job: Job): string {
    return JSON.stringify(job);
  }

  static deserialize(raw: string): Job {
    return JSON.parse(raw) as Job;
  }
}
