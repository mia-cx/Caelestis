import {
  type Alarm,
  PALETTE_SIZE,
  parseTileKey,
  type StatusDelta,
  type TemplateStatus,
} from '@caelestis/shared'
import { MAX_MANIFEST_TEMPLATES } from './server-manifest.js'

/**
 * Decoders for the telemetry payloads a server sends: template status rows and deltas, and grief
 * alarms. A configured server is someone else's machine, so every number is checked before it
 * reaches a progress bar or an alert.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const SHA256_HEX = /^[0-9a-f]{64}$/
/** Status rows, alarms and removals are each bounded by the templates a manifest may carry. */
const MAX_ROWS = MAX_MANIFEST_TEMPLATES

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const alarmFrom = (value: unknown): Alarm | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<Alarm>
  if (
    typeof candidate.id !== 'string' ||
    !UUID_V7.test(candidate.id) ||
    typeof candidate.templateId !== 'string' ||
    !UUID_V7.test(candidate.templateId) ||
    (candidate.kind !== 'regression' && candidate.kind !== 'sustained-griefing') ||
    ![candidate.pixelsLost, candidate.firstSeen, candidate.lastSeen].every(
      (number) => Number.isSafeInteger(number) && Number(number) >= 0,
    ) ||
    Number(candidate.pixelsLost) === 0 ||
    Number(candidate.firstSeen) > Number(candidate.lastSeen)
  )
    return null
  return candidate as Alarm
}

const templateStatusFrom = (value: unknown): TemplateStatus | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<TemplateStatus>
  if (
    typeof candidate.templateId !== 'string' ||
    !UUID_V7.test(candidate.templateId) ||
    ![
      candidate.correct,
      candidate.wrong,
      candidate.blank,
      candidate.total,
      candidate.observedAt,
    ].every((number) => Number.isSafeInteger(number) && Number(number) >= 0) ||
    Number(candidate.correct) + Number(candidate.wrong) + Number(candidate.blank) >
      Number(candidate.total)
  )
    return null
  if (candidate.colours !== undefined) {
    if (!Array.isArray(candidate.colours) || candidate.colours.length > PALETTE_SIZE) return null
    const indices = new Set<number>()
    let correct = 0
    let wrong = 0
    let blank = 0
    let total = 0
    for (const raw of candidate.colours) {
      if (typeof raw !== 'object' || raw === null) return null
      const colour = raw as Partial<NonNullable<TemplateStatus['colours']>[number]>
      if (
        ![colour.index, colour.correct, colour.wrong, colour.blank, colour.total].every(
          (number) => Number.isSafeInteger(number) && Number(number) >= 0,
        ) ||
        Number(colour.index) >= PALETTE_SIZE - 1 ||
        indices.has(Number(colour.index)) ||
        Number(colour.total) === 0 ||
        Number(colour.correct) + Number(colour.wrong) + Number(colour.blank) > Number(colour.total)
      )
        return null
      indices.add(Number(colour.index))
      correct += Number(colour.correct)
      wrong += Number(colour.wrong)
      blank += Number(colour.blank)
      total += Number(colour.total)
    }
    if (
      correct !== candidate.correct ||
      wrong !== candidate.wrong ||
      blank !== candidate.blank ||
      total !== candidate.total
    )
      return null
  }
  return candidate as TemplateStatus
}

export const statusDeltaFrom = (value: unknown): StatusDelta | null => {
  if (typeof value !== 'object' || value === null) return null
  const candidate = value as Partial<StatusDelta>
  if (
    !Number.isSafeInteger(candidate.baseRevision) ||
    Number(candidate.baseRevision) < 0 ||
    !Number.isSafeInteger(candidate.revision) ||
    Number(candidate.revision) < Number(candidate.baseRevision) ||
    !Array.isArray(candidate.templates) ||
    candidate.templates.length > MAX_ROWS ||
    !Array.isArray(candidate.removedTemplateIds) ||
    candidate.removedTemplateIds.length > MAX_ROWS ||
    (candidate.invalidateAllTiles !== undefined && candidate.invalidateAllTiles !== true) ||
    (candidate.invalidateAllTiles === true && candidate.invalidatedTiles !== undefined) ||
    (candidate.invalidatedTiles !== undefined &&
      (!Array.isArray(candidate.invalidatedTiles) ||
        candidate.invalidatedTiles.some((tile) => parseTileKey(tile) === null)))
  )
    return null
  const templates: TemplateStatus[] = []
  const templateIds = new Set<string>()
  for (const raw of candidate.templates) {
    const status = templateStatusFrom(raw)
    if (status === null || templateIds.has(status.templateId)) return null
    templateIds.add(status.templateId)
    templates.push(status)
  }
  const removedTemplateIds = new Set<string>()
  for (const templateId of candidate.removedTemplateIds) {
    if (
      typeof templateId !== 'string' ||
      !UUID_V7.test(templateId) ||
      templateIds.has(templateId) ||
      removedTemplateIds.has(templateId)
    )
      return null
    removedTemplateIds.add(templateId)
  }
  return {
    baseRevision: Number(candidate.baseRevision),
    revision: Number(candidate.revision),
    templates,
    removedTemplateIds: [...removedTemplateIds],
    ...(candidate.invalidateAllTiles === true ? { invalidateAllTiles: true as const } : {}),
    ...(candidate.invalidatedTiles === undefined
      ? {}
      : { invalidatedTiles: candidate.invalidatedTiles }),
  }
}

export interface StatusSnapshot {
  readonly templates: readonly TemplateStatus[]
  readonly revision?: number
}

/** Every template's status, from a read or a live snapshot; live snapshots must carry a revision. */
export const statusSnapshotFrom = (
  value: unknown,
  revisionRequired: boolean,
): StatusSnapshot | null => {
  if (!isRecord(value) || !Array.isArray(value.templates) || value.templates.length > MAX_ROWS)
    return null
  const { revision } = value
  const revisionValid = Number.isSafeInteger(revision) && Number(revision) >= 0
  if (revisionRequired ? !revisionValid : revision !== undefined && !revisionValid) return null
  const templates: TemplateStatus[] = []
  for (const raw of value.templates) {
    const status = templateStatusFrom(raw)
    if (status === null) return null
    templates.push(status)
  }
  return { templates, ...(revisionValid ? { revision: Number(revision) } : {}) }
}

export interface AlarmsSnapshot {
  readonly alarms: readonly Alarm[]
  readonly version?: string
}

/** The open alarms, at most one per template; live snapshots must carry a version. */
export const alarmsSnapshotFrom = (
  value: unknown,
  versionRequired: boolean,
): AlarmsSnapshot | null => {
  if (!isRecord(value) || !Array.isArray(value.alarms) || value.alarms.length > MAX_ROWS)
    return null
  const { version } = value
  const versionValid = typeof version === 'string' && SHA256_HEX.test(version)
  if (versionRequired ? !versionValid : version !== undefined && !versionValid) return null
  const alarms: Alarm[] = []
  const templateIds = new Set<string>()
  for (const raw of value.alarms) {
    const alarm = alarmFrom(raw)
    if (alarm === null || templateIds.has(alarm.templateId)) return null
    templateIds.add(alarm.templateId)
    alarms.push(alarm)
  }
  return { alarms, ...(versionValid ? { version } : {}) }
}
