---
title: WplaceState
description: Wplace's app-wide Svelte state object, which holds the theme, language, open dialogs and the map, and how to catch it at startup.
tags: [source/caelestis, pawtect/flag]
symbol:
  kind: interface
  name: WplaceState
  signature: "interface WplaceState  // an anonymous class instance in a module closure"
  members:
    - { name: theme, kind: property, signature: "theme: string", description: "`\"custom-winter\"` (light) or `\"dark\"`. The setter updates `data-theme`, `localStorage.theme` and the map style together. See [[Theme]]." }
    - { name: language, kind: property, signature: "language: string", description: "The active locale, such as `\"en\"`. See [[Message-catalog|Message catalog]]." }
    - { name: map, kind: property, signature: "map: maplibregl.Map", description: "The same instance as [[Map|map]]." }
    - { name: playerSettingsOpen, kind: property, signature: "playerSettingsOpen: boolean", description: "Whether the Settings dialog is open." }
    - { name: playerSettingsTab, kind: property, signature: "playerSettingsTab: string", description: "The open Settings tab: `interface`, `accessibility`, `privacy`, `sounds`, and others." }
    - { name: storeDialogOpen, kind: property, signature: "storeDialogOpen: boolean", description: "Whether the store is open. `storeTabIndex` picks its tab." }
    - { name: muted, kind: property, signature: "muted: boolean", description: "Sound off. Mirrored to `localStorage.muted`." }
    - { name: haptics, kind: property, signature: "haptics: boolean", description: "Vibration on. Mirrored to `localStorage.haptics`." }
    - { name: now, kind: property, signature: "readonly now: number", description: "A clock the UI re-renders from. Getter only." }
    - { name: automatedClicks, kind: property, signature: "automatedClicks: boolean", description: "Turns true when a map `click`, `touchstart` or `pointerdown` arrives with `isTrusted` false, and stays true. It goes into every Pawtect token. Never write it." }
    - { name: captcha, kind: property, signature: "captcha: unknown", description: "Anti-cheat challenge state. Never write it." }
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-state.ts
---

**Pawtect:** flag risk. Reading the state sets nothing. `automatedClicks` and `captcha` belong to the anti-cheat, and `automatedClicks` rides along in every Pawtect token. Writing either is tampering with the anti-cheat. Leave them alone ([Anti-cheat](Anti-cheat)).

Wplace keeps its app-wide state on one class instance inside a module. Nothing exports it, and nothing puts it on `window`. Its setters are the same ones Wplace's own buttons call, so setting `theme` or `playerSettingsOpen` does what the button does.

The members above were on the instance's prototype on 26 November 2026. It also has the dialog flags `dropletsDialogOpen`, `prismDialogOpen`, `accountConflictDialogOpen`, `pendingHistoryDialogOpen` and `paymentHistoryDialogOpen`. The types of `muted`, `haptics` and `now` are inferred, not confirmed. The class and its module have minified names.

## Catching it

Wplace's bundle compiles each `#private` field to a `WeakMap`. The constructor registers the new instance with `WeakMap.prototype.set(this, value)`. A wrapper around `WeakMap.prototype.set` sees the instance as its first argument. Recognise it by shape: its prototype has a `theme` setter.

```ts
type WplaceState = { theme: string; [key: string]: unknown }

export const catchState = (onState: (state: WplaceState) => void): void => {
  const prototype = WeakMap.prototype
  const native = prototype.set
  const restore = () => { if (prototype.set === wrapped) prototype.set = native }
  const wrapped = function (this: WeakMap<object, unknown>, key: object, value: unknown) {
    try {
      const proto = Object.getPrototypeOf(key)
      if (proto && proto !== Object.prototype && Object.getOwnPropertyDescriptor(proto, 'theme')?.set) {
        restore()
        onState(key as WplaceState)
      }
    } catch {
      // Runs inside Wplace's constructors: never throw.
    }
    return native.call(this, key, value)
  }
  prototype.set = wrapped
  // Give up if the state never shows, so a changed build costs a wrapper for a few seconds.
  setTimeout(restore, 20_000)
}
```

Install it at document start, on the page's `WeakMap`. The state is built about 150 ms in ([Page load timeline](Page-load-timeline)).

## Stability

- The `WeakMap` trick depends on how the bundler compiles private fields. A build that uses native `#fields` breaks it. Keep a fallback.
- Accessor names are Wplace's own source names, not minified. They can still be renamed in any release.
- Setting a dialog flag opens Wplace's own dialog. Settings tabs also have URL routes: `/settings/{tab}` (unverified as a deep link).

## Related

- [Finding the map](Finding-the-map)
- [Theme](Theme)
- [DOM landmarks](DOM-landmarks)
