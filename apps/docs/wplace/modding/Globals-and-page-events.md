---
title: Globals and page events
description: The globals wplace.live adds to window, the custom events it fires, and the global names a mod should never use.
order: 11
tags: [source/caelestis, source/client, pawtect/flag]
---

**Pawtect:** flag risk. Pawtect's bot check looks for globals that automation tools leave on `window` and `document`. A mod global with one of those names makes your users look like a bot. Keep mod state in a closure or module.

## Wplace's globals

A fresh signed-out load on 26 November 2026 added these to `window`:

| Global | What |
| --- | --- |
| `__sveltekit_{hash}` | SvelteKit's boot data. The suffix changes with every build (`__sveltekit_18ydsqi` on 26 November, `__sveltekit_ht8ola` on 20 November). |
| `__svelte` | Svelte's runtime marker |
| `Capacitor` | Best guess: the Capacitor bridge, for Wplace's mobile apps |
| `pwaInstallPrompt` | The deferred install prompt, from an inline script |
| `__cfBeacon` | Cloudflare Web Analytics |

None of them is the map, the state or an API. The map and state are reachable only by catching them at startup ([Finding the map](Finding-the-map), [WplaceState](Wplace-state)).

## Names to avoid

Wplace's client bundles [BotD](https://github.com/fingerprintjs/BotD), which reports a bot when it finds globals that automation tools leave behind. Most are tool-specific names no mod would choose. A few are short generic names that a mod can hit by accident: `emit`, `spawn`, `geb` and `webdriver` on `window`. Don't use them as global names. Pawtect also checks for known Wplace bots. Which signals it uses for that is not visible in the client ([Anti-cheat](Anti-cheat)).

A debug handle on `window` under a name of your own, such as Caelestis's `__caelestis`, is not on these lists. It is still visible to every script in the page.

## Page events

| Event | Target | Meaning |
| --- | --- | --- |
| `wplace:online` | `window` | The client is back online. Wplace's own pollers refresh on it. |
| `storage` with `key === 'wplace:controls:v1'` | `window` | Another tab changed the key bindings |
| `vite:preloadError` | `window` | A module failed to preload. Usually a deploy happened mid-session. |
| `controllerchange` | `navigator.serviceWorker` | A new service worker took over. Wplace re-sends its draft. |

Listening to these is safe. Dispatching `wplace:online` yourself makes Wplace refetch, which costs your users API requests ([Rate limits](Rate-limits)).

## Related

- [Storage keys](Storage-keys)
- [Pawtect safety](Pawtect-safety)
- [Live notifications](Live-notifications)
