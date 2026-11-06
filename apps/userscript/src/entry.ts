import {
  HANDED_OFF_KEY,
  linkOtherBuild,
  meetOtherBuild,
  serveOtherBuild,
} from './build-transfer.js'
import { startUserscript } from './main.js'
import { claimPage, isPageClaimed } from './page-claim.js'
import { pageWindow } from './page-world.js'
import { deleteStoredValue, storedValue } from './stored-values.js'

const handedOff = ((): boolean => {
  try {
    return storedValue(HANDED_OFF_KEY) === 'true'
  } catch {
    return false
  }
})()

const port = meetOtherBuild()

if (handedOff) {
  // The extension runs Caelestis now. If it is gone, run again on this copy's own values.
  console.info('[caelestis] this userscript handed over to the extension, so it stays off')
  serveOtherBuild(port, 'userscript')
  pageWindow().addEventListener('load', () => {
    // Wplace's own frames run userscripts but never the extension, so only the top page decides.
    if (isPageClaimed() || pageWindow().top !== pageWindow()) return
    deleteStoredValue(HANDED_OFF_KEY)
    pageWindow().location.reload()
  })
} else if (claimPage('userscript')) {
  startUserscript()
  linkOtherBuild(port, 'userscript', false)
} else {
  serveOtherBuild(port, 'userscript')
}
