---
title: Keyboard input
description: How Wplace handles keys, its rebindable controls and the Space paint hold, and how a mod adds shortcuts without tripping the anti-cheat.
tags: [source/caelestis, pawtect/flag]
---

**Pawtect:** flag risk. A synthetic key event for paint-hold or erase-hold sets **Untrusted paint hold**. Listening to the player's real keys, and stopping them, sets nothing.

## Wplace's controls

Wplace has rebindable controls. The defaults found in the client on 26 November 2026:

| Control | Default keys | Where |
| --- | --- | --- |
| `paint-hold` | `Space` | World map, studio, headquarters, avatar. Held: paints along every pointer move. |
| `undo` | `Mod+Z` | Paint drawer |
| `redo` | `Mod+Shift+Z`, `Mod+Y` | Paint drawer |
| `zoom-in` | `=`, `+` | |
| `zoom-out` | `-`, `_` | |
| `fit` | `0` | Studio and headquarters editors |
| `map.rotate-left`, `map.rotate-right` | `Shift+ArrowLeft`, `Shift+ArrowRight` | World map. Turns the bearing 15° each press. |
| `map.reset-rotation` | `N` | World map. Turns north back up. |

`Mod` is Ctrl, or ⌘ on Apple devices. There are more tool controls than this table lists. A player's own bindings are kept in `localStorage['wplace:controls:v1']` as `{ userId, dirty, bindings }`, synced to their account ([Get control bindings](api/me/Get-control-bindings)), and re-read on the `storage` event ([Storage keys](Storage-keys)).

Wplace ignores keys while focus is in a text field: an `input` that is not a checkbox, radio or button, a `textarea`, a `select`, or a `contenteditable` element. It also reserves browser shortcuts such as `Mod+R` and `F5`.

## Adding your own shortcuts

Listen on `window` in the capture phase, so you see keys before Wplace does. Check the same text-field rule. Pick keys Wplace doesn't bind, and remember players can rebind theirs.

```ts
const TEXT_FIELD = 'input:not([type="checkbox"], [type="radio"], [type="button"], [type="submit"], [type="reset"]), textarea, select, [contenteditable]:not([contenteditable="false"])'

window.addEventListener('keydown', (event) => {
  if (event.composedPath().some((node) => node instanceof Element && node.matches(TEXT_FIELD))) return
  if (event.code !== 'KeyO' || !event.altKey) return
  event.preventDefault()
  event.stopImmediatePropagation()
  toggleMyOverlay()
}, true)
```

Stopping a key the player pressed is safe: Wplace never sees it. Sending Wplace a key it did not get from the player is not. A `KeyboardEvent` you construct has `isTrusted` false, and Wplace's paint-hold listener flags it.

## The paint target after a camera move

Wplace paints at the last mouse position it received. If a mod moves the camera under a still mouse, the next Space press paints where the mouse pointed before the move. Caelestis holds back Space presses until the player's mouse moves again, and dispatches nothing ([`paint-target-guard.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/paint-target-guard.ts)). If your mod moves the camera, consider doing the same, so your users don't paint where they did not mean to.

## Caelestis and this note

Caelestis's shortcuts ([`keyboard-shortcuts.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/keyboard-shortcuts.ts)) follow the pattern above. Features that would send input to Wplace's controls are off by default, each behind a setting that names the flag it trips ([`simulated-input.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/simulated-input.ts)).

## Related

- [Reading the paint UI](Reading-the-paint-UI)
- [Pawtect safety](Pawtect-safety)
