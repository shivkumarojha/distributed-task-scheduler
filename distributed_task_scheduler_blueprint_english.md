# Project Blueprint: Distributed Task Scheduler & Event-Driven Engine

> **Goal:** Transition from a basic CRUD developer to a **High-Performance Systems Engineer** within 3 months.
>
> **Tech Stack:** Node.js, TypeScript, Redis, Worker Threads, WebSockets, Next.js, Docker.

## 📌 What is this Project? (High-Level Summary)

This project is a **Distributed Background Task Processing Engine** built from scratch. It works similarly to production systems like **BullMQ, Celery, or AWS SQS**.

When thousands or millions of users trigger heavy operations at the same time (e.g., PDF generation, email blasts, payment processing), the main web server can slow down or crash. This task scheduler offloads those heavy jobs and processes them reliably in the background.

## 🏗️ System Architecture

```
┌─────────────────────────────────────────────────────────┐
│              Next.js Admin Dashboard                    │
│   (Real-time Monitoring & Manual Retry Trigger)         │
└────────────────────────────┬────────────────────────────┘
                             │ (WebSockets / HTTP)
                             ▼
┌─────────────────────────────────────────────────────────┐
│               Producer (Express / NestJS)               │
│   - Receives Task Request                               │
│   - Validates Payload                                   │
└────────────────────────────┬────────────────────────────┘
                             │ (Push Task)
                             ▼
┌─────────────────────────────────────────────────────────┐
│               Redis In-Memory Engine                    │
│   - Waiting Queue (LIST)                                │
│   - Delayed Queue (ZSET - Timestamp scored)             │
│   - Processing Queue (HASH)                             │
│   - Dead Letter Queue (DLQ for Failed Tasks)            │
└────────────────────────────┬────────────────────────────┘
                             │ (Poll / Lua Script Atomic Fetch)
                             ▼
┌─────────────────────────────────────────────────────────┐
│                Worker Cluster (Node.js)                 │
│  ┌──────────────────────┐    ┌──────────────────────┐   │
│  │ Worker Thread 1      │    │ Worker Thread 2      │   │
│  │ (CPU Heavy Tasks)    │    │ (Concurrency Control)│   │
│  └──────────────────────┘    └──────────────────────┘   │
└────────────────────────────┴────────────────────────────┘
```

## 🗓️ Phase-by-Phase Roadmap

---

### 🔹 PHASE 1: Redis In-Memory Engine & Atomic Operations

**Goal:** Move beyond basic database queries and understand high-speed, in-memory data structures and race conditions.

#### 1. What to Build?
* Set up a Redis instance (locally using Docker or remotely using Upstash).
* Build 3 distinct queue types:
  * **Active Queue:** Immediate tasks ready to run (First-In, First-Out).
  * **Delayed Queue:** Scheduled tasks (e.g., "Run this job in 10 minutes").
  * **Failed / Dead Letter Queue (DLQ):** Tasks that crash repeatedly.

#### 2. Core Concepts to Learn Deeply
* **Redis Data Structures:** `LIST` (FIFO queue), `ZSET` (Sorted Sets for priority and time-based scheduling), and `HASH` (storing task status and metadata).
* **Atomicity & Lua Scripts:** Learn how race conditions happen when 10 workers try to fetch the exact same job from Redis at the exact same millisecond. Learn how to write atomic Lua scripts inside Redis to fix this.

#### 3. Expected Outcome
* A standalone TypeScript class that pushes and pops tasks from Redis directly using Lua scripts—without using high-level libraries like BullMQ.

#### 4. How to Verify
* **Test Case:** Run a loop that pushes 1,000 tasks into Redis in under 1 second.
* **Verification:** Verify that all tasks are correctly ordered in Redis `ZSET` and `LIST` based on priority and execution time, with zero duplicate task assignments.

---

### 🔹 PHASE 2: Multi-Threading & Concurrency Control

**Goal:** Break through Node.js "single-threaded" limitations for heavy workloads.

#### 1. What to Build?
* A **Worker Engine** that continuously fetches tasks from Redis and executes them.
* A **Worker Thread Pool** that runs CPU-intensive jobs (e.g., heavy array processing, PDF generating) off the main Event Loop.

#### 2. Core Concepts to Learn Deeply
* **Node.js Event Loop Blocking:** Learn what causes the event loop to freeze and how to prevent it.
* **`worker_threads` Module:** Understand data transfer between the main process and worker threads using `parentPort`, `workerData`, and shared buffers.
* **Concurrency Control & Throttling:** Build logic to limit worker capacity (e.g., max 5 tasks concurrently) so the server never runs out of memory.

#### 3. Expected Outcome
* A resilient worker process that can handle massive CPU computations without freezing the main server or dropping HTTP requests.

#### 4. How to Verify
* **Test Case:** Send 10 tasks containing intensive CPU loops (e.g., 1 billion operations).
* **Verification:** Check CPU usage across multiple cores using system tools (`htop` or Activity Monitor) and confirm the main API Gateway stays responsive.

---

### 🔹 PHASE 3: Resiliency, Retries & Fault Tolerance

**Goal:** Make the backend production-ready by preparing for real-world failures and server crashes.

#### 1. What to Build?
* **Exponential Backoff Retry Engine:** When a task fails, automatically retry it with exponential delays ($2^x$ seconds: 2s, 4s, 8s, 16s...).
* **Dead Letter Queue (DLQ):** After reaching maximum retries (e.g., 3 failed attempts), move the task to a DLQ for manual inspection.
* **Graceful Shutdown Logic:** Handle OS termination signals (`SIGTERM` / `SIGINT`) so that active jobs are safely returned to Redis rather than lost mid-execution during server restarts.

#### 2. Core Concepts to Learn Deeply
* **Fault-Tolerant System Architecture:** Designing systems under the assumption that networks, APIs, and databases *will* fail.
* **Process Signal Handling:** Intercepting operating system signals to clean up resources before process exit.

#### 3. Expected Outcome
* A reliable backend worker that guarantees zero data loss during network glitches, API crashes, or sudden server restarts.

#### 4. How to Verify
* **Test Case 1:** Trigger a long task and kill the worker process using `kill -9 <PID>`.
* **Verification 1:** Upon restarting the worker, the uncompleted task should safely resume or re-queue.
* **Test Case 2:** Intentionally throw errors inside a task handler.
* **Verification 2:** Confirm execution progression: 1st Attempt (2s delay) -> 2nd Attempt (4s delay) -> 3rd Attempt -> Moved to DLQ.

---

### 🔹 PHASE 4: Real-time Dashboard & Monitoring Engine

**Goal:** Build a visual interface to monitor and interact with the background engine.

#### 1. What to Build?
* An admin dashboard using Next.js and Tailwind CSS.
* A WebSockets server (`ws` or `Socket.io`) that streams live metrics from workers to the dashboard.
* **Manual Retry Action:** A UI button to retry failed tasks stored in the Dead Letter Queue.

#### 2. Core Concepts to Learn Deeply
* **Bidirectional Communication:** Managing WebSocket client-server connection lifecycles, heartbeats, and reconnection handling.
* **Metrics Aggregation:** Calculating key system performance metrics like Throughput / Tasks Per Second (TPS).

#### 3. Expected Outcome
* A visual admin panel displaying:
  * 🟢 Completed Tasks Count
  * 🟡 Active Workers
  * 🔴 Dead Letter Queue Items (with a single-click Retry button)

#### 4. How to Verify
* **Test Case:** Push 10,000 tasks in a single batch.
* **Verification:** Watch the dashboard counters, state updates, and throughput graphs update in real-time without refreshing the page.

---

## 🤖 Rules for Using AI (Cursor / Claude)

1. **No Blind Copy-Pasting:** After AI generates a snippet, ask "Why" for every line of code you don't immediately understand.
2. **Prompt Strategy:**
   * *"Explain how this Lua script prevents race conditions in Redis before writing TypeScript code."*
   * *"Why are we using `worker_threads` instead of `child_process` here? What is the memory trade-off?"*
3. **Deep Learning Rule:** Whenever AI introduces an unfamiliar concept (e.g., Memory Leaks, Event Emitters, Mutexes, Locks), pause and ask AI to explain it with simple examples before moving forward.

---

## 🎓 Your Interview Pitch After Completing This Project

When an interviewer asks: *"Tell me about your most complex backend project."*

**Your Answer:**

> "I designed and built a fault-tolerant distributed task processing engine from scratch using TypeScript and Node.js. Instead of relying on existing libraries, I wrote atomic Redis Lua scripts to prevent race conditions across multiple worker processes. I handled CPU-bound tasks using Node.js Worker Threads without blocking the event loop, implemented an Exponential Backoff retry strategy with a Dead Letter Queue, and ensured zero-data-loss through OS signal handling for graceful shutdowns."