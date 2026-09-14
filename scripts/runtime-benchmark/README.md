# Ten-user runtime comparison

Tracks [#385](https://github.com/mia-riezebos/Caelestis/issues/385), with code and findings in PR #351.

Run from the repository root on Linux with Docker, cgroup v2 and `taskset` available:

```sh
pnpm --filter @caelestis/backend... build
NODE_BINARY=/absolute/path/to/node BUN_BINARY=/absolute/path/to/bun \
  taskset -c 0,1 node scripts/runtime-benchmark/run.mjs
```

Use the Node version pinned in the Dockerfile. The driver records both runtime versions, CPU affinity, application commit, benchmark source hashes, trace hash and fixture hashes. Override CPU assignments on machines with fewer than six available logical CPUs. `run.mjs` lists the available environment overrides.

The default run takes about 15 minutes. Each of three repetitions rotates the order of Node, Bun with the existing Node adapter, and Bun with native HTTP/WebSockets. Each case gets a fresh PostgreSQL database, 35 seconds of warmup and 60 measured seconds. The load generator and database use different CPU cores from the backend. All cases use the same compiled application and fixtures.

Seven explorers alternate moving and pausing, with viewport messages bounded by the userscript's 300 ms throttle. Three painters publish one draft change per second, submit 30 pixels every 30 seconds, and nudge their small viewport every 12 seconds. These are synthetic human activity assumptions, not captured production traffic. Every user opens authenticated presence and live-sync sockets. Explorers offer observed tiles in template coverage; the server requests binary uploads when needed. Painters own persistent region claims. State-vector subscriptions receive real status changes.

The benchmark asserts successful tile delivery, exact persisted paint totals, duplicate paint rejection, ten online users, and each recipient's final nearby peer set, viewports and draft pixels. Server-side draft quantization preserves logical pixels and is checked after decoding masks.

`results.json` contains per-run CPU, sampled resident memory, latency distributions, traffic counts and correctness results. Separate sample files preserve raw latency, event-loop timer delay and memory samples. The driver records dispatch lateness to expose an overloaded load generator. Viewport latency measures send-to-receive for delivered peer states; intentional server coalescing means it is not an acknowledgement for every input update.

This measures the backend with local PostgreSQL and filesystem objects. It excludes S3, TLS, Traefik, browser rendering, Wplace tile downloads, and long-running recovery or failover. PostgreSQL CPU is measured separately. Native Bun uses a benchmark-only socket bridge into the production host, retaining application queues and coordinators. It is not a supported deployment adapter or an exhaustive Bun compatibility test.

The driver removes its own temporary backend files, PostgreSQL container and anonymous volume on completion or failure. It leaves logs and measurements under `test-results/runtime-benchmark/`. It never accesses the retained k3s laptop stack.
