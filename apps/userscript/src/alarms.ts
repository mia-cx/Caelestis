import type { Alarm } from '@caelestis/shared'
import { notifyListeners } from './listeners.js'
import { activeServerAlarms, onServerAlarmChange } from './server-alarms.js'
import { getState, type ServerConnection } from './settings.js'
import { storedValue, storeValue } from './stored-values.js'
import { showAmbientToast } from './ui/notification-host.js'
import { isPaintOpen } from './wplace-paint.js'

const ACKNOWLEDGED_KEY = 'caelestis.acknowledged-alarms.v1'
const MAX_ACKNOWLEDGED = 1_024

const alarmFingerprint = (serverUrl: string, alarm: Alarm): string =>
  `${serverUrl}\u0000${alarm.id}\u0000${alarm.kind}`

const readAcknowledged = (): Set<string> => {
  try {
    const raw = storedValue(ACKNOWLEDGED_KEY) ?? '[]'
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed
        .filter((value): value is string => typeof value === 'string' && value.length <= 4_096)
        .slice(-MAX_ACKNOWLEDGED),
    )
  } catch {
    return new Set()
  }
}

const writeAcknowledged = (acknowledged: ReadonlySet<string>): void => {
  try {
    const raw = JSON.stringify([...acknowledged].slice(-MAX_ACKNOWLEDGED))
    storeValue(ACKNOWLEDGED_KEY, raw)
  } catch {
    // A failed acknowledgement stays visible; no alarm state is lost.
  }
}

const notice = (name: string, alarm: Alarm): string =>
  alarm.kind === 'sustained-griefing'
    ? `${name} is still being griefed · ${alarm.pixelsLost.toLocaleString()} px lost`
    : `${name} regressed · ${alarm.pixelsLost.toLocaleString()} px lost`

let installed = false
let acknowledged = new Set<string>()
let known = new Set<string>()
let isPresented: (server: ServerConnection, templateId: string) => boolean = () => false
const badgeListeners = new Set<() => void>()

/**
 * The unacknowledged-alarm count. Not "how many alarms are active" — that number stays lit for
 * hours on a griefed template and stops being read. This one means "something new since you last
 * looked", so it clears itself by being seen.
 */
export const unacknowledgedAlarmCount = (): number =>
  activeServerAlarms().filter(
    ({ server, alarm }) => !acknowledged.has(alarmFingerprint(server.url, alarm)),
  ).length

/** Follow {@link unacknowledgedAlarmCount}. */
export const onAlarmBadgeChange = (listener: () => void): void => {
  badgeListeners.add(listener)
}

/** Count every alarm on a template the panel presents now as seen. */
export const acknowledgeVisibleAlarms = (): void => {
  let changed = false
  for (const { server, alarm } of activeServerAlarms()) {
    if (!isPresented(server, alarm.templateId)) continue
    const fingerprint = alarmFingerprint(server.url, alarm)
    if (acknowledged.has(fingerprint)) continue
    acknowledged.add(fingerprint)
    changed = true
  }
  if (changed) writeAcknowledged(acknowledged)
  notifyListeners(badgeListeners, 'alarm badge observer failed')
}

/** How to tell whether the panel presents a template, so an alarm on it counts as seen. */
export const setAlarmPresenter = (
  presented: (server: ServerConnection, templateId: string) => boolean,
): void => {
  isPresented = presented
  acknowledgeVisibleAlarms()
}

const syncAlarms = (): void => {
  const current = activeServerAlarms()
  const fingerprints = new Set(
    current.map(({ server, alarm }) => alarmFingerprint(server.url, alarm)),
  )
  acknowledgeVisibleAlarms()

  for (const { server, template, alarm } of current) {
    const fingerprint = alarmFingerprint(server.url, alarm)
    if (known.has(fingerprint) || acknowledged.has(fingerprint)) continue
    if (isPaintOpen() || document.visibilityState === 'hidden') continue
    const preferences = getState()
    if (
      alarm.kind === 'sustained-griefing'
        ? !preferences.notifyGriefing
        : !preferences.notifyRegressions
    )
      continue
    showAmbientToast(notice(template.name, alarm), 'warning')
  }
  known = fingerprints
}

export const installAlarmNotifications = (): void => {
  if (installed) return
  installed = true
  acknowledged = readAcknowledged()
  onServerAlarmChange(syncAlarms)
  syncAlarms()
}
