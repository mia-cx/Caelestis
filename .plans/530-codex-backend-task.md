# Backend task: quick claims in the presence coordinator (issue #530)

Repo: pnpm monorepo, Caelestis. You work in your own git worktree. Someone else builds the
userscript half at the same time in another worktree.

Rules:
- Only edit files under `apps/backend/`. The wire contract in `packages/shared/` and
  `packages/wire-schema/` is fixed and committed; do not edit it.
- Do not run `git commit`, `git stash`, `git checkout`, or `git reset`. Leave your changes uncommitted.
- Run pnpm as `pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false <command>`, or call
  `node_modules/.bin/<tool>` directly. The sandbox has no network, so plain `pnpm` fails.
- Workspace packages are already built. If you change nothing outside `apps/backend/`, you do not
  need to rebuild them.

## Read first

1. `packages/shared/src/presence.ts`: `PresenceUpdate.quickClaims`, `PresencePeer.quickClaims`,
   `MAX_QUICK_CLAIMS`, `isQuickClaimList`. Import from `@caelestis/shared`.
2. `packages/wire-schema/src/index.ts`: `PresenceClientEvent` already accepts `quickClaims`
   (bounded count, each rect within `MAX_PRESENCE_REGION_PIXELS`).
3. `apps/backend/src/presence-coordinator.ts`: the whole file. Drafts are the closest model.
4. `apps/backend/src/presence/geometry.ts`: `presenceRectWithinSurface`.
5. `apps/backend/tests/api-boundary.test.ts` and `apps/backend/tests/runtime/portable.test.ts`: how
   tests open real presence WebSockets against the Node runtime.

## What quick claims are

A painter holds Ctrl and drags on the map while painting to mark rectangles as "mine for now".
They are session state, like the viewport and draft: they exist only while that presence session
is open. That is the whole point. They must disappear for everyone when the socket closes, errors,
or goes stale (`PRESENCE_STALE_MS`), with no SQL row, no TTL, and no cleanup message required.

## Build

In `apps/backend/src/presence-coordinator.ts`:

1. Store the session's quick claims in its `Attachment`, so they survive Durable Object
   hibernation. Cloudflare caps a serialized attachment at 2,048 bytes, so store them compactly
   (for example `[x, y, w, h]` tuples) and keep the total attachment under that limit with
   `MAX_QUICK_CLAIMS` rects and realistic other fields. Add a comment with the size reasoning.
2. On `presence-update`:
   - `quickClaims` absent: unchanged. `[]`: clear. A list: replace.
   - Ignore the quick claims from sessions that cannot write claims: `anonymous` or
     `credentialScope === 'read'` (read scope already returns early; keep anonymous out too).
   - Every rect must pass `presenceRectWithinSurface` for the session's surface. If any fails,
     ignore the whole message, the same way an out-of-surface viewport or draft is ignored today.
   - Do not quantise quick claims. They are exact pixel rectangles.
   - A change marks the session dirty and arms the tick, like a draft change.
3. In `peer()`, include `quickClaims` as `PresenceRect` objects only when the list is non-empty.
   Omit the key when empty, so payloads stay small and older clients are unaffected.
4. In `relevant()`, a peer is also relevant when any of its quick claims intersects the
   subscriber's padded interest, and its distance may use the nearest quick claim too.
5. Nothing else changes. Closing, staleness, and `drop()` already remove the session; confirm by
   test that its quick claims vanish for peers as a result.

## Tests

Add focused tests through the real presence WebSocket boundary, using the existing Node runtime
test setup. Cover:
- Painter A publishes two quick claims; painter B, whose viewport overlaps, receives them on A's peer.
- A sends `quickClaims: []`; B receives A's peer without `quickClaims`.
- A's socket closes while it holds quick claims; B receives A in `remove`.
- A peer whose only rect near B is a quick claim (viewport far away) is still relevant to B.
- Ignored input: an anonymous session's quick claims, a read-scope session's quick claims, and a
  list with one rect outside the world surface. B must not see them.
- One attachment with `MAX_QUICK_CLAIMS` rects at large coordinates, plus a 128-character display
  name and every other field populated, serializes under 2,048 bytes.

Keep each test to one meaningful failure it catches. Use the repo's existing helpers.

## Done when

- `node_modules/.bin/tsc --noEmit -p apps/backend/tsconfig.json` passes.
- Your new tests and the existing backend test suites you touched pass. Report the exact commands
  and results.
- `node_modules/.bin/biome check apps/backend` reports no new errors.

Report: files changed, what each test covers, commands run with results, and anything you were
unsure about.
