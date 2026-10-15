import { QueueEngine } from '../core/QueueEngine';
import { RedisConnectionManager } from '../core/redis';
import type { CreateJobInput } from '../types/job';

/**
 * Phase 1 verification harness.
 *
 * The blueprint's acceptance test for Phase 1 is:
 *   "Push 1,000 tasks and verify they are correctly ordered in the LIST/ZSET
 *    by priority and execution time, with zero duplicate task assignments."
 *
 * This script measures how long the push takes (target: < 1s using a pipeline)
 * and then asserts ordering + uniqueness by reading the data straight back.
 *
 * Run:  npm run bench
 */

const TOTAL = 1000;
const DELAYED_COUNT = 300; // ~30% scheduled, rest immediate

async function main(): Promise<void> {
  const redisManager = RedisConnectionManager.getInstance();
  const redis = await redisManager.connect();
  const engine = new QueueEngine(redis);

  // Start from a clean slate so counts are meaningful.
  await engine.clear();

  // Build the batch: 700 immediate + 300 delayed, with varying priorities.
  const inputs: CreateJobInput[] = [];
  for (let i = 0; i < TOTAL; i += 1) {
    const isDelayed = i % 10 < 3; // spread delayed jobs across the batch
    inputs.push({
      type: isDelayed ? 'report:generate' : 'email:send',
      data: { seq: i },
      priority: (i % 10) + 1, // 1..10
      ...(isDelayed ? { delay: 1000 + (i % 60) * 1000 } : {}),
    });
  }

  console.log(`Pushing ${TOTAL} jobs (${TOTAL - DELAYED_COUNT} instant, ~${DELAYED_COUNT} delayed)…`);

  const startedAt = process.hrtime.bigint();
  await engine.addMany(inputs);
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

  const stats = await engine.stats();
  const throughput = Math.round((TOTAL / elapsedMs) * 1000);

  console.log(
    `\n  ⏱  pushed in ${elapsedMs.toFixed(1)} ms  ` +
      `(${throughput} jobs/s, target < 1000 ms)`,
  );
  console.log(`  📦 active LIST = ${stats.active}, delayed ZSET = ${stats.delayed}`);

  // ---- Assertion 1: nothing lost -------------------------------------------
  const stored = stats.active + stats.delayed;
  assert(stored === TOTAL, `expected ${TOTAL} jobs stored, found ${stored}`);

  // ---- Assertion 2: ZSET is ordered by run-at (non-decreasing) --------------
  const delayed = await engine.peekDelayed(TOTAL);
  let ordered = true;
  for (let i = 1; i < delayed.length; i += 1) {
    const prev = delayed[i - 1];
    const curr = delayed[i];
    if (prev === undefined || curr === undefined || curr.runAt < prev.runAt) {
      ordered = false;
      break;
    }
  }
  assert(ordered, 'delayed ZSET is not ordered by run-at score');

  // ---- Assertion 3: zero duplicate job ids ---------------------------------
  const ids = new Set<string>();
  for (const { job } of delayed) ids.add(job.id);
  const active = await engine.peekActive(TOTAL);
  for (const job of active) ids.add(job.id);
  assert(ids.size === TOTAL, `duplicate ids detected: ${TOTAL - ids.size} collisions`);

  // ---- Assertion 4: timing target ------------------------------------------
  assert(elapsedMs < 1000, `push took ${elapsedMs.toFixed(1)} ms (target < 1000 ms)`);

  console.log('\n✅ All Phase 1 assertions passed.');

  await redisManager.close();
}

function assert(condition: boolean, message: string): void {
  if (!condition) {
    console.error(`\n❌ FAILED: ${message}`);
    process.exit(1);
  }
}

void main().catch((error: unknown) => {
  console.error('Benchmark crashed:', error);
  process.exit(1);
});
