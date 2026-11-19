/** Constants `build.mjs` defines at bundle time. Tests and type checks run without them. */

declare const __CAELESTIS_USERSCRIPT_VERSION__: string

/** The backend version this build was made against. */
declare const __CAELESTIS_EXPECTED_BACKEND_VERSION__: string

declare const __CAELESTIS_BUILD__: {
  readonly revision: string | null
  readonly dirty: boolean | null
  readonly development: boolean
}

declare const __CAELESTIS_RELEASE__: {
  readonly installerUrl: string
  readonly latestReleaseApiUrl: string
}
