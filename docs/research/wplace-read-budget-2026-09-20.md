# Wplace read budget

Investigated September 20, 2026 for [issue #492](https://github.com/mia-riezebos/Caelestis/issues/492).

**The bounded run completed 100 requests with 90 HTTP 200 and 10 HTTP 304 responses. No numerical Wplace read quota has been verified.** The one-request/second phases succeeded with one request in flight. This does not establish a sustained production budget. Keep issue #492 open.

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

## Completed calibration

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

The result establishes a short successful additional workload on the selected shared IPv4. It does not establish the IP's total rate, headroom, sustainable quota, or whether endpoint counters are shared. Repeated tile reads covered four fixed paths; cache warmth and path diversity differ from a wide monitoring scan. No concurrency or burst phase ran. No 429 occurred, so cooldown duration and recovery remain unmeasured.

The durable artifacts are [attempts.jsonl](wplace-read-budget-2026-09-20/attempts.jsonl), [summary.json](wplace-read-budget-2026-09-20/summary.json), and the [probe](wplace-read-budget-2026-09-20/probe.mjs). The log retains only allowlisted response headers and timing/status/size metadata. It contains no response bodies, cookies, authorization headers, or the source egress IP. `remoteIp` is the public destination address. The probe discards response bodies rather than saving pixel identities.

The preserved probe matches the executed workload, with one portability change: `WPLACE_BUDGET_OUTPUT_DIR` can override its original output directory. Inspect the schedule without network requests using `node docs/research/wplace-read-budget-2026-09-20/probe.mjs --dry-run`. An authorized rerun must select a fresh existing output directory and retain the agreed caps; rerunning would add traffic to the shared egress.

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

No captured response containing `RateLimit-*`, `X-RateLimit-*`, or a verified numeric `Retry-After` was found in the searched public evidence. Code that reads a header does not prove the server always sends it.

## Budget design supported by current evidence

Use one configurable request ceiling for tile monitoring, attribution, and retries leaving the same egress. This is a conservative application policy, not a claim about Wplace's implementation. Coordinate that ceiling across every Caelestis process sharing the egress. Keep per-route counters so later evidence can justify separate limits.

Count every network attempt, including retries and conditional requests, until evidence supports another rule. Deduplicate overlapping tile requests and pending pixel lookups. Reuse fresh client-fed tile observations before scheduling server fetches. Attribution consumes the remaining explicitly allocated budget; changing the polling interval must not silently increase the combined request rate.

A 429 should extend a shared cooldown until at least the server's `Retry-After` deadline. No other worker should continue spending that assumed shared budget. Handle absent or malformed headers with bounded backoff. Authentication failures and challenges need separate classification. A successful response after cooldown proves recovery for that request, not a universal reset period.

The steady demand calculation is `tile attempts/second + attribution attempts/second + other attempts/second`. Reserve headroom below a measured operating range. Do not choose a numerical production ceiling from the scanner defaults above.

## Calibration method and further measurements

The selected first pass used the Mac's shared IPv4, 100 attempts, concurrency one, and a 20-minute cap. The completed phases above replace the earlier unexecuted 120-attempt proposal. No optional burst requests or recovery controls were used. The probe stopped on any unexpected status or challenge and had no automatic retries.

Before a longer run, measure or account for existing Caelestis requests sharing this IP. Otherwise the experiment can measure only additional traffic, not the aggregate ceiling. Record the selected workload, endpoint hostnames, authentication state, coordinates, maximum attempts, duration, and stop conditions. The current log already captures exact public coordinates and request timing.

Further work should answer the remaining questions without silently escalating the completed workload:

1. Count background tile, attribution, and other Wplace attempts across processes on this egress.
2. Choose a longer bounded observation at an agreed aggregate rate below a proposed operating ceiling. Report the duration explicitly.
3. If concurrency or burst behavior matters, give it a separate bounded schedule rather than combining it with sustained-rate changes.
4. Revisit endpoint separation only when headers, operator information, or controlled observations can distinguish shared enforcement.

Stop at the first 429 and respect its cooldown. End the phase instead of retrying through the limit. Stop on authentication failure, challenge, unexpected server errors, or increased load on the chosen host. A recovery request after cooldown requires remaining allowance and inclusion in the selected schedule. Retries count toward the cap. End at either the request cap or elapsed-time cap.

For every attempt, record start/end time, route class, in-flight count, status, bytes, and relevant headers. Include `Retry-After`, quota headers if present, `Cache-Control`, `Age`, `ETag`, `Last-Modified`, `Date`, and CDN cache status when supplied. Distinguish a changed tile from a newly delivered stale snapshot. Record scheduled and actual spacing.

The completed short pass exposed response behavior without finding an unsuitable rate. It cannot establish minute/hour/day limits or a sustainable production ceiling. Its clean result means only that the recorded workload succeeded in that context. Any longer observation needs another bounded schedule. Do not keep increasing traffic until a threshold appears.

Separate-versus-shared enforcement remains inconclusive if all phases succeed. Stronger evidence would require explicit quota counters, an operator statement, or carefully controlled cross-route observations. Do not infer IP/account enforcement by rotating identities or addresses. A single fixed context cannot resolve those dimensions.

## Completion criteria and unknowns

Issue #492 remains unresolved because the successful short workload does not establish a sustained aggregate budget. The shared IPv4 is now known, but background traffic and headroom are not. A follow-up must connect the measured aggregate workload and observation duration to an operating recommendation, or obtain an explicit Wplace quota.

Still unknown:

- Numerical burst and sustained limits, concurrency constraints, and their time windows.
- Enforcement by IP, account, route, hostname, or combinations, including whether tiles and attribution share counters.
- Accounting for cached responses, conditional requests, 304s, failures, and retries.
- Header availability, cooldown behavior, and variation by server egress or time.
- Whether Wplace offers an approved integration with a distinct read quota.

The next measurement is the existing traffic on the shared egress, followed by a selected longer schedule if needed. Do not describe one request/second as a verified Wplace quota or guaranteed production ceiling.
