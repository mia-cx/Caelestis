import { isRecord } from '@caelestis/shared'
import { userscriptVersion } from './client-metrics.js'
import { getState } from './settings.js'
import { showAmbientToast } from './ui/notification-host.js'
import { compareVersions, type ParsedVersion, parseVersion } from './version.js'

const UPDATE_CHECK_DELAY_MS = 5_000
const RELEASE_TAG = /^userscript-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const decodeLatestVersion = (value: unknown): ParsedVersion | null => {
  if (!isRecord(value) || value.draft !== false || value.prerelease !== false) return null
  return typeof value.tag_name === 'string' ? parseVersion(value.tag_name, RELEASE_TAG) : null
}

/** Check when update notices are enabled, announcing each published version at most once. */
const createUserscriptUpdateCheck = (): (() => Promise<void>) => {
  const running = parseVersion(userscriptVersion)
  let announcedVersion: string | null = null

  return async (): Promise<void> => {
    try {
      if (running === null || !getState().notifyUpdates) return
      const response = await fetch(__CAELESTIS_RELEASE__.latestReleaseApiUrl, {
        headers: { accept: 'application/vnd.github+json' },
      })
      if (!response.ok) return
      const latest = decodeLatestVersion(await response.json())
      if (
        latest === null ||
        !getState().notifyUpdates ||
        latest.label === announcedVersion ||
        compareVersions(latest, running) <= 0
      )
        return

      announcedVersion = latest.label
      showAmbientToast(`Caelestis v${latest.label} is available.`, 'info', {
        label: 'Update userscript',
        href: __CAELESTIS_RELEASE__.installerUrl,
      })
    } catch {
      // Update checks are advisory. Wplace and Caelestis continue without one.
    }
  }
}

/** Start the advisory network check after the document-start startup work has returned. */
export const installUserscriptUpdateCheck = (): void => {
  const check = createUserscriptUpdateCheck()
  window.setTimeout(() => void check(), UPDATE_CHECK_DELAY_MS)
}
