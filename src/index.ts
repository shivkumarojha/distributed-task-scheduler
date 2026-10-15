import { config } from './config/env';
import { QueueEngine } from './core/QueueEngine';
import { RedisConnectionManager } from './core/redis';
import type { CreateJobInput } from './types/job';
import { logger } from './utils/logger';

/**
 * Phase 1 demo / smoke test.
 *
 * Boots the Redis connection, pushes three representative jobs, then reads the
 * raw Redis state back so you can *see* which data structure each job landed
 * in and in what order.
 *
 * Run:            npm run dev
 * Reset first:    npm run dev -- --reset
 */

/**
 * Three representative jobs. Typed against the base `CreateJobInput` (rather
 * than `as const`) so each job may carry a different payload shape without
 * collapsing into an incompatible union.
 */
const SAMPLE_JOBS: ReadonlyArray<{ label: string; input: CreateJobInput }> = [
  {
    label: '① instant          (delay 0)',
    input: {
      type: 'email:send',
      data: { to: 'alice@example.com', template: 'welcome' },
      priority: 5,
    },
  },
  {
    label: '② high priority    (delay 0, priority 10)',
    input: {
      type: 'payment:capture',
      data: { orderId: 'ord_1001', amount: 4999, currency: 'USD' },
      priority: 10,
    },
  },
  {
    label: '③ delayed          (delay 5000ms)',
    input: {
      type: 'report:generate',
      data: { reportId: 'rpt_2026_10', format: 'pdf' },
      priority: 8,
      delay: 5000,
    },
  },
];

function divider(title: string): void {
  console.log(`\n${'─'.repeat(72)}\n${title}\n${'─'.repeat(72)}`);
}

async function main(): Promise<void> {
  divider('🚀 Distributed Task Scheduler — Phase 1 smoke test');

  const redisManager = RedisConnectionManager.getInstance();
  const redis = await redisManager.connect();

  if (!(await redisManager.ping())) {
    throw new Error('Redis did not reply to PING — is the server running?');
  }

  const engine = new QueueEngine(redis);

  if (process.argv.includes('--reset')) {
    await engine.clear();
    logger.warn('Cleared all queue keys (--reset)');
  }

  const before = await engine.stats();
  console.log('Queue state before:', before);

  // ---- Push the sample jobs -------------------------------------------------
  divider('Pushing 3 sample jobs');

  for (const sample of SAMPLE_JOBS) {
    const job = await engine.add(sample.input);
    console.log(
      `${sample.label}\n` +
        `      id=${job.id}  type=${job.type}  priority=${job.priority}  ` +
        `delay=${job.delay}ms  attempts=${job.attempts}/${job.maxAttempts}`,
    );
  }

  // ---- Inspect what actually landed in Redis --------------------------------
  const after = await engine.stats();

  divider('Redis — active LIST  (FIFO, immediate jobs)');
  const active = await engine.peekActive();
  // peekActive returns newest-first (LPUSH order), so reverse for display.
  [...active].reverse().forEach((job, index) => {
    console.log(
      `  ${index + 1}. id=${job.id}  type=${job.type}  ` +
        `priority=${job.priority}  enqueuedAt=${new Date(job.createdAt).toISOString()}`,
    );
  });

  divider('Redis — delayed ZSET  (ordered by run-at score, ms)');
  const now = Date.now();
  const delayed = await engine.peekDelayed();
  for (const { job, runAt } of delayed) {
    const secondsUntilDue = ((runAt - now) / 1000).toFixed(2);
    console.log(
      `  • id=${job.id}  type=${job.type}  score(runAt)=${runAt}  ` +
        `runs in ${secondsUntilDue}s`,
    );
  }

  divider('Summary');
  console.log('Queue state after :', after);
  console.log(
    `  • active  LIST length : ${after.active}  (2 immediate jobs)\n` +
      `  • delayed ZSET card   : ${after.delayed}  (1 job, due in ~5s)\n` +
      `  • processing / dead   : ${after.processing} / ${after.dead}  (Phase 2/3)`,
  );
  console.log(
    `\n✅ Phase 1 OK — jobs are persisted in Redis under prefix "${config.REDIS_KEY_PREFIX}".`,
  );
  console.log(
    '   Verify by hand:  redis-cli LLEN dts:queue:active\n' +
      '                    redis-cli ZRANGE dts:queue:delayed 0 -1 WITHSCORES\n',
  );
}

/**
 * Minimal, safe entrypoint. Phase 3 will expand this into full graceful
 * shutdown for workers (draining in-flight jobs back to Redis on SIGTERM).
 */
async function bootstrap(): Promise<void> {
  const redisManager = RedisConnectionManager.getInstance();

  const shutdown = async (signal: string): Promise<void> => {
    logger.warn(`Received ${signal}, shutting down…`);
    await redisManager.close();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  try {
    await main();
  } catch (error) {
    logger.error('Fatal error in Phase 1 demo', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    process.exitCode = 1;
  } finally {
    await redisManager.close();
  }
}

void bootstrap();
