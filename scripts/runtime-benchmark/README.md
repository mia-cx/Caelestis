# Runtime comparison with exploring and painting users

Tracks [#385](https://github.com/mia-riezebos/Caelestis/issues/385), with code and findings in PR #351.

Run from the repository root on Linux with Docker, cgroup v2 and `taskset` available:

```sh
pnpm --filter @caelestis/backend... build
NODE_BINARY=/absolute/path/to/node BUN_BINARY=/absolute/path/to/bun \
  BENCH_USERS=10 taskset -c 0,1 node scripts/runtime-benchmark/run.mjs
```

Repeat with `BENCH_USERS=100`, `BENCH_USERS=256` and `BENCH_USERS=1000`. The 256-user case uses 179 explorers and 77 painters, rounding the 70/30 split to whole users. It exercises the production admission limit without an override. Use the Node version pinned in the Dockerfile. The driver records both runtime versions, CPU affinity, application commit, benchmark source hashes, trace hash and fixture hashes. Override CPU assignments on machines with fewer than six available logical CPUs. `run.mjs` lists the available environment overrides.

Each successful user-count comparison takes about 15 minutes. Each of three repetitions rotates the order of Node, Bun with the existing Node adapter, and Bun with native HTTP/WebSockets. Each case gets a fresh PostgreSQL database, 35 seconds of warmup and 60 measured seconds. Warmup failures retain their partial measurements and phase. The load generator and database use different CPU cores from the backend. All cases use the same compiled application and fixtures.

Seventy percent of users explore with moving and paused periods. Viewport messages follow the userscript's 300 ms throttle. Thirty percent publish one draft change per second, submit 30 pixels every 30 seconds, and nudge their small viewport every 12 seconds. Paint submissions and viewport nudges have independent, deterministic offsets. This assumes painters have stored charges available. These are synthetic human activity assumptions, not captured production traffic.

The fixture is the real 1612×2584 Box Art export at its original coordinates. Its eight canvas tiles use the artwork's palette, with small unfinished areas for the painters. Synthetic tile snapshots reflect completed paints at five-second intervals. Every user opens authenticated presence and live-sync sockets. Explorers offer observed tiles in template coverage; the server requests binary uploads when needed. Painters own persistent region claims. State-vector subscriptions receive real status changes.

Production limits live-sync subscribers to 256. At 1,000 users, the driver copies the compiled backend into its temporary directory and raises only that constant to 1,000. The recorded capacity field distinguishes this experiment from production admission. All runtimes receive the same override. The 2,048-presence-subscriber and 64-nearest-peer limits remain in effect. Source files and the original build stay unchanged.

The benchmark asserts successful tile delivery, exact persisted paint totals, duplicate paint rejection, the requested online count, and each recipient's final nearest-peer set, viewports and draft pixels. Server-side draft quantization preserves logical pixels and is checked after decoding masks. Commands use the userscript's five-second deadline. The run stops at the first failed command or correctness check and records the failure; it does not simulate retries or HTTP fallback after overload.

`results.json` contains per-run backend and driver CPU, sampled resident memory, latency distributions, traffic counts and correctness results. Separate sample files preserve raw latency, 20 ms event-loop timer delay and 250 ms memory samples. The driver records dispatch lateness to expose an overloaded load generator. Viewport latency measures changed states delivered to recipients who already track that peer; entering an interest area does not count as delayed delivery. Intentional server coalescing means this metric is not an acknowledgement for every input update. Failed runs contain censored latency samples and must not be ranked as successful low-latency runs.

This measures the backend with local PostgreSQL and filesystem objects. It excludes S3, TLS, Traefik, browser rendering, Wplace tile downloads, and long-running recovery or failover. PostgreSQL CPU is measured separately. Native Bun uses a benchmark-only socket bridge into the production host, retaining application queues and coordinators. It is not a supported deployment adapter or an exhaustive Bun compatibility test.

The driver removes its own temporary backend files, PostgreSQL container and anonymous volume on completion or failure. It leaves logs and measurements under `test-results/runtime-benchmark/`. It never accesses the retained k3s laptop stack.

`BENCH_CPU_PROFILE=1 BENCH_VARIANTS=node` enables a diagnostic Node CPU profile. Profiling runs are marked in the result and excluded from performance comparisons.
