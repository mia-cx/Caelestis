# Wplace read budget

Investigated September 20, 2026 for [issue #492](https://github.com/mia-riezebos/Caelestis/issues/492).

**No numerical Wplace read quota has been verified.** Published clients supply useful leads, but no tested server-egress operating range exists yet. Keep the issue open. The test egress and bounded schedule still need selection before active calibration.

This report separates source findings, sparse browser observations, and proposed measurements. No load test ran. No production server was contacted for calibration.

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

These response observations come from this investigation, not an official contract. Temporary local inspection artifacts were retained at `/tmp/wplace-attribution-1i8GGp/`; they are not a durable public evidence archive. The [official patch notes](https://wplace.live/patch-notes) and searched first-party statements supplied no numerical read quota.

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

## Proposed bounded calibration

This is an unexecuted first-pass proposal. The issue requires choosing the egress and schedule before running it. A separate test server is preferable when production shares an IP or account. Testing this Mac measures this Mac's route and access context only.

Record the chosen host, egress identity, authentication state, endpoint hostnames, test coordinates, other known Wplace traffic, maximum requests, and stop conditions. Do not put cookies or authorization material in the report. Use a small, fixed set of public coordinates and avoid staff routes.

One candidate first pass allows at most **120 network attempts over 20 minutes**, with no automatic rate escalation. These are proposed experiment bounds, not known-safe Wplace limits:

1. Establish sparse baselines with ten tile reads and ten pixel reads, separately, spaced five seconds apart.
2. If baselines succeed, observe each route separately for twenty requests at one request/second, concurrency one.
3. Send twenty alternating tile/pixel requests at one combined request/second. Compare route behavior with the separate phases.
4. Use ten tile GET/conditional-GET pairs to inspect validators, freshness, bytes, and response status. Keep the same aggregate pacing. This cannot prove budget exemption unless quota evidence exists.
5. Only if the selected schedule includes concurrency testing, run four pairs of simultaneous requests. Space pairs to retain the same average rate. Reserve the remaining attempts for explicitly scheduled controls; unused allowance is not a reason to send more traffic.

Stop the phase at its first 429. Respect its cooldown and end calibration instead of retrying through the limit. Stop on authentication failure, challenge, unexpected server-error bursts, or increased load on the chosen host. A recovery request after cooldown requires remaining allowance and inclusion in the selected schedule. Retries count toward the cap. End at either the request cap or elapsed-time cap.

For every attempt, record start/end time, route class, in-flight count, status, bytes, and relevant headers. Include `Retry-After`, quota headers if present, `Cache-Control`, `Age`, `ETag`, `Last-Modified`, `Date`, and CDN cache status when supplied. Distinguish a changed tile from a newly delivered stale snapshot. Record scheduled and actual spacing.

This short pass can reject an unsuitable configuration and expose response behavior. It cannot establish minute/hour/day limits or a sustainable production ceiling. A clean run means only that the recorded workload succeeded in that context. Any longer observation needs another bounded schedule. Do not keep increasing traffic until a threshold appears.

Separate-versus-shared enforcement remains inconclusive if all phases succeed. Stronger evidence would require explicit quota counters, an operator statement, or carefully controlled cross-route observations. Do not infer IP/account enforcement by rotating identities or addresses. A single fixed context cannot resolve those dimensions.

## Completion criteria and unknowns

Issue #492 remains unresolved until an agreed test context yields a usable operating recommendation, or Wplace supplies an explicit quota. The follow-up report must state the workload duration, successful range, errors, cooldown evidence, and uncertainty. Headroom and endpoint allocations must follow that evidence.

Still unknown:

- Numerical burst and sustained limits, concurrency constraints, and their time windows.
- Enforcement by IP, account, route, hostname, or combinations, including whether tiles and attribution share counters.
- Accounting for cached responses, conditional requests, 304s, failures, and retries.
- Header availability, cooldown behavior, and variation by server egress or time.
- Whether Wplace offers an approved integration with a distinct read quota.

The next required input is the test egress and accepted bounded schedule. No production operating budget should be claimed from this report.
