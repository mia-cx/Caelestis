---
title: Storage keys
description: The localStorage, sessionStorage, cookie and IndexedDB keys wplace.live uses, what each holds, and which ones a mod must never touch.
order: 10
tags: [source/caelestis, source/client, pawtect/flag]
---

**Pawtect:** flag risk. Writing to or clearing the multi-account records, `ui_layout_v3`, `nav.cursor` and `_pf_uid`, can look like dodging the multi-account check. Leave them alone, and never offer a "clear Wplace storage" button. Other keys are not part of any token.

Read on the live client on 26 November 2026, signed out, with a fresh profile. Keys marked "code" come from the client code and appear only after the matching action.

## localStorage

| Key | Holds | Seen |
| --- | --- | --- |
| `theme` | `custom-winter` or `dark` ([Theme](Theme)) | Live |
| `PARAGLIDE_LOCALE` | The chosen locale ([Message catalog](Message-catalog)) | Code |
| `muted`, `haptics` | `0` or `1` | Live |
| `wplace:controls:v1` | Key bindings: `{ userId, dirty, bindings }` ([Keyboard input](Keyboard-input)) | Live |
| `template-overlays` | Wplace's own overlay list, as JSON | Code |
| `overlay-tag-catalog` | Tags for those overlays | Live |
| `overlay-pixel-mode`, `overlay-persistent-storage-status` | Overlay settings | Code |
| `alliance-asset-editor:brush-size` | Brush size in alliance editors | Code |
| `last_seen_patch_version` | The last patch notes shown | Code |
| `wplace:visitor-id`, `wplace:visit-sent`, `wplace:touches`, `wplace:touch-sent` | Anonymous visit tracking | Live |
| `wplace_onboarding_experiment` | The onboarding experiment and its visitor id | Live |
| `wplace_onboarding_done` | Whether the player finished onboarding | Code |
| `wplace_profile_picture_draft`, `wplace_reopen_edit_profile` | A profile picture being drawn, as a PNG data URL, and a flag to reopen the profile editor | Code |
| `wplace_fs_currency`, `wplace_fs_droplets`, `wplace_fs_prism`, `wplace_fs_gift`, `fscBackFromCheckout` | State of a FastSpring checkout in progress | Code |
| `wplace:reverse-debug` | `1` or `true` turns on debug logging in the staff area-reverse tool | Code |
| `ui_layout_v3` | **Multi-account record**, despite its name | Code |

## sessionStorage

| Key | Holds | Seen |
| --- | --- | --- |
| `nav.cursor` | **Multi-account record** | Code |

## Cookies

| Name | Holds | Seen |
| --- | --- | --- |
| `_pf_uid` | **Multi-account record**, kept one year | Code |
| `j` | The session cookie. The backend sets it at sign-in, and page code never touches it ([API reference](api/)). | Backend |


## IndexedDB

| Database | Holds | Seen |
| --- | --- | --- |
| `wplace-templates` | Wplace's overlay store, version 4: stores `personal-hq-overlays`, `images`, `editor-drafts` and `editor-documents` | Code |
| `wplace-hq-tiles` | Alliance headquarters tiles | Code |

Neither database existed on a fresh load. Wplace opens them when the player uses overlays or an alliance headquarters.

## Wplace's own overlays

`template-overlays`, `overlay-tag-catalog` and `wplace-templates` belong to Wplace's built-in overlay feature (see wplace.live's `/guides/overlays`). A mod that also manages templates can read these to show the player's existing overlays. Treat them as read-only: their format is private and changes without notice.

## Keeping your own data

- Prefix your keys, for example `mymod:`. Wplace's own keys have no common prefix.
- Don't put secrets in `localStorage`. Every script in the page can read it, including Wplace's. A browser extension can keep them in `chrome.storage`, and a userscript in `GM_*` storage. Caelestis keeps its server credentials out of page storage this way ([`storage-bridge/protocol.ts`](https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/storage-bridge/protocol.ts)).
- When the `localStorage` copy of the multi-account record goes missing, a 500 ms check restores it from a surviving copy ([Anti-cheat](Anti-cheat)). Don't remove them.

## Related

- [Globals and page events](Globals-and-page-events)
- [Pawtect safety](Pawtect-safety)
