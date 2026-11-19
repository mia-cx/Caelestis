import type { Alarm, Millis } from '@caelestis/shared'

/** Current classified pixels used by the server-owned alarm policy. */
export interface TemplateAlarmSnapshot {
  readonly templateId: string
  readonly versionId: string
  readonly total: number
  readonly correct: number
  readonly observedAt: Millis
  /** Orders the committed evidence, including authoritative scans with equal timestamps. */
  readonly observationRevision?: number
}

export interface TemplateAlarmState {
  readonly templateId: string
  readonly versionId: string
  readonly total: number
  readonly peakCorrect: number
  readonly alarm: Alarm | null
}

export type AlarmEvaluationPhase =
  | { readonly kind: 'scan' }
  | { readonly kind: 'observation'; readonly previousCorrect: number }
  | {
      readonly kind: 'follow-up'
      readonly alarmId: string
      readonly pixelsLost: number
      /** Identifies the exact durable probe generation this evaluation may consume. */
      readonly dueAt: Millis
    }

export interface AlarmPolicyResult {
  readonly state: TemplateAlarmState
  readonly scheduleFollowUp: boolean
}

/**
 * How often the tile mirror scans every template. The six-hourly cron in `wrangler.toml` and
 * `wrangler.self-hosted.example.toml` and the Node scheduler run it at this interval; change them
 * together.
 */
export const ALARM_SCAN_INTERVAL_SECONDS = 6 * 60 * 60
/** Cron delivery is not exact; keep a small overlap between adjacent bounded batches. */
export const ALARM_SCAN_JITTER_SECONDS = 5 * 60
/** A regression's probe refetches its template this long after the scan that opened it. */
export const ALARM_FOLLOW_UP_DELAY_MILLISECONDS = 10 * 60 * 1_000
/** A probe that could not finish tries again this much later. */
export const ALARM_FOLLOW_UP_RETRY_MILLISECONDS = 60_000

/** A follow-up applies only to the current episode of the same version. */
export const followUpApplies = (
  previous: TemplateAlarmState | null,
  snapshot: TemplateAlarmSnapshot,
  alarmId: string,
): boolean =>
  previous !== null && previous.versionId === snapshot.versionId && previous.alarm?.id === alarmId

/**
 * Evaluate a server-classified template snapshot. Any loss of correct pixels opens a regression.
 *
 * The high-water mark is version-local. An active episode survives partial recovery and clears only
 * when the observed count reaches that mark again. A follow-up promotes only when it belongs to the
 * current episode and sees more loss than the observation that scheduled it.
 */
export const evaluateAlarmSnapshot = (
  previous: TemplateAlarmState | null,
  snapshot: TemplateAlarmSnapshot,
  phase: AlarmEvaluationPhase,
  createId: () => string,
): AlarmPolicyResult => {
  if (phase.kind === 'follow-up' && !followUpApplies(previous, snapshot, phase.alarmId)) {
    return {
      state: previous ?? {
        templateId: snapshot.templateId,
        versionId: snapshot.versionId,
        total: snapshot.total,
        peakCorrect: snapshot.correct,
        alarm: null,
      },
      scheduleFollowUp: false,
    }
  }

  if (previous === null || previous.versionId !== snapshot.versionId) {
    const seeded = {
      templateId: snapshot.templateId,
      versionId: snapshot.versionId,
      total: snapshot.total,
      peakCorrect: phase.kind === 'observation' ? phase.previousCorrect : snapshot.correct,
      alarm: null,
    }
    if (phase.kind !== 'observation') return { state: seeded, scheduleFollowUp: false }
    previous = seeded
  }

  const peakCorrect = Math.max(previous.peakCorrect, snapshot.correct)
  const pixelsLost = peakCorrect - snapshot.correct
  const baseState = {
    templateId: snapshot.templateId,
    versionId: snapshot.versionId,
    total: snapshot.total,
    peakCorrect,
  }
  if (pixelsLost === 0) {
    return { state: { ...baseState, alarm: null }, scheduleFollowUp: false }
  }

  const current = previous.alarm
  if (current === null) {
    return {
      state: {
        ...baseState,
        alarm: {
          id: createId(),
          templateId: snapshot.templateId,
          kind: 'regression',
          pixelsLost,
          firstSeen: snapshot.observedAt,
          lastSeen: snapshot.observedAt,
        },
      },
      scheduleFollowUp: phase.kind !== 'follow-up',
    }
  }

  const kind =
    current.kind === 'sustained-griefing' ||
    (phase.kind === 'follow-up' && pixelsLost > phase.pixelsLost)
      ? 'sustained-griefing'
      : current.kind
  return {
    state: {
      ...baseState,
      alarm: {
        ...current,
        kind,
        pixelsLost,
        lastSeen: snapshot.observedAt,
      },
    },
    scheduleFollowUp:
      kind === 'regression' &&
      (phase.kind === 'scan' || (phase.kind === 'observation' && pixelsLost > current.pixelsLost)),
  }
}

/** Whether two alarm states describe the same caller-visible alarm. */
export const sameAlarm = (left: Alarm | null, right: Alarm | null): boolean =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.id === right.id &&
    left.templateId === right.templateId &&
    left.kind === right.kind &&
    left.pixelsLost === right.pixelsLost &&
    left.firstSeen === right.firstSeen &&
    left.lastSeen === right.lastSeen)
