# Project Blueprint: Distributed Task Scheduler & Event-Driven Engine

> **लक्ष्य (Goal):** 3 महीने में साधारण CRUD डेवलपर की इमेज तोड़कर एक **High-Performance Systems Engineer** बनना।  
> **टेक स्टैक (Tech Stack):** Node.js, TypeScript, Redis, Worker Threads, WebSockets, Next.js, Docker.

---

## 📌 प्रोजेक्ट क्या है? (High-Level Summary)
यह प्रोजेक्ट एक ऐसा **Distributed Background Task Processing Engine** है जो बिल्कुल **BullMQ, Celery या AWS SQS** जैसे बड़े सिस्टम्स की तरह काम करता है। 

जब लाखों यूजर्स एक साथ कोई बटन दबाते हैं (जैसे PDF डाउनलोड, ईमेल नोटिफिकेशन, पेमेंट सेटलमेंट), तो मेन वेब सर्वर स्लो न हो, इसके लिए यह टास्क शेड्यूलर उस काम को बैकग्राउंड में संभालता है।

---

## 🏗️ सिस्टम आर्किटेक्चर (System Architecture)



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
└─────────────────────────────────────────────────────────┘
```

---

## 🗓️ Phase-by-Phase Roadmap

---

### 🔹 PHASE 1: Redis In-Memory Engine & Atomic Operations
**लक्ष्य:** डेटाबेस लॉक्स और रेस कंडीशन (Race Conditions) से परे जाकर इन-मेमोरी डेटा स्ट्रक्चर्स को समझना।

#### 1. क्या-क्या बनाना है?
* Redis का सेटअप (Docker या Upstash के ज़रिए)।
* 3 अलग-अलग टाइप की क्वी (Queues):
  * **Active Queue:** तुरंत चलने वाले टास्क।
  * **Delayed Queue:** भविष्य में चलने वाले टास्क (उदा. "10 मिनट बाद चलाओ")।
  * **Failed / Dead Letter Queue (DLQ):** बार-बार क्रैश होने वाले टास्क।

#### 2. क्या-क्या गहराइयों में सीखना है? (Core Learning)
* **Redis Data Structures:** `LIST` (FIFO Queue), `ZSET` (Sorted Sets - प्रियोरिटी और टाइम-बेस्ड सॉर्टिंग के लिए), और `HASH` (टास्क की स्थिति स्टोर करने के लिए)।
* **Atomicity & Lua Scripts:** जब 10 वर्कर्स एक साथ Redis से टास्क मांगेंगे, तो एक ही टास्क दो वर्कर्स के पास न चला जाए (Race Condition)। इसे रोकने के लिए Redis में Lua Script कैसे चलती है।

#### 3. Expected Outcome (आउटपुट)
* एक TypeScript क्लास जो बिना किसी थर्ड-पार्टी लाइब्रेरी (जैसे BullMQ) के सीधे Redis commands और Lua Script का यूज़ करके टास्क पुश और पॉप करे।

#### 4. How to Verify (जाँच कैसे करें?)
* **Test Case:** एक लूप चलाकर 1,000 टास्क 1 सेकंड में Redis में पुश करें।
* **Verification:** चेक करें कि Redis ZSET और LIST में सारे टास्क सही प्रियोरिटी और टाइम-स्टैम्प के साथ अरेंज हुए या नहीं। कोई डुप्लिकेट टास्क न बने।

---

### 🔹 PHASE 2: Multi-Threading & Concurrency Control
**लक्ष्य:** Node.js के "Single-Threaded" होने की सीमा (Limits) को तोड़ना।

#### 1. क्या-क्या बनाना है?
* एक **Worker Engine** जो Redis से टास्क उठाए और उन्हें निष्पादित (Execute) करे।
* एक **Worker Thread Pool** जो CPU-heavy काम (जैसे Heavy Data Processing, PDF Generation) को मेन इवेंट लूप से अलग थ्रेड पर चलाए।

#### 2. क्या-क्या गहराइयों में सीखना है? (Core Learning)
* **Node.js Event Loop & Blocking:** इवेंट लूप कब अटकेगा और उसे कैसे बचाएं।
* **`worker_threads` Module:** `parentPort`, `workerData`, और `Worker` थ्रेड्स के बीच डेटा ट्रांसफर कैसे होता है।
* **Concurrency Limiting:** अगर सर्वर की क्षमता 5 टास्क एक साथ संभालने की है, तो छठा टास्क वेटिंग रूम में रहे—यह Throttling लॉजिक बनाना।

#### 3. Expected Outcome (आउटपुट)
* एक ऐसा वर्कर प्रोसेस जो भारी डेटा प्रोसेस करते वक्त भी सर्वर को 100% CPU क्रैश से बचाए और रेस्पॉन्सिव रखे।

#### 4. How to Verify (जाँच कैसे करें?)
* **Test Case:** 10 ऐसे टास्क भेजें जिनमें भारी लूप (`for` loop with 1 billion iterations) हो।
* **Verification:** चेक करें कि आपके कंप्यूटर के CPU के अलग-अलग Cores यूज़ हो रहे हैं और आपका API Gateway क्रैश नहीं हुआ।

---

### 🔹 PHASE 3: Resiliency, Retries & Fault Tolerance
**लक्ष्य:** वास्तविक दुनिया में आने वाली गलतियों और क्रैश से बैकएंड को सुरक्षित बनाना।

#### 1. क्या-क्या बनाना है?
* **Exponential Backoff Retry Engine:** अगर टास्क फेल हो, तो तुरंत रीट्राई न करके समय बढ़ाकर रीट्राई करे ($2^x$ सेकन्स: 2s, 4s, 8s, 16s...)।
* **Dead Letter Queue (DLQ):** मैक्सिमम रीट्राई (उदा. 3 बार) के बाद टास्क को ऑटोमैटिकली "Dead" घोषित करके अलग क्वी में सेव करना।
* **Graceful Shutdown Logic:** सर्वर रीस्टार्ट या बंद होने पर जो टास्क आधा चला है, वह गायब न हो; उसे सेफली वापस Redis में पुश किया जाए (`SIGTERM` / `SIGINT` handling)।

#### 2. क्या-क्या गहराइयों में सीखना है? (Core Learning)
* **Fault Tolerance Architecture:** सिस्टम कभी 100% परफेक्ट नहीं होता, गलतियाँ संभालना ही असली सिस्टम डिज़ाइन है।
* **Process Signal Handling:** OS जब प्रोसेस बंद करता है तो Node.js में उस इवेंट को कैच करना।

#### 3. Expected Outcome (आउटपुट)
* एक ऐसा बुलेटप्रूफ वर्कर जो इंटरनेट बंद होने या API क्रैश होने पर भी डेटा का नुकसान न होने दे।

#### 4. How to Verify (जाँच कैसे करें?)
* **Test Case 1:** टास्क चलते समय वर्कर प्रोसेस की `PID` निकालकर `kill -9` से अचानक बंद कर दें।
* **Verification 1:** दोबारा सर्वर चालू करने पर अधूरा टास्क फिर से निष्पादित (Execute) होना चाहिए।
* **Test Case 2:** जानबूझकर टास्क में Error थ्रो करें।
* **Verification 2:** टास्क 1st Attempt (2s delay) -> 2nd Attempt (4s delay) -> 3rd Attempt -> Move to DLQ जाना चाहिए।

---

### 🔹 PHASE 4: Real-time Dashboard & Monitoring Engine
**लक्ष्य:** बैकएंड की अदृश्य (Invisible) प्रोसेसिंग को विज़ुअलाइज़ करना।

#### 1. क्या-क्या बनाना है?
* Next.js और Tailwind CSS में डैशबोर्ड UI।
* WebSockets (Socket.io या `ws`) सर्वर जो वर्कर के स्टेटस को रियल-टाइम में फ्रंटएंड पर स्ट्रीम करे।
* **Manual Trigger UI:** DLQ से फेल हुए टास्क को एक क्लिक से दोबारा री-रन करने का बटन।

#### 2. क्या-क्या गहराइयों में सीखना है? (Core Learning)
* **Bidirectional Communication:** WebSockets कनेक्शन लाइफसाइकिल, रीकनेक्शन लॉजिक।
* **Metrics Aggregation:** प्रति सेकंड कितने टास्क पूरे हो रहे हैं (Throughput/TPS) की गणना करना।

#### 3. Expected Outcome (आउटपुट)
* एक सुंदर डैशबोर्ड जहाँ आपको लाइव दिखता रहे:
  * 🟢 Completed Tasks Count
  * 🟡 Active Workers
  * 🔴 Dead Letter Queue Items (With Retry Button)

#### 4. How to Verify (जाँच कैसे करें?)
* **Test Case:** 10,000 टास्क बैच में पुश करें।
* **Verification:** डैशबोर्ड पर बिना पेज रिफ्रेश किए ग्राफ्स और काउंटर्स लाइव बदलते दिखने चाहिए।

---

## 🤖 AI (Cursor / Claude) का सही उपयोग कैसे करें? (Rules of Engagement)

1. **सीधे कॉपी-पेस्ट मना है:** AI से कोड लिखवाने के बाद हर लाइन का "Why" पूछें।
2. **प्रॉम्प्ट पैटर्न:**
   * *"Explain how this Lua script prevents race condition in Redis before writing TypeScript code."*
   * *"Why did we use `worker_threads` instead of `child_process` here? What is the memory difference?"*
3. **गहराई से समझें:** अगर AI कोई नया टर्म बोले (जैसे Memory Leaks, Event Emitters, Mutex), तो तुरंत रोककर उससे उसका मतलब पूछें।

---

## 🎓 इस प्रोजेक्ट के बाद आपका इंटरव्यू पिच (Interview Pitch)

जब आपसे पूछा जाएगा: *"Tell me about your most complex backend project."*

**आपका जवाब होगा:**
> "I designed and built a fault-tolerant distributed task processing engine from scratch in TypeScript and Node.js. Instead of relying on high-level libraries, I implemented atomic operations using Redis Lua scripts to prevent race conditions across multiple workers. I handled CPU-bound tasks using Node.js Worker Threads without blocking the event loop, built an Exponential Backoff retry strategy with a Dead Letter Queue, and ensured zero-data-loss through OS signal handling for graceful shutdowns."

---
*चलिए दोस्त, Phase 1 से शुरुआत करते हैं!*
