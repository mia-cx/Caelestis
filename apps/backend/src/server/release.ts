/** What the host knows about its own build, outside the environment. */
export interface Release {
  readonly version?: string | undefined
  /** The deploy's commit SHA, or nothing in development. */
  readonly build?: string | undefined
}

/** The first 12 characters of a deploy's SHA, as `/server` and request metrics report it. */
export const buildId = (sha: string | undefined): string => sha?.slice(0, 12) || 'development'

/** The release Wrangler stamps into the Worker bundle; empty in tests and local development. */
export const bundledRelease: Release = {
  version:
    typeof __CAELESTIS_BACKEND_VERSION__ === 'string' ? __CAELESTIS_BACKEND_VERSION__ : undefined,
  build:
    typeof __CAELESTIS_DEPLOYMENT_VERSION__ === 'string'
      ? __CAELESTIS_DEPLOYMENT_VERSION__
      : undefined,
}
