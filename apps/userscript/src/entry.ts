import { claimPage } from './page-claim.js'
import { connectStorageBridge } from './storage-bridge/connect.js'
import { canServeManagerStorage, managerStore } from './storage-bridge/manager-store.js'
import { serveStorageBridge } from './storage-bridge/serve.js'

/**
 * The userscript's entrypoint, run twice: once by the userscript manager, once in the page.
 *
 * `build.mjs` wraps the bundle in `function caelestis(world) { ... }` and calls it with `manager`.
 * Managers differ in where they run a script. Some run it in the page, others in a world of their
 * own, where Caelestis's hooks and Wplace's modules belong to another realm: no templates load and
 * every template shortcut does nothing. Rather than tell those apart, the manager's copy serves its
 * `GM_*` storage over the storage bridge and puts `caelestis('page')` into the page as a `<script>`,
 * where Caelestis runs as it does in the extension. Where that cannot work, the manager's copy runs
 * Caelestis where it is, as before.
 *
 * Caelestis itself loads through `application()`, so only the world that runs it initializes its
 * modules: the manager's copy that moves into the page runs the storage bridge and nothing else.
 * The import settles in a microtask, which still runs before the parser reaches any of Wplace's
 * scripts, so the page hooks keep their place ahead of Wplace.
 */
declare const world: 'manager' | 'page'
declare const caelestis: (world: 'page') => void

const RAN = 'data-caelestis-ran'

const application = () => import('./main.js')

/** Run Caelestis in the page, served by this copy. False when it has to stay here. */
const moveIntoPage = (): boolean => {
  if (!canServeManagerStorage()) return false
  const stop = serveStorageBridge('userscript', managerStore())
  const script = document.createElement('script')
  script.textContent = `(${caelestis})('page')`
  try {
    // At document start there may be no element yet; the script then runs as the document's
    // only child, and leaves before the parser builds the page.
    ;(document.head ?? document.documentElement ?? document).append(script)
    script.remove()
  } catch (error) {
    console.warn('[caelestis] could not start in the page', error)
  }
  // A page that refuses inline scripts never ran it.
  if (script.hasAttribute(RAN)) return true
  stop()
  return false
}

if (world === 'page') {
  // Inline scripts run as they are inserted, so the manager's copy reads this before removing it.
  document.currentScript?.setAttribute(RAN, '')
  void application().then(({ installPageHooks, installUserscriptFeatures }) => {
    if (connectStorageBridge('userscript', installUserscriptFeatures)) installPageHooks()
  })
} else if (!moveIntoPage() && claimPage('userscript'))
  void application().then(({ startUserscript }) => startUserscript())
