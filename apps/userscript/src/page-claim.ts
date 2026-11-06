import { pageWindow } from './page-world.js'

/** The builds that can run Caelestis on a page. */
export type Build = 'userscript' | 'extension'

const CLAIM = '__caelestisBuild'

/**
 * Claim the page for this copy of Caelestis, or report that another copy already has.
 *
 * Someone switching to the extension may still have the userscript installed. Both run at
 * document start in an unspecified order, so the first to call this wins and the other installs
 * nothing. The marker sits on the page's own `window`, the one object both copies share.
 */
export const claimPage = (build: Build): boolean => {
  const page = pageWindow() as unknown as Record<string, unknown>
  const holder = page[CLAIM]
  if (holder !== undefined) {
    console.info(
      `[caelestis] the ${String(holder)} is already running here, so this ${build} stays off`,
    )
    return false
  }
  Object.defineProperty(page, CLAIM, { value: build, enumerable: false })
  return true
}
