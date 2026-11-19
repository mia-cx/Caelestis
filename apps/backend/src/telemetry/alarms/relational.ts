import { type Alarm, type Millis, millis, uuidV7, WORLD_TEMPLATE_SURFACE } from '@caelestis/shared'
import { and, asc, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { changedRows } from '../../adapters/relational-database.js'
import { RelationalStore } from '../../adapters/relational-store.js'
import {
  templateAlarmStates,
  templateAlarmTileStatuses,
  templates,
  templateVersions,
  versionTiles,
} from '../../db/schema.js'
import {
  ALARM_FOLLOW_UP_DELAY_MILLISECONDS,
  type AlarmEvaluationPhase,
  evaluateAlarmSnapshot,
  followUpApplies,
  sameAlarm,
  type TemplateAlarmSnapshot,
  type TemplateAlarmState,
} from './policy.js'
import type {
  AlarmEvaluation,
  AlarmProbe,
  AlarmStatusSnapshot,
  AlarmStore,
  AlarmTileRecord,
} from './store.js'

const storedAlarmState = (row: typeof templateAlarmStates.$inferSelect): TemplateAlarmState => {
  if (row.alarmId === null) {
    return {
      templateId: row.templateId,
      versionId: row.versionId,
      total: row.total,
      peakCorrect: row.peakCorrect,
      alarm: null,
    }
  }
  if (
    row.kind === null ||
    row.pixelsLost === null ||
    row.firstSeenMs === null ||
    row.lastSeenMs === null
  ) {
    throw new Error(`alarm state ${row.templateId} has a partial episode`)
  }
  return {
    templateId: row.templateId,
    versionId: row.versionId,
    total: row.total,
    peakCorrect: row.peakCorrect,
    alarm: {
      id: row.alarmId,
      templateId: row.templateId,
      kind: row.kind,
      pixelsLost: row.pixelsLost,
      firstSeen: row.firstSeenMs,
      lastSeen: row.lastSeenMs,
    },
  }
}

export class RelationalAlarmStore extends RelationalStore implements AlarmStore {
  async listAlarmTiles(season: number, templateId?: string): Promise<readonly AlarmTileRecord[]> {
    return this.database
      .select({
        templateId: templates.id,
        versionId: templateVersions.id,
        tileX: versionTiles.tileX,
        tileY: versionTiles.tileY,
        hash: versionTiles.hash,
        observedAt: templateAlarmTileStatuses.observedAtMs,
      })
      .from(versionTiles)
      .innerJoin(templateVersions, eq(templateVersions.id, versionTiles.versionId))
      .innerJoin(
        templates,
        and(
          eq(templates.id, templateVersions.templateId),
          eq(templates.currentVersionId, templateVersions.id),
        ),
      )
      .leftJoin(
        templateAlarmTileStatuses,
        and(
          eq(templateAlarmTileStatuses.templateId, templates.id),
          eq(templateAlarmTileStatuses.versionId, templateVersions.id),
          eq(templateAlarmTileStatuses.tileX, versionTiles.tileX),
          eq(templateAlarmTileStatuses.tileY, versionTiles.tileY),
        ),
      )
      .where(
        and(
          eq(templates.season, season),
          eq(templates.surfaceKind, WORLD_TEMPLATE_SURFACE.kind),
          templateId === undefined ? undefined : eq(templates.id, templateId),
        ),
      )
  }

  async readAlarmStatusSnapshot(season: number, templateId?: string): Promise<AlarmStatusSnapshot> {
    const [revisionResult, statusResult] = await this.client.batch([
      this.client
        .prepare(
          'SELECT coalesce((SELECT revision FROM status_read_model_revisions WHERE season = ?), 0) AS revision',
        )
        .bind(season),
      this.client
        .prepare(`SELECT template.id AS template_id, version.id AS version_id, version.total_pixels AS total,
        sum(status.correct) AS correct, sum(status.wrong) AS wrong, sum(status.blank) AS blank,
        max(status.observed_at_ms) AS observed_at_ms
        FROM templates AS template
        INNER JOIN template_versions AS version ON version.id = template.current_version_id
        INNER JOIN template_alarm_tile_statuses AS status
          ON status.template_id = template.id AND status.version_id = version.id
        WHERE template.season = ?${templateId === undefined ? '' : ' AND template.id = ?'}
        GROUP BY template.id, version.id, version.total_pixels
        HAVING sum(status.correct) = (
          SELECT sum(current.correct) FROM template_tile_statuses AS current
          WHERE current.template_id = template.id AND current.version_id = version.id
        )
        ORDER BY template.id`)
        .bind(...(templateId === undefined ? [season] : [season, templateId])),
    ])
    const row = revisionResult?.results[0] as { revision: number }
    const statuses = statusResult?.results as Array<{
      template_id: string
      total: number
      correct: number
      wrong: number
      blank: number
      observed_at_ms: number
    }>
    return {
      revision: row.revision,
      templates: statuses.map((status) => ({
        templateId: status.template_id,
        total: status.total,
        correct: status.correct,
        wrong: status.wrong,
        blank: status.blank,
        observedAt: millis(status.observed_at_ms),
      })),
    }
  }

  async evaluateTemplateAlarm(
    snapshot: TemplateAlarmSnapshot,
    phase: AlarmEvaluationPhase,
  ): Promise<AlarmEvaluation> {
    for (let attempt = 0; attempt < 8; attempt++) {
      const previousRow = await this.database
        .select()
        .from(templateAlarmStates)
        .where(eq(templateAlarmStates.templateId, snapshot.templateId))
        .limit(1)
        .then((rows) => rows[0])
      const previousState = previousRow === undefined ? null : storedAlarmState(previousRow)
      const staleFollowUp =
        phase.kind === 'follow-up' &&
        (previousRow === undefined ||
          !followUpApplies(previousState, snapshot, phase.alarmId) ||
          previousRow.probeDueAtMs !== phase.dueAt ||
          previousRow.probePixelsLost !== phase.pixelsLost)
      const staleEvidence =
        previousRow !== undefined &&
        (snapshot.observedAt < previousRow.evaluatedAtMs ||
          (snapshot.observationRevision !== undefined &&
            (snapshot.observationRevision < previousRow.observationRevision ||
              (phase.kind === 'observation' &&
                snapshot.observationRevision === previousRow.observationRevision))))
      if (staleFollowUp || staleEvidence) return { alarmChanged: false, scheduleFollowUp: false }
      const result = evaluateAlarmSnapshot(previousState, snapshot, phase, uuidV7)
      const alarm = result.state.alarm
      const preserveProbe =
        phase.kind === 'observation' &&
        alarm !== null &&
        alarm.id === previousState?.alarm?.id &&
        previousRow?.probeDueAtMs != null
      const probeDueAt = preserveProbe
        ? previousRow.probeDueAtMs
        : result.scheduleFollowUp
          ? ((snapshot.observedAt + ALARM_FOLLOW_UP_DELAY_MILLISECONDS) as Millis)
          : null
      const values = {
        templateId: snapshot.templateId,
        versionId: result.state.versionId,
        total: result.state.total,
        peakCorrect: result.state.peakCorrect,
        alarmId: alarm?.id ?? null,
        kind: alarm?.kind ?? null,
        pixelsLost: alarm?.pixelsLost ?? null,
        firstSeenMs: alarm?.firstSeen ?? null,
        lastSeenMs: alarm?.lastSeen ?? null,
        probeDueAtMs: probeDueAt,
        probePixelsLost: preserveProbe
          ? previousRow.probePixelsLost
          : result.scheduleFollowUp
            ? (alarm?.pixelsLost ?? null)
            : null,
        evaluatedAtMs: snapshot.observedAt,
        observationRevision: snapshot.observationRevision ?? previousRow?.observationRevision ?? 0,
        revision: (previousRow?.revision ?? -1) + 1,
      }
      const write =
        previousRow === undefined
          ? await this.database
              .insert(templateAlarmStates)
              .values(values)
              .onConflictDoNothing({
                target: [templateAlarmStates.templateId].map(
                  (column) => sql`${sql.identifier(column.name)}`,
                ),
              })
          : await this.database
              .update(templateAlarmStates)
              .set(values)
              .where(
                and(
                  eq(templateAlarmStates.templateId, snapshot.templateId),
                  eq(templateAlarmStates.revision, previousRow.revision),
                ),
              )
      if (changedRows(write) > 0)
        return {
          alarmChanged: !sameAlarm(previousState?.alarm ?? null, alarm),
          scheduleFollowUp: result.scheduleFollowUp,
        }
    }
    throw new Error(`alarm state stayed contended for template ${snapshot.templateId}`)
  }

  async dismissTemplateAlarm(templateId: string, alarmId: string, now: Millis): Promise<boolean> {
    const write = await this.database
      .update(templateAlarmStates)
      .set({
        peakCorrect: sql`${templateAlarmStates.peakCorrect} - ${templateAlarmStates.pixelsLost}`,
        alarmId: null,
        kind: null,
        pixelsLost: null,
        firstSeenMs: null,
        lastSeenMs: null,
        probeDueAtMs: null,
        probePixelsLost: null,
        evaluatedAtMs: sql`${sql.raw(this.syntax.greatest)}(${templateAlarmStates.evaluatedAtMs}, ${now}) + 1`,
        revision: sql`${templateAlarmStates.revision} + 1`,
      })
      .where(
        and(
          eq(templateAlarmStates.templateId, templateId),
          eq(templateAlarmStates.alarmId, alarmId),
        ),
      )
    return changedRows(write) > 0
  }

  async readActiveAlarms(season: number, includeUnpublished: boolean): Promise<readonly Alarm[]> {
    const rows = await this.database
      .select({ state: templateAlarmStates })
      .from(templateAlarmStates)
      .innerJoin(templates, eq(templates.id, templateAlarmStates.templateId))
      .where(
        and(
          eq(templates.season, season),
          eq(templates.currentVersionId, templateAlarmStates.versionId),
          isNotNull(templateAlarmStates.alarmId),
          includeUnpublished ? undefined : isNotNull(templates.publishedAt),
        ),
      )
      .orderBy(asc(templateAlarmStates.templateId))
    return rows.flatMap(({ state }) => {
      const alarm = storedAlarmState(state).alarm
      return alarm === null ? [] : [alarm]
    })
  }

  async listDueAlarmProbes(now: Millis): Promise<readonly AlarmProbe[]> {
    const rows = await this.database
      .select({
        templateId: templateAlarmStates.templateId,
        versionId: templateAlarmStates.versionId,
        season: templates.season,
        alarmId: templateAlarmStates.alarmId,
        pixelsLost: templateAlarmStates.probePixelsLost,
        dueAt: templateAlarmStates.probeDueAtMs,
      })
      .from(templateAlarmStates)
      .innerJoin(templates, eq(templates.id, templateAlarmStates.templateId))
      .where(
        and(
          eq(templates.currentVersionId, templateAlarmStates.versionId),
          isNotNull(templateAlarmStates.alarmId),
          isNotNull(templateAlarmStates.probePixelsLost),
          isNotNull(templateAlarmStates.probeDueAtMs),
          lte(templateAlarmStates.probeDueAtMs, now),
        ),
      )
      .orderBy(asc(templateAlarmStates.probeDueAtMs), asc(templateAlarmStates.templateId))
    return rows.flatMap((row) =>
      row.alarmId === null || row.pixelsLost === null || row.dueAt === null
        ? []
        : [
            {
              templateId: row.templateId,
              versionId: row.versionId,
              season: row.season,
              alarmId: row.alarmId,
              pixelsLost: row.pixelsLost,
              dueAt: row.dueAt,
            },
          ],
    )
  }

  async nextAlarmProbeAt(): Promise<Millis | null> {
    const rows = await this.database
      .select({ dueAt: sql<number | null>`min(${templateAlarmStates.probeDueAtMs})` })
      .from(templateAlarmStates)
      .innerJoin(templates, eq(templates.id, templateAlarmStates.templateId))
      .where(
        and(
          eq(templates.currentVersionId, templateAlarmStates.versionId),
          isNotNull(templateAlarmStates.alarmId),
          isNotNull(templateAlarmStates.probeDueAtMs),
        ),
      )
    const dueAt = rows[0]?.dueAt
    return dueAt === undefined || dueAt === null ? null : (dueAt as Millis)
  }

  async clearAlarmProbe(templateId: string, alarmId: string, dueAt: Millis): Promise<void> {
    await this.database
      .update(templateAlarmStates)
      .set({
        probeDueAtMs: null,
        probePixelsLost: null,
        revision: sql`${templateAlarmStates.revision} + 1`,
      })
      .where(
        and(
          eq(templateAlarmStates.templateId, templateId),
          eq(templateAlarmStates.alarmId, alarmId),
          eq(templateAlarmStates.probeDueAtMs, dueAt),
        ),
      )
  }

  async deferAlarmProbe(
    templateId: string,
    alarmId: string,
    dueAt: Millis,
    retryAt: Millis,
  ): Promise<void> {
    await this.database
      .update(templateAlarmStates)
      .set({
        probeDueAtMs: retryAt,
        revision: sql`${templateAlarmStates.revision} + 1`,
      })
      .where(
        and(
          eq(templateAlarmStates.templateId, templateId),
          eq(templateAlarmStates.alarmId, alarmId),
          eq(templateAlarmStates.probeDueAtMs, dueAt),
        ),
      )
  }
}
