# Wplace pixel attribution

Investigated September 20, 2026, using Wplace's deployed client, read-only HTTP requests, and public sources.

Wplace already has bulk attribution and paint-history readers. The discovered readers belong to staff tools. I found no public equivalent. Public single-pixel attribution works without login, but it identifies the current painter without an event time or revision.

The strongest route is an operator-approved read-only integration with Wplace's existing attribution data. Sampling can estimate the painter distribution among changed pixels, with explicit uncertainty. It cannot reconstruct all paint events.

## Direct-source findings

| Reader | Data | Availability established |
| --- | --- | --- |
| `GET /s{season}/pixel/{tileX}/{tileY}?x={x}&y={y}` | One pixel's `paintedBy` and `region` | HTTP 200 without login |
| `GET /staff/tools/select-area/s{season}/{tileX}/{tileY}?x0=…&y0=…&x1=…&y1=…` | Rectangle of painter IDs and colours | Anonymous request returned 401; authenticated normal account returned 403 |
| `GET /staff/tools/wayback/s{season}/l{limit}/x{tileX}/y{tileY}/t{timestamp}` | Historical events, with pagination fields | Authenticated normal account returned 403 for a one-event request |
| `GET /files/s{season}/tiles/{tileX}/{tileY}.png` | Indexed colour image | HTTP 200; sampled PNG contains no attribution metadata |

Endpoint paths and decoding come from the deployed [API client, Dckshkh0.js](https://wplace.live/_app/immutable/chunks/Dckshkh0.js). These are observations, not an official API contract.

### Bulk attribution exists

The client method `getPixelAreaInfo` reads a binary response containing five bytes per pixel:

| Offset | Format | Meaning |
| --- | --- | --- |
| 0 | Little-endian unsigned 32-bit integer | Painter ID |
| 4 | Unsigned byte | Colour index |

The decoder returns parallel `paintedBy: Uint32Array` and `colors: Uint8Array` arrays. It does not decode a timestamp or event ID. Rectangle ordering and boundary semantics were not runtime-verified because access failed.

The client defines `staff.tools.select_area.info`. The [map module](https://wplace.live/_app/immutable/nodes/5.CgPEFaZq.js) gates area selection on staff permissions. The first four-pixel rectangle request returned `401 {"error":"Unauthorized","status":401}`, with `/me` also returning 401. After Mia logged back in, a fresh check returned 200 from `/me` and the public pixel lookup, but `403 {"error":"Forbidden","status":403}` from the same rectangle reader. This confirms denial for her authenticated normal account. No permission changes were attempted.

The same API client contains staff headquarters-area readers. Their compact format uses 13 bytes per pixel: painter ID, colour, and a 64-bit event ID. Those routes concern alliance headquarters, not the world canvas. They show that richer attribution snapshots already exist internally; they do not establish public access.

### History exists too

`getWaybackEvents` calls the staff Wayback route. Pagination uses `cursorTs`, `cursorUserId`, `cursorAllianceId`, and `cursorPixelsCount`. The client validates a maximum limit of 10,000. That is a client input limit, not a verified server quota or a guaranteed number of individual pixels returned.

The UI requires `staff.tools.wayback`. A request with limit 1 returned `403 Forbidden` after the normal account's login was confirmed. WplaceStaff's announcement describes who-and-when attribution for pixels and surrounding areas, explicitly limited to staff. [Wplace Wayback announcement](https://www.reddit.com/r/WplaceLive/comments/1qdc9jb/website_discord_updates/)

This gives an operator integration request a concrete starting point. Ask for a bounded, read-only rectangle or changed-coordinate reader, or an event cursor. Include painter IDs, coordinates, colours, event times, snapshot revisions, and an explicit request budget. No public access program was found.

### Public pixels, tiles, and streams

The public lookup returned `paintedBy` and `region`. Painter fields included ID, name, alliance information, and cosmetics. The sampled response contained no colour, paint timestamp, event ID, revision, or history array. The response was dynamic and supplied no rate-limit or retry headers.

The sampled world tile was 1000 × 1000 pixels, with an indexed 64-entry palette. Its only PNG chunks were `IHDR`, `PLTE`, `tRNS`, `IDAT`, and `IEND`. There was no ancillary owner metadata. This rules out attribution hidden in that sampled tile, not every possible Wplace asset format.

Observed tile responses advertised `cache-control: s-maxage=5, must-revalidate, no-store`, plus `ETag` and `Last-Modified`. Existing page traffic refreshed the tile at roughly six-second intervals during part of the observation. Those headers and timestamps describe tile delivery, not individual paint events. Faster polling cannot be assumed to yield equally fresh attribution-aligned snapshots.

Across 99 loaded first-party JavaScript modules, I found one `EventSource` constructor, for `/notification/stream`, and no `new WebSocket` constructor. The notification handler processes notification IDs and reset signals. No world paint-event subscription appeared in the inspected code or observed network events. Unloaded modules and undisclosed backend routes remain outside that conclusion.

The current `paint` method batches writes through `POST /paint`, carrying a season and tile-coordinate arrays. Older public protocol notes describe a different painting route. Neither write format is a bulk attribution reader. No painting requests were sent.

## Avoiding unnecessary attribution requests

Caelestis already observes submitted coordinates after Wplace acknowledges a paint, through `onAcceptedPaint` in [tile-transform.ts](../../apps/userscript/src/tile-transform.ts). [telemetry.ts](../../apps/userscript/src/telemetry.ts) attaches the local account identity and reports observations for connected coverage.

That can attribute participating clients' acknowledged submissions without extra pixel lookups. It remains client-reported evidence, not a server-signed global history. A partial acceptance count cannot identify which submitted pixels succeeded. The local exact-pixel retention path already rejects that ambiguity. This route does not cover users who are not reporting through Caelestis.

For public lookups, use one bounded request queue, deduplicate pending coordinates, and share results. Record observation times. A colour change invalidates a cached attribution, but unchanged colour does not prove unchanged ownership: a same-colour repaint is invisible in an image diff.

No official numerical read quota was found. Successful sparse requests do not establish a sustainable rate. Honour `Retry-After` when supplied, pause on 429, and use bounded backoff. Authentication failures and challenges require resolving access, not increasing retries. Client-side concurrency still consumes one request per pixel.

## Sampling fallback

Use the changed-pixel mask as the sampling population. This avoids spending requests on unchanged areas. Keep the objective explicit: estimate the current last-painter distribution of changed coordinates, not the count of all painting actions.

1. Keep acknowledged participating-client paint reports separate from sampled observations.
2. Partition changed coordinates into manageable spatial regions and time windows. Connectivity or colour can guide exploration, but does not establish common authorship.
3. Draw random samples within each region. A small first pass can reveal mixed ownership; spend more requests where the result matters or ownership varies.
4. Estimate each user's share using region sizes and the sampling probabilities. Store direct observations separately from inferred counts and keep unsampled regions unknown.
5. Use a fixed random audit sample to evaluate adaptive rules. Repeatedly sampling until a patch looks unanimous produces misleading confidence if treated like a fixed sample.

For example, eight random samples all naming one painter are weak evidence that the entire region belongs to them. If another painter owns 10% of the region, eight independent samples miss them with probability `0.9^8 ≈ 43%`. About 29 samples give a 95% chance of encountering a 10% minority. About 59 are needed for a 5% minority. These are large-population approximations, not a posterior probability of single authorship. Sampling without replacement uses the corresponding hypergeometric calculation.

For a region with 10,000 changed pixels, 29 lookups instead of 10,000 reduce attribution requests by 99.71%. They provide a sample, not 10,000 exact labels. Those 29 requests still need a permitted request budget.

Frequent diffs reduce the time available for intervening changes, but cannot remove these ambiguities:

- Another user can repaint between the tile snapshot and metadata lookup.
- Multiple paints between snapshots collapse to one visible change.
- A pixel can return to its previous colour, hiding every intervening paint.
- The public response lacks a timestamp or revision linking it to the sampled tile.

Checking tile state around a lookup can detect some races. It cannot prove that the observed painter caused a specific historical diff. Approximate regional statistics are defensible; exact credit for inferred pixels is not.

## Evidence and limits

Chromium.app was already running on debug port 9222. Inspection used a persistent CDP connection with `Emulation.setFocusEmulationEnabled({ enabled: true })`. It did not reload the active tab or change its account, drafts, or userscript.

A follow-up profile check confirmed the existing tab used Chromium's normal `Work` profile at `/Users/mia/Library/Application Support/Chromium/Default`. A fresh background tab initially showed `Log in` and returned 401 from `/me`. Mia explained that she had cleared browser data, then logged back in. A subsequent live check confirmed `/me` returned 200 and the staff rectangle reader returned 403. No temporary browser profile was used. Owned verification tabs were closed afterward.

The API module SHA-256 was `815ea2b21cbdbbf1c890148180d716a1c390ef37cf6bea1f00a39103a7e54a4e`. A fresh homepage fetch advertised the same entry and map bundles as the inspected tab. No loaded first-party scripts advertised source maps.

Initial explicit requests consisted of one public pixel lookup, one four-pixel staff-area lookup, one `/me` status check, one homepage fetch, and one PNG fetch. Follow-up checks verified the normal profile, repeated `/me`, and repeated the public pixel and staff-area reads after login. One authenticated Wayback request used limit 1. Existing page polling continued during inspection. This initial API inspection included no rate-limit load test or endpoint-name sweep. The later [bounded read-budget calibration](wplace-read-budget-2026-09-20.md) records 100 requests from the Mac's shared IPv4 and preserves the sanitized results.

Local inspection artifacts are in `/tmp/wplace-attribution-1i8GGp/`. They include downloaded client modules and an evidence JSON with response field names instead of the sampled painter's identity. Temporary artifacts may disappear. The source links, endpoint details, and relevant response facts above are the durable record.

[Companion public-source research](wplace-attribution-public-sources-2026-09-20.md) records pinned third-party implementations and first-party announcements. It distinguishes actual server batching from scanners that issue concurrent individual requests.

Mia chose to plan smart diff sampling alongside adaptive tile monitoring. [Design adaptive tile monitoring and diff-based painter attribution](https://github.com/mia-riezebos/Caelestis/issues/491) is the canonical Wayfinder map. Its decision tickets cover the measured request budget, client-fed tile cooldowns, contribution and grief-attribution semantics, and sampling/queue policy. Exact quotas and tuning values remain unresolved. A Wplace-approved bulk integration remains a possible alternative; no request has been sent.
