# Bun production runtime validation

The Bun backend passes the portable functional and recovery contracts. Both runtimes fail the 256-user CNPG/S3 workload.
These results support the runtime option, but do not establish sustained 256-user capacity or performance parity.
The shared tile-processing problem is tracked in [#397](https://github.com/mia-riezebos/Caelestis/issues/397).

## One server implementation

Node and Bun use the same routes, authentication, claims, coordination, migrations, and storage behavior.
Runtime adapters select Node HTTP/WebSockets or native `Bun.serve`, and Node SQLite or native `bun:sqlite`.
Both images contain identical backend and renderer files.

The PostgreSQL and MariaDB adapters retain their existing drivers. A native `Bun.SQL` trial failed 16 broader contracts.
Failures covered JSON parameter encoding, numeric result types, and error identifiers.
The shared S3 adapter retains the AWS SDK because the pinned Bun API lacks conditional writes and custom metadata.
Native APIs are used where they preserve the portable contracts.

The backend images pin Node 24.20.0 and Bun 1.4.2. The separate frontend stays on Node.
The default backend tag stays Node; releases also publish matching `<version>-node` and `<version>-bun` tags.

## Functional and recovery results

Application revision `c5b3c4d502aba42c0fd1b45ba877baae1012af68` passed
[extended CI](https://github.com/mia-riezebos/Caelestis/actions/runs/34885853405).
That run covers native amd64/arm64 builds, 24 Compose cases, six Helm cases, scans, SBOMs, and local Workers checks.

| Check | Result |
| --- | --- |
| Backend contracts with PostgreSQL and MariaDB enabled | 1,036 tests pass on each runtime |
| Filesystem and real S3 contracts | 16 tests pass on each runtime |
| Real social-image rendering | 13 tests pass on each runtime |
| Populated Node-to-Bun Compose upgrades | All six database/storage combinations pass |
| Bun k3s through Traefik HTTPS/WSS | SQLite/filesystem, CNPG/S3, and MariaDB/S3 pass |
| Frontend tests | 172 pass |
| Userscript tests | 1,509 pass with two workers |

Recovery checks cover process and pod replacement, migrations, CNPG primary switchover, database interruption, and ownership recovery.
The final CNPG/S3 load runs repeat these checks before replaying traffic.
They do not inject a fault during the 256-user workload or constitute a long soak test.

The populated social-worker check found a CommonJS export difference between Node and Bun.
Using gifenc's ESM entry fixes it through shared code. All six final-image upgrades render populated previews successfully.
An initial unrestricted userscript test run had six timing failures; the entire suite passed with two workers.

## Matched CNPG/S3 workload

The corrected driver replays 179 explorers and 77 painters, with two authenticated WebSockets per user.
It uses the real 1612×2584 Box Art fixture, eight full canvas tiles, persistent claims, and binary uploads.
Explorers move at the userscript's 300 ms throttle. Painters submit 30 pixels every 30 seconds and move every 12 seconds.
These are deterministic activity assumptions, not a production traffic capture.

Each runtime gets fresh CNPG and MinIO storage, the same Node frontend, and identical application files and trace.
Backend, frontend, and MinIO run on `hydra-olympus-2`; the two CNPG instances span both nodes.
The recovered CNPG primary runs on `hydra-olympus-1`. Both nodes run Debian 13 and k3s 1.34.
Backend and frontend each have a two-core/1 GiB limit. Each database and MinIO has a one-core/1 GiB limit.
The cluster is shared, so unrelated activity remains a possible source of noise.

The intended phases are 35 seconds of warmup and 60 measured seconds.
Pending warmup command chains must drain before measurement, and the remaining trace shifts without a catch-up burst.
Strict runs enforce the userscript's five-second command deadline. Node and Bun both time out during warmup.
All 256 users and 512 sockets remain connected at those failures; final correctness checks are not reached.

Separate observation runs allow 30 seconds to capture queueing and resource use.
Replies exceeding five seconds still count as client deadline misses. Timeouts also fail the run.
Observation results below describe failed warmup, including its drain period, rather than the intended measured phase.
Completed reply latencies are censored by failures and cannot rank either runtime as faster.
Further repetitions for a successful comparison are deferred until the shared capacity failure is fixed.

| Failed warmup observation | Node 24.20.0 | Bun 1.4.2 |
| --- | ---: | ---: |
| Phase duration, including drain | 76.47 s | 65.02 s |
| Backend CPU, percent of one core | 106.58% | 98.62% |
| Full-stack CPU, percent of one core | 136.69% | 133.39% |
| Backend RSS, median / peak | 210.69 / 231.13 MiB | 287.48 / 381.17 MiB |
| Full-stack RSS, median / peak | 563.57 / 606.73 MiB | 731.24 / 787.34 MiB |
| Replies exceeding the five-second deadline | 254 | 399 |
| Final workload correctness | Not reached | Not reached |

These are one unprofiled observation run per runtime, in Node-then-Bun order.
They complete different amounts of work before failure. The resource values do not establish a runtime efficiency winner.
The deadline counts include late replies; commands that time out are separate failures in the JSON.

CPU is cumulative container core time divided by its actual sample interval; 100% means one core.
Kubelet snapshots are cached. The collector excludes samples outside the phase and records each container's shorter CPU interval.
It rejects missing counters, counter resets, and restarts instead of reporting zero usage.
See Kubernetes' [node metrics documentation](https://kubernetes.io/docs/reference/instrumentation/node-metrics/).

Full-stack resources sum the backend, frontend, two CNPG instances, and MinIO.
They exclude shared Traefik, operators, Longhorn engines, node services, and the load generator.
Memory is cgroup RSS; the JSON also records working set. Browser rendering and Wplace downloads are outside this workload.

## Diagnostic profile

A separate Node observation run used a 20-second CPU profile and PostgreSQL activity sampling.
It also failed during warmup and is excluded from the resource comparison.
`classifyTarget` accounts for 35.5% of profile samples, and `encodeMismatchMask` accounts for 10.2%.
These shared functions process tile classifications and masks. The profile identifies optimization candidates, not a complete causal explanation.
Database serialization, storage latency, and queued uploads still need investigation.

The strict Bun run accumulated about 0.15 seconds of CPU throttling when inspected.
That observation does not establish a cluster-wide bottleneck or justify changing resource limits.

## Evidence and cleanup

The [compact results](benchmarks/bun-cnpg-s3-2026-09-14.json) retain image provenance, fixture/source hashes,
failed-run summaries, actual resource intervals, raw evidence hashes, and cleanup timestamps.
Raw reports and samples remain under the corresponding `test-results/caelestis-test-cnpg-s3-*` directories on the devbox.
The first attempt lacked a usable CPU interval and masked the workload error; it is excluded from the comparison.
The collector now preserves workload failures and saves raw samples before validation.

Reproduction and cleanup commands are in the [benchmark README](../scripts/runtime-benchmark/README.md).
Test namespaces, PVs, Longhorn backing storage, and imported test-image references are removed after testing.
No application release is published during this validation.
