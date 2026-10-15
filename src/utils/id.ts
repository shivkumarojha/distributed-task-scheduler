import { randomUUID } from 'node:crypto';

/**
 * Generate a globally-unique job id.
 *
 * Why UUID v4 and not an incrementing counter?
 *  - It can be generated independently by any producer in any process with no
 *    coordination (no extra round-trip to Redis just to get an id).
 *  - Because the id is embedded in the serialised job and used as the ZSET
 *    member, uniqueness guarantees we never accidentally de-duplicate two
 *    genuinely different jobs (ZSET members must be unique).
 *
 * Trade-off: UUIDs are 36 bytes vs. an 8-byte integer. For a job queue that is
 * a negligible cost next to the payload itself.
 */
export function createJobId(): string {
  return randomUUID();
}
