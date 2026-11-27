# Presence fan-out at event scale

An event server's presence room now keeps up with 2,048 sessions. Tick time falls by about two
thirds, and the 95th-percentile tick stays within its 300 ms interval. The room sends the same bytes as before.

Before the change, a 2,048-session tick took a median 430 ms. The room needed more than one full
interval for each tick, so peers' viewports and drafts fell further behind.

## Workload

[`presence-event.mjs`](../scripts/runtime-benchmark/presence-event.mjs) drives the compiled
`PresenceCoordinator` on an event server through the production `NodeLiveHost` socket. Its
[README section](../scripts/runtime-benchmark/README.md#presence-fan-out-on-an-event-server) gives
the commands and the workload model. In short:

- 1,024 or 2,048 sessions in four teams, restored as hibernated attachments.
- Three quarters crowd border hotspots between team quadrants of the 2,000 px Territory Weekend
  arena. The rest roam it.
- Every session moves its viewport each 300 ms tick and redrafts 60 pixels each second. Updates
  arrive in ten slices across each tick.
- Each run has 20 warmup ticks and 100 measured ticks, in a fresh Node process.

The arena is smaller than one 4,096 px `PeerGrid` cell. The 1,000 px interest padding covers the
whole arena, so every session considers every teammate. At 2,048 sessions that means 512
candidates for each of 2,048 subscribers on every tick. Every session moves on every tick, so every
peer is dirty and every delta carries all 64 of the recipient's peers.

## What cost the time

A Node CPU profile of the baseline at 2,048 sessions attributed self time as follows:

| Function | Share of samples | What it did |
| --- | ---: | --- |
| `relevant` | 36% | Filtered every session in the room by team, then sorted all candidates per subscriber |
| `PeerGrid.near` | 14% | Built a set of all 2,048 sessions per subscriber, since the arena fits in one or two cells |
| `send` | 11% | Ran `JSON.stringify` on the same 64 peers once per recipient |
| Comparator and upsert filter | 10% | Sort comparisons and delta assembly |
| Attachment clone and freeze | about 1% | `serializeAttachment` on each update |

## Changes

All three changes are in `apps/backend/src/presence/coordinator.ts`:

1. **One grid per team.** On an event server, each tick builds one `PeerGrid` per event team.
   Selection never walks another team's sessions, and the per-session team map is gone. Sessions
   without a team join no grid and still see nobody.
2. **Bounded nearest-64 selection.** Selection inserts each visible candidate into a 64-entry list,
   ordered by distance and then `localeCompare` on session ID. It skips any candidate farther than
   the current 64th. Ties keep the same order a stable full sort gives.
3. **One encoding per peer per tick.** A delta is assembled from peer JSON cached for the tick.
   The bytes match `JSON.stringify` of the whole event.

Dirty handling is unchanged. At event scale every peer moves on every tick, so tracking dirty state
per team would skip no work. Attachment serialisation was about 1% of samples, so it stays as it is.

## Results

The test machine is an Apple M4 with 10 cores and 16 GiB, running Node 24.20.0. Other work kept it
heavily loaded, with load averages between 7 and 40 during these sessions. The baseline is
`551c1048` (`feat/event-team-presence`); the candidate is `29797b12`. Both were later rebased as `82d8ec4a` and `0191d88a`. The
rebase changes only capture-run validation, which this workload never calls. The table gives three
alternating pairs. Each pair runs in a different order: baseline first, then candidate first, then
baseline first.

Tick is the coordinator's own `presence.total` time. Select and serialize are averaged per tick.
CPU is process CPU per measured tick, and it includes the driver. The driver's work is the same
for both builds: about 30 ms of update handling per tick at 2,048 sessions. The event-loop column
is the p99 delay sampled at 10 ms resolution.

### 2,048 sessions

| Metric | Baseline (3 pairs) | Candidate (3 pairs) |
| --- | --- | --- |
| Tick p50 | 432.6 / 423.5 / 430.1 ms | 145.5 / 141.8 / 149.3 ms |
| Tick p95 | 559.3 / 496.6 / 492.8 ms | 162.9 / 163.2 / 200.4 ms |
| Select per tick | 351.6 / 337.0 / 345.9 ms | 104.5 / 97.9 / 111.6 ms |
| Serialize per tick | 72.9 / 68.9 / 71.1 ms | 15.7 / 14.5 / 16.9 ms |
| CPU per tick | 523 / 508 / 517 ms | 209 / 204 / 216 ms |
| Event-loop p99 | 485.8 / 474.2 / 478.9 ms | 173.1 / 169.3 / 181.3 ms |
| Mean RSS | 264 / 262 / 274 MiB | 345 / 344 / 338 MiB |

### 1,024 sessions

| Metric | Baseline (3 pairs) | Candidate (3 pairs) |
| --- | --- | --- |
| Tick p50 | 135.6 / 124.7 / 141.5 ms | 62.3 / 69.7 / 70.7 ms |
| Tick p95 | 209.3 / 309.8 / 529.7 ms | 77.2 / 96.3 / 91.9 ms |
| Select per tick | 90.0 / 93.3 / 115.8 ms | 36.6 / 40.4 / 39.0 ms |
| Serialize per tick | 38.1 / 39.6 / 48.9 ms | 9.1 / 12.0 / 10.6 ms |
| CPU per tick | 175 / 172 / 194 ms | 98 / 107 / 104 ms |
| Event-loop p99 | 156.4 / 155.2 / 165.3 ms | 83.4 / 94.7 / 89.7 ms |

Every pair improves on every metric except RSS. At 2,048 sessions, median tick time falls 66% and
process CPU falls 59%. The baseline's p95 tick exceeds the 300 ms interval in every 2,048-session
run; the candidate's stays below it. Single slow ticks remain on the loaded machine: two candidate
runs record one 639 ms and one 705 ms tick, where the baseline's maxima are 705 to 994 ms.

Mean RSS at 2,048 sessions is about 75 MiB higher for the candidate. Each tick now holds
the peers' encoded JSON, and allocation runs faster between collections. The machine was too
loaded to separate the two causes with heap profiles in this session.

Messages and bytes are identical in every run: 204,800 deltas and 238.0 MB/s at 2,048 sessions,
and 102,400 deltas and 118.7 MB/s at 1,024. The volume belongs to the protocol. Every delta carries
all 64 moving peers, at about 540 bytes each. About 270 of those bytes are the draft mask.

## Correctness

Every run passes the harness's assertions. 128 observer sessions at 2,048 parse their messages, and
none ever receives itself or another team's session. Their final peer sets, viewports and decoded
draft pixels match the nearest-64 rule computed independently from the driver's own state.

Separate hashed runs (one pair, 40 measured ticks) hash every byte each session receives. Baseline
and candidate streams are identical. The 2,048-session hash is `3c90f596…82ff26`, and the 1,024 hash
is `2d0d4841…791e97`. Each comparison also pins the trace hash.

A new test in `tests/presence-tick.test.ts` fixes the selection order on an event server. It covers
ties at equal distances, ordered by session ID against insertion order, the 64-peer cap, and nearer
sessions from another team or from no team. It also checks the delta that follows when a peer
displaces the 64th. The test passes on the baseline and fails when the tie-break is removed.

Restored attachments stand in for connections, so HTTP admission, ws framing, the network, and
browser decoding fall outside these results. The run makes no claim about Workers capacity.

[Per-run summaries](benchmarks/presence-event-scale-2026-11-27.json.gz) include build and trace
hashes, stage totals, event-loop delay, RSS and traffic counts. The harness's SHA-256 is
`09a65c03…a8fa05`. Raw CPU profiles remain under `test-results/presence-event/`.

## Validation

`pnpm exec biome check .`, `pnpm turbo run check`, the backend tests (189 passed, 1 skipped), the
runtime tests (17, including `capture-run.test.ts`), and the shared tests (121) pass.

## Next

At this point selection is two thirds of the tick, and its cost grows with the square of a
team's size: every subscriber still measures its distance to all 512 teammates. The next step is a
spatial nearest-64 search with finer cells, so a subscriber stops once the 64th nearest is closer
than any cell it has not reached.
