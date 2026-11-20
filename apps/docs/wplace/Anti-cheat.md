---
title: Anti-cheat
---

Wplace's client-side anti-cheat is called Pawtect. This page lists what it reads from your browser, what it sends, and which actions set a flag on your account. It is for players who want to know what the site collects, and for mod authors who want to keep their users from being flagged by mistake.

The page describes behaviour only. It does not explain how to forge, hide from, or get around any of it.

It is based on a reading of the wplace.live web client from 20 November 2026 (bundle `Bx5qbGTA`, WASM `Cd8ln05J`). Nothing was run. Wplace can change any of this at any time. Server-side scoring is invisible to the client, so this page only names it.

## How it works

Pawtect is a Rust module compiled to WebAssembly. It loads when the page starts. If it fails to load, the Paint button refuses to paint.

For each protected request, Pawtect builds an encrypted token and the client sends it in an `x-pawtect-token` header. The token is tied to the request body by a SHA-256 hash, so a token only fits the request it was made for. These requests carry one:

- `POST /paint`
- alliance draft and headquarters paints
- `POST /report/alliance`
- `POST /report/appeal` (ban appeals)

Pawtect also replaces `window.fetch` with a wrapper. The wrapper changes no request. It records every absolute URL fetched through the page's `fetch`, keeps up to 64 of them, and adds them to the next token. The wrapper reports itself as native code to `fetch.toString()`.

## What it collects

Every token carries:

- your Wplace user id and linked Discord id
- a FingerprintJS device hash. The raw fingerprint (fonts, canvas, audio, WebGL, screen, timezone, languages, hardware) stays in the browser, and only the hash is sent.
- `navigator.webdriver`, read twice: once by the page and once inside the WASM
- whether any synthetic click, touch or pointer event reached the map
- the integrity flags (next section)
- the bot type, when FingerprintJS BotD detects an automation framework
- whether Cloudflare has challenged the session as likely automated
- whether globals left by automation tools are present on `window`
- the name of a known Wplace bot, when one is detected
- window width validity, `document.hasFocus()`, and screen width and height
- the time, and the SHA-256 of the request body
- the hosts or URLs recorded by the fetch wrapper

The server also logs each paint's IP address, country, network (ASN), and whether the address belongs to a VPN or a datacenter.

FingerprintJS sends a monitoring ping to `m1.openfpcdn.io` on about 1 in 1000 page loads.

## Flags

Pawtect keeps a set of integrity flags for the life of the page. Once set, a flag stays set until you reload, and it rides along on every token.

| Flag | Set when |
| --- | --- |
| Untrusted paint hold | A script sends the key or mouse button for paint-hold or erase-hold. |
| Untrusted pointer | A script moves the mouse while a paint-hold, erase-hold or drag-paint is active. |
| Untrusted palette | A script clicks a palette colour. |
| Untrusted paint submit | A script clicks the Paint button. |
| Tampered response | A backend API response reaching the page has its `json` or `text` method replaced, or throws when inspected. |
| Tampered profile limits | Your `/me` profile claims an unlimited number of favourite locations. |

"A script" means an event with `isTrusted` set to false: anything sent with `dispatchEvent` or `.click()` rather than by your hand. Other clicks on the page are not checked.

## Multi-account check

Pawtect remembers the last account that painted on this browser. It stores that account in four places: a `localStorage` entry, a `sessionStorage` entry, a one-year cookie, and memory. The names look like UI preferences: `ui_layout_v3`, `nav.cursor` and `_pf_uid`. Every 500 ms the page restores a deleted copy from the others.

When you press Paint, the client checks those records. If a different account painted from this browser in the last 24 hours, it refuses to paint and warns you about multi-accounting. The check runs in the browser itself. Wplace's rules also warn that family members sharing a computer can be flagged.

## Challenges

The server decides when to challenge you. It answers a paint, report or appeal with `403 { "error": "challenge-required", "tier": n }`, and the client runs the challenge and retries. The tiers, from lightest to heaviest:

1. **Proof of work.** Your browser computes a hash puzzle in the background. It takes at most 2 minutes.
2. **Cloudflare Turnstile.**
3. **hCaptcha.**
4. **Phone verification**, by SMS, Telegram or WhatsApp. VPNs and some regions are refused.

A Cloudflare challenge on any API request triggers Turnstile and marks the session as likely automated for every later token, even after you pass.

When the server answers `verification-required`, the client also runs Fingerprint Pro, a commercial fingerprint, and sends its sealed result to `/anticheat/verify`.

Two blocks come with no challenge: requests through Tor, and requests whose token fails verification ("Your request couldn't be verified").

The iOS app adds Apple device attestation. None of that runs in a web browser.

## Server-side signals

The staff dashboard ships inside the public client, so its labels show how the server scores accounts. The scoring itself is not visible.

- Signals fall into categories: behavioural, device, network, Pawtect, captcha, identity, reports and manual.
- An hourly scan scores the last 12 hours of signals. A higher score raises the challenge tier, and a score past a threshold bans automatically.
- Accounts link when they paint from the same device fingerprint and the same home IP. A shared IP alone raises the challenge tier but never counts toward a ban. VPN and datacenter addresses are left out of linking.
- Detection of a known Wplace bot bans the account on its own.
- Staff tools highlight challenges solved in under 30 seconds.

## For mod and userscript authors

Each item below is something that plausibly flags the people who use your mod.

1. **Don't send synthetic input to Wplace's controls.** Calling `.click()` or `dispatchEvent` on the Paint button, palette colours or the map sets the flags above, and they stay set until reload. If your mod needs an action, ask the player to press the real control.
2. **Don't patch backend API responses.** Replacing `json` or `text` on a `Response` from `/me`, `/paint` or any other API call sets "tampered response". Map tiles are not checked this way.
3. **Don't edit `/me` profile values**, such as the favourite-location limit.
4. **Know that the page's `fetch` reports where it goes.** Any absolute URL fetched through `window.fetch` after Pawtect loads goes into your users' next paint token. Your mod's own server shows up there.
5. **Keep your state off `window`.** Pawtect looks for globals left by automation tools and known bots. Keep mod state in a closure or module.
6. **Leave the multi-account records alone.** Don't write to or clear `ui_layout_v3`, `nav.cursor` or `_pf_uid`. A "reset storage" button can look like an attempt to dodge the multi-account check.
7. **Never automate or pre-answer challenges.** Leave every challenge to the player.
8. **Test in a normal browser.** WebDriver, headless browsers and similar environments set `navigator.webdriver` or BotD detections.

A read-only overlay that draws on its own layer, and touches none of the above, sets no client-side flag.
