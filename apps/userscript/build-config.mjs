/** What the userscript build, the extension manifest, and the dev tools agree on. */

export const REPOSITORY_URL = 'https://github.com/mia-cx/Caelestis'

/** Where userscript managers install and update from: the newest release's stable asset. */
export const INSTALLER_URL = `${REPOSITORY_URL}/releases/latest/download/caelestis.user.js`

/** Asked by the running userscript whether a newer release exists. */
export const LATEST_RELEASE_API_URL =
  'https://api.github.com/repos/mia-cx/Caelestis/releases/latest'

/** Every page Caelestis runs on. */
export const WPLACE_MATCH = 'https://wplace.live/*'

/**
 * The built userscript. Release tooling (`.github/scripts/prepare-userscript-release.mjs`, the
 * userscript CI artifact) reads this path and publishes it as `caelestis.user.js`.
 */
export const USERSCRIPT_BUNDLE = 'dist/wplace-template-server.user.js'
