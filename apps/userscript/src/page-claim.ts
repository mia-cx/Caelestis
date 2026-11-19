import { type Build, CLAIM_PROPERTY } from './page-markers.js'
import { pageWindow } from './page-world.js'

let running: Build = 'userscript'

export const runningBuild = (): Build => running

/** Whether some copy of Caelestis runs on this page. */
export const isPageClaimed = (): boolean =>
  (pageWindow() as unknown as Record<string, unknown>)[CLAIM_PROPERTY] !== undefined

/**
 * Claim the page for this copy of Caelestis, or report that another copy already has.
 *
 * Someone switching to the extension may still have the userscript installed. Both run at
 * document start in an unspecified order, so the first to call this wins and the other installs
 * nothing. The marker sits on the page's own `window`, the one object both copies share.
 */
export const claimPage = (build: Build): boolean => {
  const page = pageWindow() as unknown as Record<string, unknown>
  const holder = page[CLAIM_PROPERTY]
  if (holder !== undefined) {
    console.info(
      `[caelestis] the ${String(holder)} is already running here, so this ${build} stays off`,
    )
    return false
  }
  Object.defineProperty(page, CLAIM_PROPERTY, { value: build, enumerable: false })
  running = build
  return true
}
