# Phase 1 in Plain English — Learning Notes

*A no-jargon walkthrough of everything we built in Phase 1, written so you can
read it on a coffee break and actually get it. Read top to bottom.*

---

## 0. What are we even building?

Imagine a busy restaurant.

- A **customer** walks in = a user on your website clicking "Generate my PDF".
- The **waiter taking the order** = your web server (we call it the **Producer**).
- The **kitchen ticket rail** (where order slips get pinned) = **Redis**.
- The **cooks** = the **Workers** (we build these in Phase 2).
- One **order slip** = one **Job**.

Here is the whole idea in one line: **the waiter does not cook.**

If the waiter tried to cook every order himself, then the moment 1,000 people
order at once, he'd be stuck in the kitchen and nobody could place a new order.
The website would freeze. So instead, the waiter just writes the order on a slip,
pins it to the rail, and is instantly free again to take the next order. The cooks
(workers) pick up slips at their own pace.

That is a **background task processing engine**. We're building the ticket rail
and the rules around it. (Real-world versions of this: BullMQ, Celery, AWS SQS.)

---

## 1. What is Redis?

Redis is a program that keeps data in **memory (RAM)** instead of on a hard disk.
Reading from RAM is dramatically faster than reading from a disk, so Redis is
*very* fast. That's why it's perfect for a waiting line of tasks.

Think of Redis as a giant labelled shelf:

- You put something on the shelf under a **name** (we call the name a **key**).
- You take it back out later using that name.

Example keys we use:

- `dts:queue:active`
- `dts:queue:delayed`

But here's the important part: the thing you put on the shelf isn't just a blob.
Redis lets you choose a **type**, and the type changes what the shelf can do.
We used two types: a **LIST** and a **ZSET**.

> ⚠️ Big idea: Redis is a **separate program running in its own process**. Your
> Node app talks to it over a network connection, like a phone call. Remember
> this — it's the entire reason our jobs survive when Node crashes.

---

## 2. The two data structures we used

### LIST — "the line of people at a counter"

A LIST is simply an **ordered line of items**. You can add an item to the front
or the back, and remove from the front or the back. That's it.

Think of a line of people at a coffee counter. The person who joined first gets
served first. That's **FIFO** — *First In, First Out*.

We use a LIST for **instant jobs** — jobs that should run as soon as possible.

Useful commands (front = left, back = right):

| Command | Plain English |
| --- | --- |
| `LPUSH key item` | Add item to the **front** of the line |
| `RPUSH key item` | Add item to the **back** of the line |
| `LPOP key` | Take the **front** item out |
| `RPOP key` | Take the **back** item out |
| `LLEN key` | How many items are in the line? |

We add with `LPUSH`. Later, the workers will take from the other end. Add at one
end, take from the other end = a fair, first-come-first-served line.

### ZSET — "the calendar with a time on every page"

A ZSET ("sorted set") is a collection where **every item has a number attached to
it**, and Redis **automatically keeps them sorted by that number**, smallest
first. Always. You never have to sort it yourself.

The attached number is called the **score**.

Two ways to picture it:

1. **A leaderboard.** Every player has a score, and Redis always knows who is
   #1 and #2 without you doing anything.
2. **A planner/calendar.** Every task has a *time* written on it, and the
   calendar is always in time order. So "what is the very next thing to do?" is
   instant to answer.

The score can be **any number**. We chose to use *the moment the job is allowed
to run*, written as a huge number (milliseconds since 1 Jan 1970, e.g.
`1792062046817`).

So our delayed queue is literally a **calendar sorted by run-time**. Beautiful.

Useful commands:

| Command | Plain English |
| --- | --- |
| `ZADD key score item` | Add an item with a score (Redis re-sorts automatically) |
| `ZRANGE key 0 -1` | List items from smallest score to largest |
| `ZRANGE key 0 -1 WITHSCORES` | Same, but also show the scores |
| `ZCARD key` | How many items are in the set? |
| `ZRANGEBYSCORE key min max` | Give me everything with a score between min and max |
| `ZPOPMIN key` | Take out the item with the **smallest** score |

---

## 3. THE big question: why ZSET for delayed jobs, and LIST for instant ones?

This is the concept most people trip on. Let's go slow.

**Picture a pile of papers vs a planner.**

- A **LIST is a pile of papers**. You know the pile's order, but there are **no
  times written on the papers**. So if you ask "which paper is due right now?",
  you would have to pick up and read *every single paper*. Slow. And worse — if
  10 cooks each dig through the pile, several of them will grab the *same* paper.
  Chaos.

- A **ZSET is a planner where every page has a time on it**, and the planner is
  **always kept sorted by time for you**. Now you can ask, in one shout: "give me
  everything due before *now*", and it hands them to you instantly, already in
  order. You can even ask for just the single earliest one.

The deep reason: **"What should run next?" is a sorting question.** And sorting
by a number is exactly what a ZSET is built to do.

Bonus facts:

- Every item in a ZSET must be **unique**. Since we stamp each job with a unique
  id and store it inside, we can't accidentally create duplicates.
- **Priority is also just a number.** Did you notice? Priority (1–10) is the same
  kind of idea as a time-score. That's a hint: in Phase 2 we'll sort by priority
  using this very same trick.

---

## 4. "What if Node restarts? What if Redis restarts?" — Persistence

These are **two completely different questions**. Beginners mix them up. Let's
separate them.

### Case A — Node.js restarts (crash, redeploy, whatever)

**Nothing is lost.** Why? Because the jobs were *never inside Node*. Node only
handed them to Redis. Redis is still holding them. A brand-new Node process
reconnects and sees the exact same jobs.

**Analogy:** the waiter quitting does **not** lose your order, because the order
slip is pinned to the kitchen rail — not in the waiter's pocket.

*We proved this for real:* we started a completely fresh Node process, and it still
saw all 1,000 jobs from the previous process.

### Case B — Redis itself restarts (the Redis program stops and starts again)

Now it depends on Redis's **persistence settings** — does Redis write what's in
its memory to disk, so it can reload it after restarting?

Redis has two ways to save to disk:

- **RDB (snapshot):** every so often, Redis takes a *photo* of everything in
  memory and saves one file. Fast and small — but if it crashes between photos,
  you lose everything that happened since the last photo. *Like saving your Word
  document only every 5 minutes: a crash can lose 5 minutes of typing.*

- **AOF (Append-Only File):** Redis writes down **every single change** as it
  happens, like a shopkeeper keeping a running ledger. On restart, it replays the
  ledger. Much safer. With `appendfsync everysec`, you lose at most about **1
  second** of writes. *Like auto-save on every keystroke.*

We turned AOF **on** (`appendonly yes`). And we proved it: we shut Redis down
completely and started it again — all 1,000+ jobs came back.

> Key lesson: "in-memory" does **not** automatically mean "gone on restart". But
> **default** Redis may lose data, so in production you must configure persistence
> on purpose.

---

## 5. Pipelining — why 1,000 jobs took 47 milliseconds

Every time you talk to Redis over the network, there's a small delay per message
— like posting a letter. Even fast mail takes *some* time to arrive and for the
reply to come back.

If you send 1,000 jobs **one at a time, waiting for each reply**, that's 1,000
round trips. Slow and wasteful.

A **pipeline** means: put all 1,000 jobs into **one envelope** and send it once.
Redis processes the whole batch and sends back one reply. Massively faster.

**Analogy:** instead of making 1,000 separate trips to the post office (walk
there, hand over one letter, walk back, repeat), you bundle all the letters and
make **one trip**.

We did this in the `addMany()` method, and it gave us ~21,000 jobs per second.

Trade-off: a pipeline holds more in memory while batching, and it's one big
envelope. For bulk inserts, that's the right trade.

---

## 6. The Redis connection (ioredis) and why we wrapped it

Node talks to Redis through a library called **ioredis**. It opens a network
"pipe" between Node and Redis.

A few decisions worth understanding:

- **Why a "connection manager" class?** So the whole app creates and configures
  the connection in **one place**, instead of every file opening its own pipe.
  Also because later we'll need a **second** pipe: some Redis commands *wait*
  (block) — like "give me the next job, and sit there until one shows up" — and a
  waiting command would freeze every other command sharing the same pipe. Like
  one person hogging a phone line.

- **Auto-reconnect (`retryStrategy`):** networks blink. If the connection drops,
  we want it to reconnect and keep retrying automatically, not crash. The retry
  strategy just decides how long to wait between attempts.

- **`maxRetriesPerRequest: null`:** this means *"if the connection is briefly
  down, don't give up on my queued command — hold it and send it when we're
  back."* Important so we never silently drop a user's job. It's also **required**
  later for the blocking commands above.

- **`lazyConnect: true`:** don't connect the instant we create the object; connect
  when we explicitly say so. Cleaner and more predictable (especially for tests).

- **RESP2 vs RESP3:** these are just two "dialects" Redis can speak. We pinned
  the older, simpler one (RESP2) so the *shape* of replies is always predictable
  — some commands reply slightly differently in RESP3, and predictable is better
  than clever.

---

## 7. Cleaning input with zod — the bouncer at the door

**zod** is a small library that checks data against a **rulebook**.

The rule we live by: **bad data is worse inside the queue than at the door**,
because a worker later has to deal with it — possibly at 3am. So we check a job
(did you give a `type`? is `priority` between 1 and 10? is `delay` a real
number?) *before* it ever reaches Redis.

**Analogy:** a nightclub bouncer checking IDs. It's far easier to turn someone
away at the door than to deal with trouble inside.

zod also lets us fill in **defaults**: if you don't specify a priority, we assume
5. If you don't set `maxAttempts`, we assume 3.

---

## 8. TypeScript "strict mode" — why be so picky?

TypeScript adds **types** to JavaScript (labels describing what kind of data
something is). "Strict mode" keeps all the extra safety checks **on**.

**Analogy:** a spell-checker that refuses to let typos through. Annoying at
first, wonderful later.

We turned on even *more* checks, like `noUncheckedIndexedAccess`, which forces
you to think about "what if this list slot is empty?" — a question that, ignored,
crashes servers in production. The whole point of this project is to write
bulletproof code, so strictness is a feature, not a nuisance.

---

## 9. UUIDs — why long random ids instead of 1, 2, 3?

A UUID looks like `8ee74602-d5d8-4a0b-8282-7e97cb46dec6` — a long random string
that is practically guaranteed to be unique anywhere on Earth.

Why not simple numbers `1, 2, 3`?

- If two different servers both create ids, they'd both say "1" and **collide**.
  With plain numbers you'd need a central counting machine (extra work, and a
  bottleneck everyone queues behind).
- A UUID can be created **anywhere, by anyone, with zero coordination**.
- ZSET items must be **unique**, so a unique id protects us from accidental
  duplicate jobs.

Cost: it's longer (a few more bytes). For a job queue, that's a fine trade.

---

## 10. Key naming (namespaces) — the label maker

Every key we create starts with a prefix, like `dts:` →

```
dts:queue:active
dts:queue:delayed
```

Why? Because you might share one Redis with other programs, or run a "test"
version and a "live" version side by side. The prefix keeps them from bumping
into each other.

**Analogy:** labelling your food in a shared office fridge so it doesn't get
mixed up with everyone else's.

We also keep **all key names in one file** (`src/core/keys.ts`). Why? Because a
typo'd key in Redis doesn't throw an error — it silently creates a *brand-new,
empty* queue. That's a nasty, confusing bug. One file = no scattered typos.

---

## 11. Structured logging — one tidy line per event

Instead of printing `oops something broke`, we print:

```json
{"ts":"2026-10-15T11:00:41.807Z","level":"info","msg":"Redis client ready","meta":{"status":"ready"}}
```

Why? Because later a **machine** (a log system, or our Phase 4 dashboard) can
read, filter, and search these lines easily. Humans can still read them too. And
we tuck useful details (host, port) into a separate `meta` field instead of
mushing them into the sentence.

---

## 12. The full life of a job (Phase 1), step by step

1. A producer calls `engine.add({ ... })`.
2. The engine checks the data with **zod** and fills in defaults.
3. The engine stamps it with a unique **id** and the current time.
4. **Routing:** if `delay` is `0` → push onto the **active LIST**.
   If `delay` is greater than `0` → put it in the **delayed ZSET**, with score =
   *(now + delay)* — its "run at this exact time" bookmark.
5. The producer gets the finished job back (so it can show the user a job id).
6. The job now sits safely in Redis, waiting for a worker (Phase 2).
7. We can peek at it any time with the read helpers, or straight from `redis-cli`.

---

## 13. A sneak peek at the danger: race conditions (Phase 2 preview)

Here's a scary problem we have **not** solved yet — on purpose:

If 10 workers each run "grab the next job" at the same instant, **two workers
might grab the same job**. Your customer then gets **two** emails.

This is called a **race condition** — a bug caused purely by *timing*, where two
operations "race" and the result depends on who wins.

The Phase 2 fix is to make "grab a job" **atomic** — one indivisible step that
nobody else can interrupt. Redis can run several commands as one unbreakable step
using a **Lua script**.

**Analogy:** a bathroom door lock. Either you're inside with the door locked, or
you're outside — there's no halfway.

Why mention it now? Because it explains a choice we *already* made: we `LPUSH`
now, and plan to **move** jobs with `RPOPLPUSH`/`BLMOVE` later. A "move" (from
*waiting* to *in-progress*) can be **one atomic step**, whereas a
"pop, then separately record" has a tiny gap where a crash loses the job.
Atomics are how we close those gaps.

---

## 14. Vocabulary cheat sheet

- **Job / Task** — one unit of work (send an email, build a PDF).
- **Producer** — code that *creates* jobs.
- **Worker / Consumer** — code that *runs* jobs.
- **Queue** — a waiting line of jobs.
- **In-memory** — stored in RAM; super fast; lost on restart unless persisted.
- **Persistence** — saving to disk so data survives restarts.
- **RDB / AOF** — Redis's two ways of saving to disk (photo vs ledger).
- **FIFO** — First In, First Out.
- **Score** — the number attached to a ZSET item that decides its order.
- **Atomic** — happens all-or-nothing; cannot be interrupted halfway.
- **Race condition** — a bug caused by two operations happening at the same time.
- **Blocking command** — a Redis command that *waits* (e.g. "give me the next job,
  and wait until one appears").
- **Pipeline** — batching many commands into one network trip.
- **Namespace / prefix** — a label that keeps your keys separate from others.
- **Idempotent** — doing it twice has the same effect as doing it once (crucial
  for safe retries).

---

## 15. Try it yourself (fun experiments)

Start Redis, run `npm run dev`, then in another terminal poke at Redis directly:

```bash
redis-cli TYPE  dts:queue:active       # -> list
redis-cli TYPE  dts:queue:delayed      # -> zset
redis-cli LLEN  dts:queue:active       # how many instant jobs
redis-cli ZRANGE dts:queue:delayed 0 -1 WITHSCORES   # delayed jobs, in time order

# Play with the auto-sorting yourself:
redis-cli ZADD demo 100 alice
redis-cli ZADD demo 50  bob
redis-cli ZRANGE demo 0 -1 WITHSCORES   # notice bob before alice — sorted by score!
```

Next, experiment with priorities and delays:

```bash
npm run dev -- --reset        # clean slate + 3 sample jobs
npm run bench                 # push 1000 jobs, time it, check ordering
```

Then look at which key each job landed in, and confirm the ZSET is in time order.

---

## 16. Self-check questions (answer them in your head)

1. Why can't a LIST tell you which delayed job is *due* next?
2. In our ZSET, what number do we use as the **score**, and why that number?
3. If Node crashes right after `add()`, is the job lost? Why or why not?
4. If **Redis** restarts, will the job survive? Which setting makes it survive?
5. What's the difference between **RDB** and **AOF**?
6. Why is a **pipeline** faster than a loop of `await`s?
7. Why do we run input through **zod** before writing to Redis?
8. Why **UUIDs** instead of `1, 2, 3`?
9. What is a **race condition**, and what does **atomic** mean?
10. Why does `maxRetriesPerRequest: null` matter for a job system?

*(If you can answer all ten, you understand Phase 1. Answers live in the sections
above.)*

---

## 17. Phase 1 in one paragraph

Redis is a super-fast in-memory store that keeps our jobs safe **outside** of
Node. We use a **LIST** (a simple waiting line) for jobs that should run now, and
a **ZSET** (an auto-sorted calendar) for jobs that should run later — because
"what runs next?" is a *sorting-by-time* question, and ZSETs are built for
sorting. Jobs survive a **Node** restart because they live in Redis, and they
survive a **Redis** restart when **AOF** persistence is switched on. We batch
inserts with **pipelines** for speed, guard the door with **zod**, and keep
everything **strictly typed**. Phase 2 faces the real hard part: making workers
grab jobs **atomically**, so two workers never take the same job.
