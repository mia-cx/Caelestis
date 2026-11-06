import { startUserscript } from './main.js'
import { claimPage } from './page-claim.js'

if (claimPage('userscript')) startUserscript()
