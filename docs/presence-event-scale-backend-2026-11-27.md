# Presence fan-out at event scale

Each session in an event server's presence room with 2,048 sessions now receives a delta every
300 ms, at the median. Before these changes, a cadence replay measured a median gap of 764 ms. Two problems stretched it:

- A 2,048-session tick took a median 430 ms of work.
- The next tick's timer only started after that work finished, so the work added to every
  interval.

Ticks now take about a third as long. The timer now counts from when the last tick started.

## Workload

[`presence-event.mjs`](../scripts/runtime-benchmark/presence-event.mjs) drives the compiled
`PresenceCoordinator` on an event server through the production `NodeLiveHost` socket. Its
[README section](../scripts/runtime-benchmark/README.md#presence-fan-out-on-an-event-server) gives
the commands and the workload model. In short:

- 1,024 or 2,048 sessions in four teams, restored as hibernated attachments.
- Three quarters crowd border hotspots between team quadrants of the 2,000 px Territory Weekend
  arena. The rest roam it.
- Every session moves its viewport every 300 ms and redrafts 60 pixels each second. Updates arrive
  in ten slices across each interval.
- Each run has 20 warmup intervals and 100 measured intervals, in a fresh Node process.

The harness has two modes:

- **Cadence** (`BENCH_CADENCE=1`) keeps the coordinator's own timer running while updates arrive
  on a fixed schedule. It measures the gap between consecutive deltas at each observer session.
  If the process stalls for longer than one interval, the driver restarts its schedule instead of
  replaying the backlog as a burst, which the room's eight-per-second rate limit would refuse. The
  results count these restarts as stalls.
- **Driven ticks** (the default) stops the timer and runs each tick after that interval's updates.
  Every build then batches the same updates into the same ticks, so tick work compares directly
  and the bytes each session receives can be hashed.

The arena is smaller than one 4,096 px `PeerGrid` cell. The 1,000 px interest padding covers the
whole arena, so every session considers every teammate. At 2,048 sessions, that means 512
candidates for each of 2,048 subscribers on every tick. Every session moves every interval, so
every peer is dirty and every delta carries all 64 of the recipient's peers.

## What cost the time

A Node CPU profile of the original build at 2,048 sessions attributed self time as follows:

| Function | Share of samples | What it did |
| --- | ---: | --- |
| `relevant` | 36% | Filtered every session in the room by team, then sorted all candidates per subscriber |
| `PeerGrid.near` | 14% | Built a set of all 2,048 sessions per subscriber, since the arena fits in one or two cells |
| `send` | 11% | Ran `JSON.stringify` on the same 64 peers once per recipient |
| Comparator and upsert filter | 10% | Sort comparisons and delta assembly |
| Attachment clone and freeze | about 1% | `serializeAttachment` on each update |

The profile does not show the interval stretch. `armTick` started the 300 ms timeout when the
first update after a tick was processed. Updates that arrived during a tick waited in the event
loop until it finished, so each interval lasted 300 ms plus the tick's work.

## Changes

All four changes are in `apps/backend/src/presence/coordinator.ts`:

1. **One grid per team.** On an event server, each tick builds one `PeerGrid` per event team.
   Selection never walks another team's sessions, and the per-session team map is gone. Sessions
   without a team join no grid and still see nobody.
2. **Bounded nearest-64 selection.** Selection inserts each visible candidate into a 64-entry list,
   ordered by distance and then `localeCompare` on session ID. It skips any candidate farther than
   the current 64th. Ties keep the same order a stable full sort gives.
3. **One encoding per peer per tick.** A delta is assembled from peer JSON cached for the tick.
   The bytes match `JSON.stringify` of the whole event.
4. **A tick cadence counted from the last tick's start.** `armTick` schedules the next tick no sooner
   than 300 ms after the previous tick started. A 145 ms tick therefore still delivers about every
   300 ms. A change in a room idle for longer than the interval ticks at once, where it used to wait
   300 ms. Every change still arms the tick timer, as before. A room with only heartbeats ticks
   without selecting anyone. Alarms and hibernation are untouched.

Dirty handling is unchanged. At event scale every peer moves every interval, so tracking dirty
state per team would skip no work. Attachment serialisation was about 1% of samples, so it stays
as it is.

## Results

The test machine is an Apple M4 with 10 cores and 16 GiB, running Node 24.20.0. Other work kept it
heavily loaded, with load averages between 7 and 40 during these sessions. Three builds are compared:

| Build | Commit | Contents |
| --- | --- | --- |
| Original | `551c1048`, rebased as `82d8ec4a` | `feat/event-team-presence` |
| Tick work | `29797b12`, rebased as `0191d88a` | Changes 1–3 |
| Final | `4db6350b`, merged in #931 as `e270bfd5` | Changes 1–4 |

The rebase changes only capture-run validation, which this workload never calls. Pairs alternate
which build runs first.

### Delivery cadence

This table compares the tick-work build with the final build, in cadence mode, over three pairs.
Gaps are measured between consecutive deltas at every observer: 128 at 2,048 sessions and 64 at
1,024.

| Metric | Tick work | Final |
| --- | --- | --- |
| 2,048: gap p50 | 455 / 458 / 457 ms | 301 / 301 / 300 ms |
| 2,048: gap p95 | 497 / 476 / 598 ms | 313 / 315 / 325 ms |
| 2,048: gap max | 757 / 601 / 778 ms | 451 / 479 / 527 ms |
| 2,048: ticks per 100 intervals | 66 / 66 / 65 | 101 / 102 / 103 |
| 2,048: tick p95 | 189 / 174 / 319 ms | 153 / 156 / 163 ms |
| 1,024: gap p50 | 361 / 361 / 370 ms | 301 / 301 / 301 ms |
| 1,024: gap p95 | 511 / 379 / 439 ms | 351 / 318 / 357 ms |

The median gap drops to the 300 ms interval in every pair, at both sizes. In the tick-work
build each gap is 300 ms plus the tick's work. Pullfrog's replay of the same build measured
502–527 ms on its machine. The final build's tail comes from single slow ticks and stalls on the loaded
machine. Each run records up to two stalls in either build.

Delivering every interval sends more traffic, because each tick carries about the same bytes:
about 70 MB across all sessions at 2,048. Outbound traffic at 2,048 sessions rises from 157 MB/s to 238 MB/s.
That is the volume the protocol's 300 ms tick implies, and it is the same volume the driven-tick
runs below measure for every build.

One cadence pair against the original build shows where these changes started. At 2,048 sessions
the original's gap p50 is 764 ms and its p95 is 1,339 ms. The driver had to restart its schedule
34 times in 100 intervals because the room could not keep up. The final build in the same pair
records a 300 ms p50, a 313 ms p95, and one stall.

### Tick work

This table compares the original build with the final build in driven-tick mode, over three pairs.
Tick is the coordinator's own `presence.total` time. Select and serialize are averaged per tick.
CPU is process CPU per tick, including the driver. The driver does the same work for both builds:
about 30 ms of update handling per tick at 2,048 sessions. The event-loop column is the p99 delay
sampled at 10 ms resolution.

| 2,048 sessions | Original | Final |
| --- | --- | --- |
| Tick p50 | 451.4 / 443.1 / 422.4 ms | 157.9 / 159.1 / 142.0 ms |
| Tick p95 | 865.7 / 754.8 / 541.0 ms | 238.9 / 610.7 / 188.3 ms |
| Select per tick | 397.4 / 394.9 / 342.3 ms | 114.9 / 168.1 / 101.4 ms |
| Serialize per tick | 85.9 / 84.0 / 69.5 ms | 19.1 / 26.6 / 15.7 ms |
| CPU per tick | 567 / 563 / 507 ms | 221 / 261 / 202 ms |
| Event-loop p99 | 565.7 / 515.4 / 450.9 ms | 195.0 / 235.9 / 169.1 ms |
| Mean RSS | 281 / 266 / 273 MiB | 339 / 326 / 340 MiB |

| 1,024 sessions | Original | Final |
| --- | --- | --- |
| Tick p50 | 222.3 / 141.4 / 145.0 ms | 125.2 / 64.8 / 69.3 ms |
| Tick p95 | 516.8 / 253.3 / 684.7 ms | 520.2 / 75.5 / 152.8 ms |
| Select per tick | 154.3 / 93.1 / 137.6 ms | 101.1 / 35.9 / 51.8 ms |
| Serialize per tick | 64.6 / 42.0 / 62.3 ms | 30.2 / 9.5 / 16.1 ms |
| CPU per tick | 266 / 181 / 206 ms | 153 / 102 / 113 ms |
| Event-loop p99 | 286.0 / 169.9 / 179.4 ms | 257.3 / 84.3 / 100.6 ms |

At 2,048 sessions, median tick time falls by about two thirds and CPU per tick by about 60% in
every pair. Load spikes on the machine set the tail. One final-build pair records a 611 ms p95 at
2,048 sessions. In the first 1,024 pair both builds' p95 exceeds 500 ms. Mean RSS at 2,048
sessions is about 60 MiB higher with the changes. Each tick now holds the peers' encoded JSON, and
allocation runs faster between collections. The machine was too loaded to separate those two
causes with heap profiles.

In driven-tick mode, messages and bytes are identical across builds: 204,800 deltas and 238.0 MB/s
at 2,048 sessions, and 102,400 deltas and 118.7 MB/s at 1,024. Every delta carries all 64 moving
peers, at about 540 bytes each. About 270 of those bytes are the draft mask.

## Correctness

Every run passes the harness's assertions. Observers are the first four sessions in every 64, so
each of the four teams has 32 observers at 2,048 sessions and 16 at 1,024. No observer ever receives
itself or another team's session. Each observer's final peer set, viewports and decoded draft pixels
match the nearest-64 rule, which the harness computes independently from the driver's own state.

Hashed runs in driven-tick mode hash every byte each session receives, over one pair and 40
measured ticks. The original and final builds' streams are identical. The 2,048-session stream
hash is `3c90f596…`; the 1,024-session hash is `2d0d4841…`. Each comparison also pins the trace
hash.

`tests/presence-tick.test.ts` covers both behaviours:

- **Selection order on an event server.** The test covers ties at equal distances, which must be
  ordered by session ID rather than insertion order. It also covers the 64-peer cap, nearer
  sessions on another team or on none, and the delta that follows when a peer displaces the 64th.
  It passes on the original build and fails when the tie-break is removed.
- **Cadence under fake timers.** Each tick takes 145 ms, and the next update lands as the tick
  finishes. Deltas must arrive exactly 300 ms apart. The test fails on the tick-work build, whose
  gap is 445 ms.

Restored attachments stand in for connections. HTTP admission, ws framing, the network and browser
decoding fall outside these results. The runs make no claim about Workers capacity.

[Per-run summaries](benchmarks/presence-event-scale-2026-11-27.json.gz) hold all four comparison
sets with build and trace hashes, stage totals, delivery gaps, stalls, event-loop delay, RSS and
traffic counts. The cadence sets ran harness `cac1ac50…`. The driven-tick and hashed sets ran the
revision before it, which differs only in how cadence mode restarts its schedule. Raw CPU profiles
remain under `test-results/presence-event/`.

## Validation

These checks pass on `main` at `e270bfd5`:

- `pnpm exec biome check .` and `pnpm turbo run check`.
- Backend tests: 192 passed, 1 skipped. `backfill-contract.test.ts` hit its 5 s timeout once in the
  full parallel run and passed twice when rerun alone.
- Runtime tests: 20, including `capture-run.test.ts`.
- Worker tests: 15, on the Durable Object host.
- Shared tests: 123.

A cadence run of that build at 2,048 sessions, over 40 measured intervals, records a gap p50 of
301 ms and a p95 of 310 ms, with no stalls.

## Next

Selection is now about two thirds of each tick, and its cost grows with the square of a team's
size: every subscriber still measures its distance to all 512 teammates. The next step is a
spatial nearest-64 search with finer cells, where a subscriber stops once its 64th-nearest peer
is closer than any cell it has not reached.
