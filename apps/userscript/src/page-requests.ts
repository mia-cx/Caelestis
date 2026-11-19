import { count } from './debug.js'
import { type InstalledValueHook, installValueHook } from './page-hooks.js'
import { captureFetchUrlGetters, isGetFetch, urlForFetchInput } from './wplace-raster.js'

/**
 * Wplace's own requests, observed from the one wrapper around the page's `fetch`.
 *
 * Routes say which requests they care about and see the responses Wplace receives. Nothing here
 * changes a request; only a route answering a tile may hand Wplace an equivalent substitute response.
 */

/** One page fetch, as the routes see it, read without re-running the page's own conversions. */
export interface PageRequest {
  /** The URL as the page passed it, before resolving against the document. */
  readonly raw: string
  readonly url: URL
  readonly input: unknown
  readonly init: RequestInit | undefined
  readonly realm: Window & typeof globalThis
  /**
   * Whether this is a GET, read without invoking the page's accessors again. Ask while the route
   * runs: native fetch consumes the request's init once it is sent.
   */
  readonly isGet: () => boolean
  /** The fetch beneath this observer, for a route's own side request. */
  readonly fetch: typeof globalThis.fetch
}

/** What a route does with a request it took: watch, or for a tile adapt, the response. */
export interface RequestObservation {
  /** The response Wplace is about to receive; return it, or an equivalent substitute. */
  readonly response?: (response: Response) => Response
  /** The request never produced a response: the native fetch threw or rejected. */
  readonly failed?: () => void
}

/** Called for every observable page request, before it is sent. Undefined ignores it. */
export type RequestRoute = (request: PageRequest) => RequestObservation | undefined

const routes = new Set<RequestRoute>()

/** Watch Wplace's requests through `route`. A route registered twice runs once. */
export const observePageRequests = (route: RequestRoute): (() => void) => {
  routes.add(route)
  return () => routes.delete(route)
}

const observe = (
  args: Parameters<typeof fetch>,
  realm: Window & typeof globalThis,
  urlGetters: ReturnType<typeof captureFetchUrlGetters>,
  beneath: typeof globalThis.fetch,
): RequestObservation[] => {
  const observations: RequestObservation[] = []
  // Snapshot only safely observable metadata before native fetch consumes mutable RequestInit
  // dictionaries. An accessor may delete itself while WebIDL reads it; inspecting afterward would
  // then mistake a HEAD request for the default GET.
  let request: PageRequest
  try {
    const raw = urlForFetchInput(args[0], realm, urlGetters)
    if (raw === null) return observations
    request = {
      raw,
      url: new URL(raw, realm.location?.href),
      input: args[0],
      init: args[1],
      realm,
      isGet: () => isGetFetch(args[0], args[1], realm, urlGetters),
      fetch: beneath,
    }
  } catch {
    // An unusual input that cannot be observed safely is simply unobserved.
    return observations
  }
  for (const route of routes) {
    try {
      const observation = route(request)
      if (observation !== undefined) observations.push(observation)
    } catch {
      count('fetch:route failed')
    }
  }
  return observations
}

const settle = (observations: readonly RequestObservation[]): void => {
  for (const observation of observations) {
    try {
      observation.failed?.()
    } catch {
      count('fetch:route failed')
    }
  }
}

/**
 * Wrap the page's fetch so the routes see Wplace's requests.
 *
 * The wrapper hooks the reads of the response it hands back, so a script that wraps fetch from
 * outside can read a clone and hand Wplace a new `Response` the wrapper never sees. Blue Marble
 * does this for every image: no tile is then attributed, so no template draws (#765).
 *
 * So the wrapper moves in front of the wrappers that userscripts and SvelteKit install before
 * Wplace's first request. That request still reaches this layer through them and shows it is
 * covered; a new layer then goes in front and this one passes calls through. It moves once.
 * Wplace's Pawtect guard wraps fetch after its wasm loads, through this wrapper, and stays the
 * outermost one.
 */
export const installPageRequestObserver = (
  realm: Window & typeof globalThis,
  mayMove = true,
): InstalledValueHook | null => {
  const nativeFetch = realm.fetch
  const urlGetters = captureFetchUrlGetters(realm)
  let covered = false
  const wrappedFetch = {
    fetch(this: unknown, ...args: Parameters<typeof fetch>) {
      if (covered) return nativeFetch.apply(this as never, args)
      if (mayMove && realm.fetch !== wrappedFetch) {
        covered = installPageRequestObserver(realm, false) !== null
        if (covered) count('fetch:tap moved in front of another fetch wrapper')
      }
      const observations = observe(args, realm, urlGetters, nativeFetch)
      let pending: ReturnType<typeof fetch>
      try {
        pending = nativeFetch.apply(this as never, args)
      } catch (error) {
        settle(observations)
        throw error
      }
      if (observations.length === 0) return pending
      return pending.then(
        (response) => {
          let answer = response
          for (const observation of observations) {
            try {
              answer = observation.response?.(answer) ?? answer
            } catch {
              count('fetch:route failed')
            }
          }
          return answer
        },
        (error: unknown) => {
          settle(observations)
          throw error
        },
      )
    },
  }.fetch as typeof globalThis.fetch
  return installValueHook(realm, 'fetch', wrappedFetch)
}
