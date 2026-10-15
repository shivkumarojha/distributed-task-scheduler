import Redis, { type RedisOptions } from 'ioredis';
import { config } from '../config/env';
import { logger } from '../utils/logger';

/** Alias so the rest of the codebase depends on our name, not ioredis'. */
export type RedisClient = Redis;

/**
 * RedisConnectionManager
 * ----------------------
 * Owns the lifecycle of the Redis client: creation, configuration, event
 * logging, health-checking and graceful teardown.
 *
 * Why wrap ioredis at all?
 *  1. A single place decides connection policy (retries, timeouts, pool size).
 *  2. It is a process-wide singleton, so we never accidentally open a fresh TCP
 *     connection per module.
 *  3. Later phases need *more than one* connection (ioredis serialises commands
 *     over one socket; a blocking `BRPOPLPUSH` would starve everything else).
 *     That extra connection will be handed out from right here.
 */
export class RedisConnectionManager {
  private static instance: RedisConnectionManager | undefined;

  private client: Redis | undefined;
  private readonly options: RedisOptions;

  private constructor() {
    this.options = {
      host: config.REDIS_HOST,
      port: config.REDIS_PORT,
      db: config.REDIS_DB,

      // Only include credentials when actually provided (see emptyStringToUndefined).
      ...(config.REDIS_USERNAME ? { username: config.REDIS_USERNAME } : {}),
      ...(config.REDIS_PASSWORD ? { password: config.REDIS_PASSWORD } : {}),

      connectTimeout: config.REDIS_CONNECT_TIMEOUT_MS,
      commandTimeout: config.REDIS_COMMAND_TIMEOUT_MS,

      /*
       * RESP2, pinned on purpose. RESP3 changes the *shape* of several replies
       * (e.g. ZRANGE ... WITHSCORES returns [member, score] tuples instead of a
       * flat string array). Pinning keeps every reply deterministic and lets
       * our Lua scripts reason about exact return types.
       */
      protocol: 2,

      /*
       * maxRetriesPerRequest: null means "never reject a queued command just
       * because the socket is momentarily down" — ioredis will keep retrying.
       * For a job system this is essential: a transient network blip must not
       * silently drop a producer's `LPUSH`. It is ALSO a hard requirement for
       * blocking commands (BRPOPLPUSH/BLMOVE) in later phases.
       */
      maxRetriesPerRequest: null,

      // Verify the server is actually usable (not just TCP-connected) first.
      enableReadyCheck: true,

      // Connect explicitly via connect() rather than in the constructor, so
      // construction stays side-effect free and testable.
      lazyConnect: true,

      // Exponential-ish backoff between reconnection attempts, capped.
      retryStrategy: (attempt) =>
        Math.min(attempt * 100, config.REDIS_MAX_RETRY_DELAY_MS),

      /*
       * On a failover the old primary replies "READONLY". Returning 2 tells
       * ioredis to reconnect AND re-send the failed command against the new
       * primary instead of throwing it away.
       */
      reconnectOnError: (error) =>
        error.message.includes('READONLY') ? 2 : false,
    };
  }

  /** Process-wide singleton accessor. */
  static getInstance(): RedisConnectionManager {
    if (!RedisConnectionManager.instance) {
      RedisConnectionManager.instance = new RedisConnectionManager();
    }
    return RedisConnectionManager.instance;
  }

  /**
   * Create (if needed) and connect the client. Idempotent: calling it twice
   * returns the same connection.
   */
  async connect(): Promise<Redis> {
    if (!this.client) {
      this.client = this.createClient();
    }

    // With lazyConnect, status starts at "wait"; after a quit() it is "end".
    if (this.client.status === 'wait' || this.client.status === 'end') {
      await this.client.connect();
    }

    return this.client;
  }

  /** Get the live client, or fail fast if connect() was never called. */
  getClient(): Redis {
    if (!this.client) {
      throw new Error(
        'Redis client is not initialised. Call RedisConnectionManager.connect() first.',
      );
    }
    return this.client;
  }

  /** Round-trip health check. Returns true only on a "PONG" reply. */
  async ping(): Promise<boolean> {
    const client = await this.connect();
    return (await client.ping()) === 'PONG';
  }

  /** Gracefully close the connection (flushes pending work first). */
  async close(): Promise<void> {
    if (!this.client) return;

    const client = this.client;
    this.client = undefined;

    try {
      // quit() sends QUIT and waits for the server to ack — cleaner than
      // disconnect(), which severs the socket immediately.
      await client.quit();
    } catch {
      // If QUIT fails (socket already gone), make sure we do not leak a handle.
      client.disconnect();
    }
  }

  private createClient(): Redis {
    const client = new Redis(this.options);

    // Observability: connection state transitions are the #1 source of
    // "why is my worker suddenly doing nothing?" in production.
    client.on('connect', () => {
      logger.info('Redis socket connected', {
        host: config.REDIS_HOST,
        port: config.REDIS_PORT,
        db: config.REDIS_DB,
      });
    });

    client.on('ready', () => {
      logger.info('Redis client ready', { status: client.status });
    });

    client.on('error', (error: Error) => {
      logger.error('Redis client error', { message: error.message });
    });

    client.on('close', () => {
      logger.warn('Redis connection closed');
    });

    client.on('reconnecting', (delayMs: number) => {
      logger.warn('Redis reconnecting', { delayMs });
    });

    client.on('end', () => {
      logger.warn('Redis connection ended — no more retries');
    });

    return client;
  }
}
