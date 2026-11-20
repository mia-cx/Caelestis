import { warn } from './debug.js'
import { pageWindow } from './page-world.js'
import { MAP_CANVAS } from './wplace-dom.js'
import { type Catalog, useWplaceCatalog } from './wplace-messages.js'

/**
 * Wplace's own ES modules, found by their source and evaluated once Wplace has booted.
 *
 * Caelestis runs at `document-start`, and some of it evaluates Wplace's own code: the native
 * template store and the message catalog are found by `import()`ing Wplace's content-hashed chunks.
 * Those chunks read the message catalog at module top level, and the catalog is only there once
 * Wplace's `init` hook has awaited its own locale import. Evaluating such a chunk earlier throws, and
 * an ES module that threw during evaluation stays failed for the life of the document, so Wplace's
 * later import of the same chunk fails too and the map is never built (#416).
 *
 * `DOMContentLoaded` says nothing about any of this: it fires before Wplace's app has hydrated.
 * The MapLibre canvas does. Wplace only creates its map from a rendered page node, and the page
 * nodes are imported after `init` resolved, so once the canvas exists every chunk of Wplace's that
 * we might evaluate can be evaluated safely. There is deliberately no timeout: if Wplace never gets
 * as far as its map, evaluating its modules ourselves is exactly what must not happen.
 */

export type WplaceModule = Record<string, unknown>

const mapCanvasConnected = (): boolean => document.querySelector(MAP_CANVAS)?.isConnected === true

/** Resolves once Wplace's map canvas is in the document. */
const whenWplaceMapReady = (): Promise<void> =>
  new Promise((resolve) => {
    if (mapCanvasConnected()) {
      resolve()
      return
    }
    // The document node exists at `document-start`, before `<html>` does.
    const observer = new MutationObserver(() => {
      if (!mapCanvasConnected()) return
      observer.disconnect()
      resolve()
    })
    observer.observe(document, { childList: true, subtree: true })
  })

/** Wplace ships about 400 modules (October 2026); the cap only stops a runaway crawl. */
const MODULE_BUDGET = 2048

/** Wplace's module sources read so far, by URL, in the order they were read. */
const moduleSources = new Map<string, string>()
/** Module URLs found but not read yet, including any whose read failed. */
const unreadModules = new Set<string>()
/** The latest crawl. Each lookup crawls after it, so crawls never overlap. */
let crawled: Promise<void> = Promise.resolve()

/**
 * Read every Wplace module not read yet: those the page preloads or has loaded, and their imports.
 * The first crawl reads them all; later ones read only modules Wplace has loaded since.
 */
const crawlWplaceModules = async (): Promise<void> => {
  const page = pageWindow()
  const found = (url: string, base: string): void => {
    const parsed = new URL(url, base)
    // Resource entries include tiles and API calls; only Wplace's own modules spend the budget.
    if (
      parsed.origin === page.location.origin &&
      /^\/_app\/immutable\/(chunks|nodes|entry)\/.+\.js$/.test(parsed.pathname) &&
      !moduleSources.has(parsed.href)
    )
      unreadModules.add(parsed.href)
  }
  for (const link of document.querySelectorAll<HTMLLinkElement>('link[rel="modulepreload"]'))
    found(link.href, page.location.href)
  for (const entry of page.performance.getEntriesByType('resource'))
    found(entry.name, page.location.href)
  /** Reads that failed during this crawl. They stay unread, so the next crawl tries them again. */
  const failed = new Map<string, unknown>()
  const batch = (): string[] => [...unreadModules].filter((url) => !failed.has(url)).slice(0, 6)
  for (let urls = batch(); urls.length > 0 && moduleSources.size < MODULE_BUDGET; urls = batch())
    // Every read in a batch settles before the crawl moves on or ends, so none is read twice.
    await Promise.all(
      urls.map(async (url) => {
        try {
          const response = await page.fetch(url, { cache: 'force-cache' })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const source = await response.text()
          moduleSources.set(url, source)
          unreadModules.delete(url)
          for (const match of source.matchAll(/["']((?:\.\.\/|\.\/)[^"']+\.js)["']/g))
            found(match[1] ?? '', url)
        } catch (error) {
          failed.set(url, error)
        }
      }),
    )
  const [first] = failed
  if (first !== undefined)
    throw new Error(
      `Could not inspect Wplace modules: ${failed.size} unread, first ${first[0]}: ${String(first[1])}`,
    )
}

/**
 * Discover content-hashed Wplace modules by their source, without pinning filenames. Waits for
 * Wplace's map first, so evaluating them can never break Wplace's own boot.
 *
 * Every lookup shares one crawl of Wplace's modules: a later lookup reads only the modules Wplace
 * loaded since, such as an alliance page's chunks, and a read that failed is tried again. A failed
 * read fails the lookup only when the lookup is still missing a module it wants.
 */
export const findWplaceModules = async <Key extends string>(
  wanted: Record<Key, (source: string) => boolean>,
): Promise<Partial<Record<Key, { readonly module: WplaceModule; readonly source: string }>>> => {
  await whenWplaceMapReady()
  const crawl = crawled.catch(() => {}).then(crawlWplaceModules)
  crawled = crawl
  const failure = await crawl.then(
    () => null,
    (error: unknown) => error,
  )
  const keys = Object.keys(wanted) as Key[]
  const sources = [...moduleSources]
  const matches = keys.flatMap((key) => {
    const match = sources.find(([, source]) => wanted[key](source))
    return match === undefined ? [] : [{ key, url: match[0], source: match[1] }]
  })
  if (failure !== null && matches.length < keys.length) throw failure
  const found: Partial<Record<Key, { module: WplaceModule; source: string }>> = {}
  for (const { key, url, source } of matches)
    found[key] = { module: await import(/* @vite-ignore */ url), source }
  return found
}

/** Hand Wplace's active-catalog getter to the label lookups once its locale has loaded. */
export const installWplaceMessages = async (): Promise<void> => {
  const found = await findWplaceModules({
    locale: (source) => source.includes('PARAGLIDE_LOCALE'),
  }).catch((error: unknown) => {
    warn('Wplace modules unreadable; matching English labels', String(error))
    return null
  })
  if (found === null) return
  const getter = Object.values(found.locale?.module ?? {}).find(
    (value): value is Catalog =>
      typeof value === 'function' &&
      Function.prototype.toString.call(value).includes('initializeLocale() completed'),
  )
  if (getter === undefined) {
    warn('Wplace message catalog not found; matching English labels')
    return
  }
  useWplaceCatalog(getter)
}
