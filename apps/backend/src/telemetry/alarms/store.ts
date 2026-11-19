import type { Alarm, Millis, TemplateStatus } from '@caelestis/shared'
import type { ManifestTileRecord } from '../../templates/store.js'
import type {
  AlarmEvaluationPhase,
  AlarmPolicyResult,
  TemplateAlarmSnapshot,
} from '../alarm-policy.js'

export interface AlarmStatusSnapshot {
  readonly revision: number
  readonly templates: readonly TemplateStatus[]
}

export interface AlarmEvaluation extends AlarmPolicyResult {
  /** Whether this evaluation persisted a different caller-visible alarm, which subscribers need. */
  readonly alarmChanged: boolean
}

/** A durable delayed recheck claimed by the alarm-watcher Durable Object. */
export interface AlarmProbe {
  readonly templateId: string
  readonly versionId: string
  readonly season: number
  readonly alarmId: string
  readonly pixelsLost: number
  readonly dueAt: Millis
}

/** A current template tile plus the age of the classification used by alarm evaluation. */
export interface AlarmTileRecord extends ManifestTileRecord {
  readonly observedAt: Millis | null
}

/** Server-owned regression alarms: their evidence, their episodes, and their delayed probes. */
export interface AlarmStore {
  /** Current template tiles ordered by callers for bounded, freshness-aware alarm scans. */
  listAlarmTiles(season: number): Promise<readonly AlarmTileRecord[]>

  /**
   * Read authoritative counts and their observation fence in one transaction.
   * Omit templates whose current correct count differs, so the fence cannot suppress live evidence.
   */
  readAlarmStatusSnapshot(season: number): Promise<AlarmStatusSnapshot>

  /** Atomically evaluate and persist one template snapshot. */
  evaluateTemplateAlarm(
    snapshot: TemplateAlarmSnapshot,
    phase: AlarmEvaluationPhase,
    alarmId: string,
  ): Promise<AlarmEvaluation>

  readActiveAlarms(season: number, includeUnpublished: boolean): Promise<readonly Alarm[]>

  /** Clear the observed episode and reset its baseline, fencing older scans and follow-ups. */
  dismissTemplateAlarm(templateId: string, alarmId: string, now: Millis): Promise<boolean>

  listDueAlarmProbes(now: Millis): Promise<readonly AlarmProbe[]>

  nextAlarmProbeAt(): Promise<Millis | null>

  /** Drop a probe only if it is still the exact generation the caller observed. */
  clearAlarmProbe(templateId: string, alarmId: string, dueAt: Millis): Promise<void>

  /** Move a failed probe behind other due work without touching a replacement generation. */
  deferAlarmProbe(
    templateId: string,
    alarmId: string,
    dueAt: Millis,
    retryAt: Millis,
  ): Promise<void>
}
