# wplace-archive

Activity-aware incremental snapshot/archive of the Wplace tile canvas. Polite
by design: conditional GETs, respects `Retry-After`, caps its own rate, and
prototypes against a local mock so no test traffic reaches production.

> Status: **implemented.** Every crate is built and tested; the `archived`
> orchestrator wires them into a baseline sweep plus an activity-aware
> incremental loop. Not yet deployed.

## Layout

| Crate | Job | Model |
| --- | --- | --- |
| `crates/contracts` | shared types + traits (the seam) | opus-5.5 |
| `crates/config` | load/validate TOML, incl. `base_url` | gpt-6.1-sol |
| `crates/classify` | `(status,headers,body) -> Outcome` | gpt-6.1-sol |
| `crates/ratelimit` | per-lane token bucket, 429 backoff | gpt-6.1-sol |
| `crates/state-index` | tile state, checkpoint/resume | gpt-6.1-sol |
| `crates/metrics` | counters / rates / percentiles | gpt-6.1-sol |
| `crates/lanes` | derive + bind IPv6 source addresses | opus-5.5 |
| `crates/fetch` | conditional-GET hot path | opus-5.5 |
| `crates/store` | content-addressed, palette-indexed blobs | fable-5.1 |
| `crates/schedule` | change-rate EWMA + cadence tiers | opus-5.5 |
| `crates/temporal` | per-region activity model (bonus dataset) | opus-5.5 |
| `bins/archived` | orchestrator (`wplace-archive`) | opus-5.5 |
| `bins/mock-server` | local tile server (`wpa-mock`) | gpt-6.1-sol |
| `bins/bench` | load-ramp driver (`wpa-bench`) | gpt-6.1-sol |

## Build

```sh
cargo check            # whole workspace
cargo run -p wpa-mock  # local tile server (prototyping target)
```
