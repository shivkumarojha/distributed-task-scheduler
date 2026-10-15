import { config } from '../config/env';

/**
 * Central registry of every Redis key this engine touches.
 *
 * Why a dedicated module?
 *  - No magic strings scattered across the codebase (a typo'd key silently
 *    creates a *new* empty queue instead of throwing — the classic Redis bug).
 *  - A single `REDIS_KEY_PREFIX` lets many environments/apps share one Redis
 *    instance without colliding.
 *  - The Phase 2 Lua scripts will reference these exact names via KEYS[].
 *
 * Redis Cluster note: in a cluster, keys touched by one atomic Lua script must
 * hash to the same slot. That is why we'll keep every queue key under one
 * prefix and can later wrap the dynamic part in `{hashtag}` braces if needed.
 */
export interface QueueKeySet {
  /** LIST — immediate jobs, FIFO. */
  readonly active: string;
  /** ZSET — delayed/scheduled jobs, scored by run-at timestamp (ms). */
  readonly delayed: string;
  /** LIST — jobs currently checked out by a worker (Phase 2). */
  readonly processing: string;
  /** LIST — jobs that exhausted their retries (DLQ). */
  readonly dead: string;
  /** String counter — lifetime completed jobs (dashboard metric). */
  readonly completed: string;
  /** String counter — lifetime failed jobs (dashboard metric). */
  readonly failed: string;
  /** Hash — per-job metadata/status by job id (Phase 2+). */
  readonly jobMeta: string;
}

export function buildQueueKeys(prefix: string): QueueKeySet {
  return {
    active: `${prefix}:queue:active`,
    delayed: `${prefix}:queue:delayed`,
    processing: `${prefix}:queue:processing`,
    dead: `${prefix}:queue:dead`,
    completed: `${prefix}:stats:completed`,
    failed: `${prefix}:stats:failed`,
    jobMeta: `${prefix}:job`,
  };
}

/** Keys built from the configured prefix. */
export const QUEUE_KEYS: QueueKeySet = buildQueueKeys(config.REDIS_KEY_PREFIX);
