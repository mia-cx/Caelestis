import type { TemplateStatus } from '@caelestis/shared'
import { bestEffort, type StatusReadModelPort } from '../../status-read-model/port.js'
import type { AlarmEvaluationPhase, TemplateAlarmSnapshot } from './policy.js'
import type { AlarmEvaluation, AlarmStatusSnapshot, AlarmStore } from './store.js'

export type EvaluateAlarm = (
  season: number,
  snapshot: TemplateAlarmSnapshot,
  phase: AlarmEvaluationPhase,
) => Promise<AlarmEvaluation>

/**
 * Run `work` with an evaluator, then tell each season whose alarm changed once. Progress that moves
 * no alarm owes subscribers nothing, and a changed alarm covers every follow-up it scheduled. Each
 * evaluation commits on its own, so a failure later in `work` still owes the earlier changes.
 */
export const evaluateAlarms = async <Value>(
  ports: {
    readonly sql: AlarmStore
    readonly statusReadModel: Pick<StatusReadModelPort, 'notifyAlarmChange'>
  },
  work: (evaluate: EvaluateAlarm) => Promise<Value>,
): Promise<Value> => {
  const changed = new Set<number>()
  try {
    return await work(async (season, snapshot, phase) => {
      const evaluation = await ports.sql.evaluateTemplateAlarm(snapshot, phase)
      if (evaluation.alarmChanged) changed.add(season)
      return evaluation
    })
  } finally {
    for (const season of changed) {
      await bestEffort(() => ports.statusReadModel.notifyAlarmChange(season))
    }
  }
}

/** The template's status when the snapshot classifies every pixel of the version it names. */
export const completeAlarmStatus = (
  template: { readonly id: string; readonly totalPixels: number },
  snapshot: AlarmStatusSnapshot,
): TemplateStatus | null => {
  const status = snapshot.templates.find((candidate) => candidate.templateId === template.id)
  return status !== undefined &&
    status.total === template.totalPixels &&
    status.correct + status.wrong + status.blank === status.total
    ? status
    : null
}
