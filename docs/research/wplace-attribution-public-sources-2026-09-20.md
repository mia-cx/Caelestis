# Wplace attribution from public sources

Investigated September 20, 2026. This report covers public documentation, published client libraries, and Wplace staff statements. It does not include live API probes or browser inspection.

**Wplace has direct attribution history internally. I found no published public batch-read API, event stream, or sanctioned request quota.** Wplace staff explicitly describe Wayback as staff-only. Third-party public tools still retrieve attribution one pixel at a time. Absence from these sources does not prove that another endpoint does not exist.

## First-party evidence

On January 15, 2026, WplaceStaff announced Wayback. It lets staff inspect who painted pixels and when, including the surrounding area. The announcement explicitly says regular users cannot see it. This establishes an internal attribution capability, but offers no public endpoint, schema, or access program. [Wplace staff announcement](https://www.reddit.com/r/WplaceLive/comments/1qdc9jb/website_discord_updates/)

An earlier WplaceOfficial developer comment describes a custom binary log containing placed pixels. The developer cautioned that complete restoration was uncertain. That comment does not specify record fields or promise public access. [Developer comment about the binary log](https://www.reddit.com/r/WplaceLive/comments/1n1r2ic/comment/nb5u3nu/)

The same older discussion says moderators lacked a per-user pixel timeline then. The later Wayback announcement supersedes that limitation. Do not use the older comment to describe current moderation capabilities. [Earlier moderation limitation](https://www.reddit.com/r/WplaceLive/comments/1n1r2ic/comment/nb8dqeu/)

No official API reference or numerical read quota appeared in the searched first-party sources. Staff list `contact@wplace.live` as a contact channel. A bounded attribution export or read-only integration is a concrete request, though no source promises that Wplace offers it. [Staff contact statement](https://www.reddit.com/r/WplaceLive/comments/1qdc9jb/website_discord_updates/)

## Public client implementations

These repositories are primary sources for their own implementations, but they are independent reverse engineering of Wplace. They are not Wplace documentation. Their age matters.

| Source inspected | Latest commit inspected | Relevant behavior |
| --- | --- | --- |
| [j0code/wplace-api](https://github.com/j0code/wplace-api/tree/39614e3dd75dfd64a4a4476b7650f45702cedd88) | September 22, 2025 | Separate single-pixel metadata and PNG tile reads |
| [lin-alg/Wplace_Map_Inspector](https://github.com/lin-alg/Wplace_Map_Inspector/tree/91779c68cad80096661dff45e0bd49a4e32ac1eb) | December 4, 2025 | Region sampling implemented with individual requests |
| [TeamRealB/Wplace-Protocol](https://github.com/TeamRealB/Wplace-Protocol/tree/f8eec7942bff45978dadde0eddc92648067495b2) | September 20, 2025 | Describes single-pixel reads and batched painting |

The j0code route table defines `GET /s0/pixel/{tileX}/{tileY}?x={x}&y={y}` for metadata. Its tile route is `GET /files/s0/tiles/{tileX}/{tileY}.png`. The implementation decodes tiles as PNG images and requests one coordinate pair in `getPixel`. There is no batch metadata method in this snapshot. [Route definitions](https://github.com/j0code/wplace-api/blob/39614e3dd75dfd64a4a4476b7650f45702cedd88/src/routes.ts#L5-L17), [implementation](https://github.com/j0code/wplace-api/blob/39614e3dd75dfd64a4a4476b7650f45702cedd88/src/main.ts#L70-L113)

Its documented pixel response has `paintedBy` and `region`. The painter includes a user ID, name, alliance fields, and equipped flag. The example contains no event ID, painting timestamp, or history array. This example alone cannot establish the full current schema. [Response example](https://github.com/j0code/wplace-api/blob/39614e3dd75dfd64a4a4476b7650f45702cedd88/Wplace%20API.md#L14-L37)

TeamRealB describes a `POST` accepting multiple coordinates and colors. This paints pixels; it does not read their attribution. Its random-tile route returns coordinates, while leaderboard routes return aggregate counts. None of those described responses provides an area's pixel-to-user mapping. [Protocol descriptions](https://github.com/TeamRealB/Wplace-Protocol/blob/f8eec7942bff45978dadde0eddc92648067495b2/README_EN.md)

## Sampling and rate-limit evidence

Map Inspector selects a grid using `stepX` and `stepY`, then shuffles those coordinates. Each coordinate gets its own single-pixel request. Its “batch” groups concurrent client requests; it is not a server batch API. [Coordinate generation](https://github.com/lin-alg/Wplace_Map_Inspector/blob/91779c68cad80096661dff45e0bd49a4e32ac1eb/main.js#L275-L299), [request and batching code](https://github.com/lin-alg/Wplace_Map_Inspector/blob/91779c68cad80096661dff45e0bd49a4e32ac1eb/main.js#L312-L376)

That script defaults to four workers and six requests per second. It reacts to 429/403 responses with delays and reduced throughput. These values are author-selected defaults, not Wplace-approved quotas. Its implementation is evidence that public attribution scanners manage request volume, not evidence that those defaults avoid limits. [Configuration](https://github.com/lin-alg/Wplace_Map_Inspector/blob/91779c68cad80096661dff45e0bd49a4e32ac1eb/main.js#L183-L211), [retry behavior](https://github.com/lin-alg/Wplace_Map_Inspector/blob/91779c68cad80096661dff45e0bd49a4e32ac1eb/main.js#L354-L368)

The j0code client separately handles 429 responses using `Retry-After`, falling back to 20 seconds. This supports honoring server backoff, but does not establish that every response supplies that header. [429 handling](https://github.com/j0code/wplace-api/blob/39614e3dd75dfd64a4a4476b7650f45702cedd88/src/main.ts#L142-L161), [fallback setting](https://github.com/j0code/wplace-api/blob/39614e3dd75dfd64a4a4476b7650f45702cedd88/src/main.ts#L190-L203)

## What follows from this evidence

Direct access is the strongest route if Wplace grants a suitable integration. Ask for a bounded rectangle or changed-coordinate lookup with painter IDs, color, event time, and a version or cursor. Request an explicit quota alongside it. This is a proposed integration contract, not a discovered public API.

Sampling is feasible with existing public reads. Sampling changed pixels would reduce requests relative to scanning entire regions. It would estimate the visible last-painter distribution, not reconstruct every paint event. A later repaint can replace the painter before lookup. Multiple changes between image snapshots can disappear from the diff. Those limits follow from sampling current state rather than consuming an event log.

For estimates, preserve sampled observations separately from inferred counts. A connected same-color patch is not proof that one person painted it. Random samples within each changed region support uncertainty estimates better than assigning an entire patch after one lookup. No sampling schedule can guarantee zero rate limits without a server-provided quota.

## Remaining unknowns

- Whether current non-staff endpoints accept bulk coordinates or expose author metadata outside the known pixel lookup.
- Whether any operator-supported integration, attribution export, or event subscription exists.
- The current request budget, scope of enforcement, and server cache behavior.
- The completeness and retention of historical attribution available through internal tooling.

Live first-party client inspection belongs in the companion investigation. It can resolve endpoint and format details absent from these older public libraries.
