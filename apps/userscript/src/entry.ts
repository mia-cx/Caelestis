import {
  handedOff,
  linkOtherBuild,
  meetOtherBuild,
  recoverFromMissingExtension,
  serveOtherBuild,
} from './build-transfer.js'
import { claimPage } from './page-claim.js'
import { RAN_ATTRIBUTE } from './page-markers.js'
import { connectStorageBridge } from './storage-bridge/connect.js'
import { managerStore } from './storage-bridge/manager-store.js'
import { serveStorageBridge } from './storage-bridge/serve.js'
import { canServeManagerStorage } from './stored-values.js'

/**
 * The userscript's entrypoint, run twice: once by the userscript manager, once in the page.
 *
 * `build.mjs` wraps the bundle in `function caelestis(world) { ... }` and calls it with `manager`.
 * Managers differ in where they run a script. Some run it in the page, others in a world of their
 * own, where Caelestis's hooks and Wplace's modules belong to another realm: no templates load and
 * every template shortcut does nothing. Rather than tell those apart, the manager's copy serves its
 * `GM_*` storage over the storage bridge and puts `caelestis('page')` into the page as a `<script>`,
 * where Caelestis runs as it does in the extension. Where that cannot work, the manager's copy runs
 * Caelestis in its own world.
 *
 * A userscript that handed over to the extension (see `build-transfer.ts`) puts
 * `caelestis('standby')` into the page instead: that copy never claims the page, and only serves its
 * values to the extension.
 *
 * Caelestis itself loads through `application()`, so only the world that runs it initializes its
 * modules: the manager's copy that moves into the page runs the storage bridge and nothing else.
 * The import settles in a microtask, which still runs before the parser reaches any of Wplace's
 * scripts, so the page hooks keep their place ahead of Wplace.
 */
declare const world: 'manager' | PageWorld
declare const caelestis: (world: PageWorld) => void

/** The page copy that runs Caelestis if it can claim the page, or one that only serves its values. */
type PageWorld = 'page' | 'standby'

const application = () => import('./main.js')

/** Run the page copy, served by this copy. False when it has to stay here. */
const moveIntoPage = (pageWorld: PageWorld): boolean => {
  if (!canServeManagerStorage()) return false
  const stop = serveStorageBridge('userscript', managerStore())
  const script = document.createElement('script')
  script.textContent = `(${caelestis})('${pageWorld}')`
  try {
    // At document start there may be no element yet; the script then runs as the document's
    // only child, and leaves before the parser builds the page.
    ;(document.head ?? document.documentElement ?? document).append(script)
    script.remove()
  } catch (error) {
    console.warn('[caelestis] could not start in the page', error)
  }
  // A page that refuses inline scripts never ran it.
  if (script.hasAttribute(RAN_ATTRIBUTE)) return true
  stop()
  return false
}

/** The page copy: run Caelestis if it claims the page, otherwise serve its values to the build that did. */
const runInPage = (pageWorld: PageWorld): void => {
  // Inline scripts run as they are inserted, so the manager's copy reads this before removing it.
  document.currentScript?.setAttribute(RAN_ATTRIBUTE, '')
  const other = meetOtherBuild()
  void application().then(({ installPageHooks, installUserscriptFeatures }) => {
    const claimed = connectStorageBridge(
      'userscript',
      () => {
        if (!claimed) {
          if (other !== null) serveOtherBuild(other, 'userscript')
          return
        }
        installUserscriptFeatures()
        if (other !== null) linkOtherBuild(other, 'userscript', false)
      },
      pageWorld === 'standby',
    )
    if (claimed) installPageHooks()
  })
}

if (world !== 'manager') runInPage(world)
else if (handedOff()) {
  console.info('[caelestis] this userscript handed over to the extension, so it stays off')
  moveIntoPage('standby')
  recoverFromMissingExtension()
} else if (!moveIntoPage('page') && claimPage('userscript'))
  void application().then(({ startUserscript }) => startUserscript())
