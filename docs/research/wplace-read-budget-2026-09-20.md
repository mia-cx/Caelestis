# Wplace read budget

Investigated September 20, 2026 for [issue #492](https://github.com/mia-riezebos/Caelestis/issues/492).

**The authorized ramp first received 429 during the 16 combined requests/second phase, with `Retry-After: 60`.** The preceding 2, 4, and 8 requests/second phases each ran for 60 seconds without rejection. This is an observed failure point under one workload, not a universal Wplace quota. The subsequent one-hour run at four combined requests/second is **IN PROGRESS**, not passed. Keep issue #492 open.

Mia confirmed that this Mac shares its public IPv4 with the existing Caelestis server. The parent investigation ran calibration from the Mac on that shared egress. It did not run commands on the Caelestis server. Existing background traffic remained unmeasured, so the combined IP request rate is unknown.

## First-party evidence

Wplace's deployed [API client](https://wplace.live/_app/immutable/chunks/Dckshkh0.js) defines public single-pixel attribution and staff-only bulk/history readers. The inspected module's SHA-256 was `815ea2b21cbdbbf1c890148180d716a1c390ef37cf6bea1f00a39103a7e54a4e`.

The parent investigation observed these responses during sparse Chromium/CDP inspection:

| Request | Observation | What it establishes |
| --- | --- | --- |
| `GET /s0/pixel/{tileX}/{tileY}?x=…&y=…` | 200; `paintedBy` and `region`; no quota or retry headers | Public attribution works for one pixel. It establishes no sustainable request rate. |
| `GET /files/s0/tiles/{tileX}/{tileY}.png` | 200; `ETag`, `Last-Modified`, and `cache-control: s-maxage=5, must-revalidate, no-store` | Tile delivery supports validators. Request accounting for cache hits and 304 responses remains unknown. |
| `GET /staff/tools/select-area/s0/{tileX}/{tileY}?x0=…&y0=…&x1=…&y1=…` | Four-pixel request returned 403 with a normal account logged in | The discovered bulk reader is unavailable to that account. |
| `GET /staff/tools/wayback/s0/l1/x{tileX}/y{tileY}/t{timestamp}` | One-event request returned 403 with a normal account logged in | The discovered history reader is unavailable to that account. |

The client decodes rectangle attribution as a painter ID plus colour for every pixel. Its Wayback method accepts pagination fields. WplaceStaff independently describes Wayback as a staff-only tool for painter identity and painting time. No public batch equivalent appeared in the inspected client or sources. [Wplace staff announcement](https://www.reddit.com/r/WplaceLive/comments/1qdc9jb/website_discord_updates/)

The authenticated checks followed a successful `/me` response. Earlier anonymous requests returned 401; those earlier responses alone did not establish normal-account denial. The inspected world PNG contained image chunks only, with no owner metadata. The sampled public attribution response contained no colour, painting timestamp, event ID, or revision.

These response observations come from this investigation, not an official contract. [The attribution report](wplace-attribution-2026-09-20.md) preserves the client inspection and access checks. [Public-source research](wplace-attribution-public-sources-2026-09-20.md) records the supporting implementations and announcements. The [official patch notes](https://wplace.live/patch-notes) and searched first-party statements supplied no numerical read quota.

## Initial bounded calibration

The recorded run started at **2026-09-20 02:32:12.356 UTC** and ended at **02:35:07.565 UTC**, lasting 175.209 seconds. The probe forced IPv4, used no cookies or authentication, and used `Caelestis-Tile-Fetcher/1.0`. Every recorded response used HTTP/2 with `proxyUsed: 0`. The probe kept one request in flight and made no retries. Two earlier standalone baseline requests also returned 200; those are additional to the 100 recorded attempts and are not included in the attached run log.

| Phase | Attempts | Scheduled spacing | Result |
| --- | ---: | ---: | --- |
| Tile baseline | 10 | 5 seconds | 10 × 200 |
| Pixel baseline | 10 | 5 seconds | 10 × 200 |
| Tile reads | 20 | 1 second | 20 × 200 |
| Pixel attribution reads | 20 | 1 second | 20 × 200 |
| Alternating tile/pixel reads | 20 | 1 second combined | 20 × 200 |
| Tile GET/conditional-GET pairs | 20 | 1 second | 10 × 200, 10 × 304 |

Actual within-phase start spacing was 5,001–5,004 ms for baselines and 1,000–1,014 ms for the later phases. There were 60 tile attempts and 40 attribution attempts. No requests overlapped. No 429, 403, challenge response, transport error, or `Retry-After`/quota header appeared in these 100 records.

All ten conditional requests used `If-None-Match` and returned 304 with zero downloaded body bytes. This confirms conditional request support for those unchanged tiles. It does not establish exemption from request accounting. Tile responses included CDN `HIT`, `REVALIDATED`, and `EXPIRED` states. Pixel responses were `DYNAMIC`. These distinctions describe delivery and caching; they do not expose enforcement counters.

The initial result establishes a short successful additional workload on the selected shared IPv4. It does not establish the IP's total rate, headroom, sustainable quota, or whether endpoint counters are shared. Repeated tile reads covered four fixed paths; cache warmth and path diversity differ from a wide monitoring scan. This initial pass included no concurrency or burst phase and no 429. The later ramp below supplies the first rejection and cooldown header.

The durable artifacts are [attempts.jsonl](wplace-read-budget-2026-09-20/attempts.jsonl), [summary.json](wplace-read-budget-2026-09-20/summary.json), and the [probe](wplace-read-budget-2026-09-20/probe.mjs). The log retains only allowlisted response headers and timing/status/size metadata. It contains no response bodies, cookies, authorization headers, or the source egress IP. `remoteIp` is the public destination address. The probe discards response bodies rather than saving pixel identities.

The preserved probe matches the executed workload, with one portability change: `WPLACE_BUDGET_OUTPUT_DIR` can override its original output directory. Inspect the schedule without network requests using `node docs/research/wplace-read-budget-2026-09-20/probe.mjs --dry-run`. An authorized rerun must select a fresh existing output directory and retain the agreed caps; rerunning would add traffic to the shared egress.

## Authorized ramp and first rejection

Mia explicitly requested increasing traffic until rate limiting and observations across one second, one minute, five minutes, ten minutes, thirty minutes, and one hour. That instruction superseded the earlier proposal to avoid escalation. The parent investigation retained the same shared IPv4, alternating tile/pixel requests, cookie-free access, and no automatic retries.

The ramp ran from **03:01:09.362 to 03:04:14.611 UTC**. The configured concurrency cap was eight; the largest observed in-flight count was three. Every response used HTTP/2 and reported `proxyUsed: 0`.

| Scheduled combined rate | Phase duration | Requests started | Responses |
| --- | --- | ---: | --- |
| 2/second | 60-second dispatch window | 120 | 120 × 200 |
| 4/second | 60-second dispatch window | 239 | 239 × 200 |
| 8/second | 60-second dispatch window | 477 | 477 × 200 |
| 16/second | Stopped at first rejection | 79 | 78 × 200, 1 × 429 |

The completed ramp contains **915 attempts: 914 × 200 and 1 × 429**. Scheduled rates are pacing targets; timer and process overhead explain the slightly lower request counts. Phases drained outstanding requests before advancing. Planned 32/second and 64/second phases never ran.

Attempt 914 was a public pixel lookup. It started at **03:04:14.468**, 4.842 seconds after the 16/second phase began, and returned 429 at **03:04:14.536**. The response included `Retry-After: 60`. It supplied no `RateLimit-*` or `X-RateLimit-*` quota counters. This verifies one server-requested cooldown duration; it does not establish a 60-second counting window, refill rule, or general quota. Cloudflare delivery does not identify which limiter generated the 429.

Dispatch stopped on that response. Attempt 915, a tile request, had already started five milliseconds before the rejection arrived and completed afterward with 200. No new request started after the first 429 response. An already-running tile succeeding alongside a rejected pixel does not prove independent endpoint budgets.

The parent waited 61 seconds from the rejection response before starting the next experiment. The ramp itself has no retries or recovery probes.

### Time-window observations

The analyzer counts known request starts in `(window end - duration, window end]`. It counts attempted requests, including the rejected request and any still in flight. Background requests from the shared egress remain outside these counts.

| Window | Largest known starts in ramp | Starts before first 429 response | Interpretation |
| --- | ---: | ---: | --- |
| 1 second | 16 | 16: 8 tile, 8 pixel | Observed workload; not a proven permitted burst |
| 1 minute | 516 | 516: 258 tile, 258 pixel | Observed mixed preceding load; not a verified per-minute quota |
| 5, 10, 30, 60 minutes | 915 within the partial run | 915: 458 tile, 457 pixel | Full windows did not elapse; no result for those durations |

The 60-second count spans portions of the 8/second and 16/second phases. Accumulated load, route-specific enforcement, concurrency, CDN behavior, or unknown background traffic could explain the rejection. This experiment cannot isolate those causes. Four repeated tile paths also keep the workload narrower and more cache-friendly than a wide monitoring scan.

### Sustained run in progress

After cooldown, the parent started a **one-hour alternating tile/pixel phase at four combined requests/second** at **03:05:15.552 UTC**. Its stop condition remains the first unexpected response or transport failure. At this report revision, that run is **IN PROGRESS**. Five-, ten-, thirty-, and sixty-minute success must not be claimed from its planned duration. Its unfinished output remains outside the published artifacts until the parent records the result.

The completed ramp artifacts are [attempts](wplace-read-budget-2026-09-20/ramp/attempts.jsonl), [summary](wplace-read-budget-2026-09-20/ramp/summary.json), [window analysis](wplace-read-budget-2026-09-20/ramp/analysis.json), [analyzer](wplace-read-budget-2026-09-20/ramp/analyze.mjs), and [probe](wplace-read-budget-2026-09-20/ramp/probe.mjs). Logs retain allowlisted headers and metadata, with no bodies, credentials, or source IP. The summary's `maxConcurrency: 8` is the configured cap; the analysis's `maxInFlight: 3` is observed.

The parent edited probe portability after launch, adding environment overrides for rates, phase duration, and output location. The preserved defaults retain the executed ramp workload: `[2,4,8,16,32,64]`, 60-second phases, cap eight, and alternating routes. The file is therefore the portable reproduction, not byte-identical pre-launch source. `--dry-run` checks the schedule without HTTP. Running the analyzer over the saved JSONL is also network-free.

## Published clients and historical reports

These repositories are primary evidence for their own code. Their descriptions of Wplace behavior are third-party observations, not Wplace guarantees.

| Source snapshot | Concrete evidence | Limit of that evidence |
| --- | --- | --- |
| [murolem/wplace-archiver, May 6, 2026](https://github.com/murolem/wplace-archiver/tree/fd3e3c36ce624bd71c8f764a1e73f877b758f0ff) | PNG client defaults to 4 requests/second and two concurrent requests. | Author-selected settings, with no published capture proving a current quota. |
| [Hugi-R/wplace-archiver, September 1, 2026](https://github.com/Hugi-R/wplace-archiver/tree/33134415af6dd3df3594de52418f41b8b69bbd0d) | README warns that downloading more than 100 tiles at once requires waiting. | No measurement window, response capture, or established burst allowance. |
| [lin-alg/Wplace_Map_Inspector, December 4, 2025](https://github.com/lin-alg/Wplace_Map_Inspector/tree/91779c68cad80096661dff45e0bd49a4e32ac1eb) | Pixel scanner defaults to six requests/second and four workers, with delays and adaptive backoff. | Local scheduler settings, not a demonstrated Wplace read budget. |

The murolem [CLI defaults](https://github.com/murolem/wplace-archiver/blob/fd3e3c36ce624bd71c8f764a1e73f877b758f0ff/src/cli/index.ts#L20-L25) and [429 handling](https://github.com/murolem/wplace-archiver/blob/fd3e3c36ce624bd71c8f764a1e73f877b758f0ff/src/lib/TileFetchQueue.ts#L192-L211) are explicit. It reads `Retry-After` and pauses its queue. Its [README](https://github.com/murolem/wplace-archiver/blob/fd3e3c36ce624bd71c8f764a1e73f877b758f0ff/README.md#rate-limiting) reports a one-minute server delay. A separate [constant](https://github.com/murolem/wplace-archiver/blob/fd3e3c36ce624bd71c8f764a1e73f877b758f0ff/src/constants.ts#L5-L6) claims a ten-second maximum. This inconsistency prevents treating either duration as a current contract.

Hugi-R's [request implementation](https://github.com/Hugi-R/wplace-archiver/blob/33134415af6dd3df3594de52418f41b8b69bbd0d/src/tiles/downloader.rs#L324-L429) consumes `Retry-After`, sends conditional GETs, and handles 304. Its README still describes HEAD requests, so the implementation is the better source for current client behavior. Nothing there establishes that conditional requests consume less request budget. The [100-tile warning](https://github.com/Hugi-R/wplace-archiver/blob/33134415af6dd3df3594de52418f41b8b69bbd0d/README.md#L19-L25) is an unverified historical lead.

Map Inspector's “batches” are concurrent single-coordinate requests. Its [configuration](https://github.com/lin-alg/Wplace_Map_Inspector/blob/91779c68cad80096661dff45e0bd49a4e32ac1eb/main.js#L183-L211) and [request loop](https://github.com/lin-alg/Wplace_Map_Inspector/blob/91779c68cad80096661dff45e0bd49a4e32ac1eb/main.js#L312-L376) show client throttling and handling for 429/403. A 403 is not, by itself, evidence of rate limiting.

The older j0code client uses a shared GET helper for tiles and pixel metadata. It retries 429 using `Retry-After`, with a 20-second fallback. Sharing a client helper does not prove shared server enforcement. [Implementation, September 22, 2025](https://github.com/j0code/wplace-api/blob/39614e3dd75dfd64a4a4476b7650f45702cedd88/src/main.ts#L142-L203)

No captured numerical quota was found in the searched public evidence. Code that reads a header does not prove the server always sends it. Our later ramp independently captured `Retry-After: 60` on one 429 response, but still no quota counters.

## Budget design supported by current evidence

Use one configurable request ceiling for tile monitoring, attribution, and retries leaving the same egress. This is a conservative application policy, not a claim about Wplace's implementation. Coordinate that ceiling across every Caelestis process sharing the egress. Keep per-route counters so later evidence can justify separate limits.

Count every network attempt, including retries and conditional requests, until evidence supports another rule. Deduplicate overlapping tile requests and pending pixel lookups. Reuse fresh client-fed tile observations before scheduling server fetches. Attribution consumes the remaining explicitly allocated budget; changing the polling interval must not silently increase the combined request rate.

A 429 should extend a shared cooldown until at least the server's `Retry-After` deadline. No other worker should continue spending that assumed shared budget. Handle absent or malformed headers with bounded backoff. Authentication failures and challenges need separate classification. A successful response after cooldown proves recovery for that request, not a universal reset period.

The steady demand calculation is `tile attempts/second + attribution attempts/second + other attempts/second`. Reserve headroom below a measured operating range. Do not choose a numerical production ceiling from the scanner defaults above.

## Calibration method and further measurements

The selected first pass used the Mac's shared IPv4, 100 attempts, concurrency one, and a 20-minute cap. The completed phases above replace the earlier unexecuted 120-attempt proposal. No optional burst requests or recovery controls were used. The probe stopped on any unexpected status or challenge and had no automatic retries.

The explicitly authorized ramp and in-progress sustained run extend that first pass. Existing Caelestis traffic sharing this IP remains unknown. These experiments measure additional traffic, not the aggregate ceiling. Their logs capture the selected routes, coordinates, request timing, and stop conditions.

Further work should answer the remaining questions without silently escalating the completed workload:

1. Count background tile, attribution, and other Wplace attempts across processes on this egress.
2. Finish and record the authorized one-hour observation, or its earlier stop, without treating its planned duration as measured.
3. If concurrency or burst behavior matters, give it a separate bounded schedule rather than combining it with sustained-rate changes.
4. Revisit endpoint separation only when headers, operator information, or controlled observations can distinguish shared enforcement.

Stop at the first 429 and respect its cooldown. End the phase instead of retrying through the limit. Stop on authentication failure, challenge, unexpected server errors, or increased load on the chosen host. A recovery request after cooldown requires remaining allowance and inclusion in the selected schedule. Retries count toward the cap. End at either the request cap or elapsed-time cap.

For every attempt, record start/end time, route class, in-flight count, status, bytes, and relevant headers. Include `Retry-After`, quota headers if present, `Cache-Control`, `Age`, `ETag`, `Last-Modified`, `Date`, and CDN cache status when supplied. Distinguish a changed tile from a newly delivered stale snapshot. Record scheduled and actual spacing.

The initial short pass exposed response behavior without finding an unsuitable rate. The later ramp found one rejection under a specific preceding workload. Neither establishes a universal minute/hour/day quota or a sustainable aggregate production ceiling. The user's explicit escalation request authorized the ramp; stopping on rejection and respecting cooldown still apply.

Separate-versus-shared enforcement remains inconclusive: a pixel 429 and an already-in-flight successful tile cannot distinguish it. Stronger evidence would require explicit quota counters, an operator statement, or controlled cross-route observations. A single fixed access context also cannot establish IP-versus-account enforcement.

## Completion criteria and unknowns

Issue #492 remains unresolved. The ramp establishes a first rejection and a 60-second requested cooldown, while sustained observation remains in progress. The shared IPv4 is known, but aggregate background traffic and headroom are not. The completed sustained result must inform an operating recommendation without presenting that recommendation as an official quota.

Still unknown:

- Numerical burst and sustained limits, concurrency constraints, and their time windows.
- Enforcement by IP, account, route, hostname, or combinations, including whether tiles and attribution share counters.
- Accounting for cached responses, conditional requests, 304s, failures, and retries.
- Whether the observed 60-second cooldown generalizes, and how enforcement varies by egress or time.
- Whether Wplace offers an approved integration with a distinct read quota.

The next artifact is the authorized sustained run's completed result. Do not describe 4, 8, or 16 requests/second as a verified Wplace quota or guaranteed production ceiling.
