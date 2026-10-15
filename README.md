# Distributed Task Scheduler & Event-Driven Engine

A production-grade, fault-tolerant background **task processing engine** built
from scratch with **Node.js + TypeScript + Redis** — no BullMQ, no Celery. It
exists to learn the systems fundamentals (concurrency, race conditions, worker
pools, memory efficiency) by implementing them directly.

> Status: **Phase 1 — Redis In-Memory Engine & Atomic Operations** ✅

📚 **New to this?** Read [`docs/phase-1-learning.md`](docs/phase-1-learning.md) —
a plain-English, no-jargon walkthrough of every Phase 1 concept (LIST vs ZSET,
persistence, pipelining, race conditions, and more).

---

## Phase 1 at a glance

| Concern | Decision |
| --- | --- |
| Immediate jobs | Redis **LIST** (`dts:queue:active`) — FIFO |
| Delayed jobs | Redis **ZSET** (`dts:queue:delayed`) — scored by run-at **timestamp (ms)** |
| Producers push | `LPUSH` (active) / `ZADD NX` (delayed) |
| Throughput | **~21,000 jobs/s** (1,000 jobs in ~47 ms via a pipeline) |
| Durability | State lives in Redis; AOF (`appendfsync everysec`) survives server restarts |
| Validation | **zod** at the producer boundary, strict TypeScript everywhere |

### Why ZSET for delayed jobs (and not a LIST)

A `LIST` is *positional* — you can push/pop ends but Redis cannot answer "which
job is due now?". A `ZSET` keeps members sorted by a numeric **score** (a skip
list), so `ZRANGEBYSCORE` / `ZPOPMIN` return exactly the due jobs in order, in
`O(log N)`. Scheduling is a "sort by time" problem, therefore `ZSET`. Priority
is the same idea with a different number, and is layered on in the atomic-fetch
work that follows.

### Why jobs survive a Node.js restart

Two independent layers:

1. **Decoupling** — queue state lives in the Redis *server*, not the Node
   process. Any new Node process reconnects and sees the same `LIST`/`ZSET`.
2. **Redis durability** — `appendonly yes` + `appendfsync everysec` (see
   `docker-compose.yml`) replays every write on restart.

Both were verified locally: a fresh Node process *and* a restarted Redis both
restored all queued jobs.

---

## Project structure

```
src/
├── config/
│   └── env.ts              # zod-validated, frozen environment config
├── core/
│   ├── keys.ts             # single source of truth for Redis key names
│   ├── redis.ts            # RedisConnectionManager (ioredis, lifecycle + health)
│   └── QueueEngine.ts      # producer API: add / addMany, LIST + ZSET routing
├── types/
│   └── job.ts              # Job interface + CreateJobInput + priority constants
├── utils/
│   ├── id.ts               # UUID v4 job ids
│   └── logger.ts           # tiny structured (JSON-per-line) logger
├── scripts/
│   └── benchmark-push.ts   # Phase 1 verification harness (npm run bench)
└── index.ts                # runnable smoke-test demo
```

## Prerequisites

Redis 7+ (or 8). Any of:

```bash
# Option A — Docker (uses the bundled docker-compose.yml, AOF enabled)
docker compose up -d

# Option B — local install
sudo apt-get install -y redis-server && redis-server

# Option C — a managed server (Upstash, Redis Cloud, …): set the env vars below
```

Configuration is optional — sensible defaults are built in. To customise, copy
`.env.example` to `.env`.

## Commands

```bash
npm install          # install dependencies
npm run dev          # run the Phase 1 demo (add -- --reset to wipe first)
npm run bench        # push 1,000 jobs and assert ordering/throughput
npm run typecheck    # strict type-check, no emit
npm run build        # compile to dist/
npm start            # run the compiled demo
```

## Verification (Phase 1 acceptance)

```
$ npm run bench
Pushing 1000 jobs (700 instant, ~300 delayed)…
  ⏱  pushed in 47.2 ms  (21180 jobs/s, target < 1000 ms)
  📦 active LIST = 700, delayed ZSET = 300
✅ All Phase 1 assertions passed.
```

Inspect the raw state yourself:

```bash
redis-cli TYPE  dts:queue:active     # -> list
redis-cli TYPE  dts:queue:delayed    # -> zset
redis-cli LLEN  dts:queue:active
redis-cli ZRANGE dts:queue:delayed 0 -1 WITHSCORES   # ordered by run-at
```

## Toolchain notes

- **TypeScript 5.9.x** is pinned. TypeScript **7** (the native/Go compiler) is
  incompatible with `ts-node` 10.x, which this project uses as its dev runner.
  To move to TS7 later, switch the runner to `tsx` (or Node's built-in type
  stripping) and use `tsc` for type-checking.
- `src/core/redis.ts` pins **RESP2** so reply shapes are deterministic (e.g.
  `ZRANGE ... WITHSCORES` returns a flat array, not RESP3 tuples).
- `nodemon` (dev-only, used by `dev:watch`) pulls in an older `chokidar/braces`
  with a known advisory; it never ships to runtime. Swap to `tsx watch` or
  `node --watch` to drop it.

## Roadmap

- [x] **Phase 1** — Redis engine: LIST/ZSET, persistence, relaxed verification
- [ ] **Phase 2** — Worker engine, atomic Lua fetch, `worker_threads` pool, concurrency limits
- [ ] **Phase 3** — Exponential backoff retries, DLQ, graceful shutdown (`SIGTERM`/`SIGINT`)
- [ ] **Phase 4** — Next.js dashboard + WebSockets live metrics & manual retry
