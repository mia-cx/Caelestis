# Backend task: two review findings on PR #362

Repo: this worktree, branch `t3code/add-collaborative-websocket-editing`. Do NOT commit or stage.
Only touch `apps/backend` (and `packages/wire-schema` only if a schema needs it). Report per finding
what changed and the exact verification commands and results.

## 1. Stale sessions are never expired without another client's message

`apps/backend/src/presence-object.ts`: `armTick()` schedules one tick `PRESENCE_TICK_MS` after a
change, and `tick()` drops sessions older than `PRESENCE_STALE_MS` but never schedules a later
check. A client that goes half-open (no close frame) is only removed if some other client sends
something after the stale deadline. In an otherwise idle room it stays in the headcount and holds
room and per-client capacity forever.

Fix with a hibernation-compatible Durable Object alarm: after each tick (and on attach), set
`this.state.storage.setAlarm(oldestLastSeenAt + PRESENCE_STALE_MS)` when any socket exists (do not
move an earlier alarm later), and implement `alarm()` to run the stale sweep and re-arm for the
next oldest session. Keep `setTimeout` ticks for deltas as they are. Test: attach one client,
advance time past `PRESENCE_STALE_MS` with no messages from anyone, fire the alarm, and assert the
socket is closed with 1000 'presence stale' and the room is empty. Use the existing DO test harness
in `presence-object.test.ts` (check how it fakes `state.storage`; extend the fake with
`setAlarm`/`getAlarm`/`deleteAlarm` if missing).

## 2. A document that claims no pixels is accepted

`apps/backend/src/work/regions.ts` (validation near line 51): the checks require an `add` item,
but an all-zero raster add, or a shape followed by an identical subtract, yields zero claimed
pixels and is persisted as an invisible region that still shows in lists and takes a slot. The
userscript's editor can produce the cancelling case normally.

Fix: after the existing bounds/area checks, rasterise with `regionDocumentPixels` (shared; this
already happens or is cheap at this point, check) and reject with 400 `{ error: 'Region claims no
pixels' }` when the count is 0 or the result is null. Tests: a rectangle plus an identical
subtract is rejected; an all-zero `pixels` item is rejected; a normal document still saves.

## Verify before reporting

```
pnpm --filter @caelestis/backend test
pnpm --filter @caelestis/backend exec tsc -p tsconfig.json
pnpm biome check apps/backend
```

Use the installed pnpm binary directly if the launcher refuses. Report exact commands and results.
