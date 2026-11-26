---
title: Message catalog
description: Wplace's Paraglide translations in 12 locales, where the language is stored, and how to read Wplace's labels in the player's language.
tags: [source/caelestis, pawtect/none]
symbol:
  kind: function
  name: getMessages
  signature: "getMessages(): Readonly<Record<string, string>>  // exported under a minified name"
  returns: { type: "Readonly<Record<string, string>>", description: "The active locale's messages, keyed by Wplace's message ids such as `paint`, `undo` and `close`. Throws until the locale has loaded." }
  throws: [{ type: Error, description: "`The message catalog was used before initializeLocale() completed`" }]
  source: https://github.com/mia-cx/Caelestis/blob/main/apps/userscript/src/wplace-modules.ts
---

**Pawtect:** none. Reading translations is invisible to Pawtect.

Wplace translates its UI with [Paraglide](https://inlang.com/m/gerre34r/library-inlang-paraglideJs) into 12 locales: `en`, `pt`, `ch`, `de`, `es`, `fr`, `it`, `jp`, `pl`, `ru`, `uk` and `vi`. Note `ch` for Chinese and `jp` for Japanese, not the ISO codes.

`getMessages` is a descriptive name. The real export is minified and changes between builds.

## Where the language comes from

1. `localStorage.PARAGLIDE_LOCALE`, if it holds one of the 12 codes.
2. Otherwise the first match in `navigator.languages`, by full tag and then by language.
3. Otherwise `en`.

The active locale is also [WplaceState](Wplace-state) `language`, and `<html lang>`. `PARAGLIDE_LOCALE` was not set on a fresh signed-out load on 26 November 2026, so it is written only once a player picks a language (best guess).

## Why a mod needs it

Wplace's buttons carry translated `aria-label`s: "Paint" reads "Peindre" in French. A mod that finds a control by its English label stops working for every player in another language. Look the label up in the catalog instead, and fall back to English.

## Reaching the catalog

The locale module is one of Wplace's content-hashed chunks. Find it by its source, not its file name: it contains the string `PARAGLIDE_LOCALE`. Import it, then pick the export whose source contains `initializeLocale() completed`. See [Importing Wplace's modules](Importing-Wplace-modules) for the crawl.

```ts
const getter = Object.values(localeModule).find(
  (value): value is () => Record<string, unknown> =>
    typeof value === 'function' && Function.prototype.toString.call(value).includes('initializeLocale() completed'),
)
const label = (key: string, english: string) => {
  const text = getter?.()[key]
  return typeof text === 'string' ? text : english
}
```

Import it only after the map canvas exists. Before that, the catalog has not loaded and the getter throws.

## Stability

- Message ids are Wplace's own source names and survive rebuilds. They can still be renamed.
- The error text the lookup matches is Wplace's own and could change with any release.
- The catalog chunks are large, about 500 KB each. Only the active locale loads.

## Related

- [DOM landmarks](DOM-landmarks)
- [Reading the paint UI](Reading-the-paint-UI)
