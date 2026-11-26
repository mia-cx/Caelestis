---
title: Theme
description: Where Wplace keeps its light and dark theme, the data-theme attribute, localStorage and the basemap style, and how to read or switch it.
tags: [source/caelestis, pawtect/none]
---

**Pawtect:** none. The theme is not part of any token. Caelestis's fallback clicks Wplace's Settings button and theme control from script. Those are not map clicks, so they do not set `automatedClicks` ([WplaceState](Wplace-state)), and no flag covers them.

Wplace has two themes: `custom-winter` (light) and `dark`. The theme lives in three places:

| Place | Value | Who reads it |
| --- | --- | --- |
| `document.documentElement` `data-theme` | `custom-winter` or `dark` | DaisyUI's CSS. Set by an inline script before first paint. |
| `localStorage.theme` | `custom-winter` or `dark` | The inline script on the next load |
| [WplaceState](Wplace-state) `theme` | `custom-winter` or `dark` | The app. Its setter updates both of the above and the map style. |

The basemap follows the theme: `https://maps.wplace.live/styles/liberty` for `custom-winter`, and `https://maps.wplace.live/styles/fiord` for anything else ([Map sources and layers](Map-sources-and-layers)).

## Reading it

```ts
const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark'
new MutationObserver(() => onTheme(isDark())).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
```

This works from any world, including an isolated content script.

## Switching it

The complete way is Wplace's own setter: catch the [WplaceState](Wplace-state) at startup and assign `state.theme = 'dark'`. That is what the Settings button does.

Without the state, setting the attribute and `localStorage.theme` changes the page's colours, but not the map style or Wplace's own idea of the theme. A mod would then also call `map.setStyle()` with the other style URL. Caelestis tries the setter first, then the visible control, then the Settings dialog hidden by a stylesheet, then the attribute and storage ([`wplace-theme.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-theme.ts)).

Wplace's setter calls `map.setStyle(url, { transformStyle })`. The transform carries Wplace's own sources and layers, and any non-canvas source you added, into the new basemap. Custom layers stay too. On 26 November 2026 a custom layer and an image layer both survived a switch each way. Still, check for your layers on `style.load` ([Drawing overlays](Drawing-overlays)).

## Other page-wide switches

| Attribute on `<html>` | Set by |
| --- | --- |
| `data-standard-ui` | Settings › Accessibility › Legacy UI |
| `data-native-cursor` | Settings › Accessibility › Use native OS cursor |
| `data-game-ui` | Present on game routes, absent on public pages |

Wplace's pixel cursors are CSS custom properties, `--cursor-default`, `--cursor-pointer` and so on, on `:root`. Its fonts are `--font-sans`, `--font-mono`, `--font-pixel` and `--font-pixel-display`. Caelestis overrides both through these properties ([`wplace-cursors.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-cursors.ts), [`wplace-font.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-font.ts)).

## Related

- [How Wplace renders the map](Map-rendering)
- [DOM landmarks](DOM-landmarks)
- [Storage keys](Storage-keys)
