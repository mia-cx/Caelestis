import {
  decodeMismatchMask,
  encodeIndexedPng,
  millis,
  mismatchClassAt,
  seconds,
  sha256Hex,
  TRANSPARENT_INDEX,
} from '@caelestis/shared'
import { expect, it } from 'vitest'
import { createBackendRuntime, makeBackendContext } from '../src/runtime/backend-runtime.js'
import { DirectStatusReadModel } from '../src/status-read-model/port.js'
import { evaluateAlarmSnapshot } from '../src/telemetry/alarm-policy.js'
import { fetchCanvasTiles } from '../src/telemetry/fetcher.js'
import { readMismatchMask, uploadTile } from '../src/telemetry/ingest.js'
import { authorized, createTestBackend } from './support/backend.js'

it('classifies uploaded canvas bytes against persisted artwork and exposes the same mismatch mask', async () => {
  const { app, sql, blobs, counters } = await createTestBackend()
  const artwork = await encodeIndexedPng(4, 1, new Uint8Array([1, 1, 1, TRANSPARENT_INDEX]))
  const form = new FormData()
  form.set('png', new File([artwork], 'art.png', { type: 'image/png' }))
  form.set('name', 'Classification')
  form.set('season', '3')
  form.set('originX', '10')
  form.set('originY', '20')
  const response = await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))
  expect(response.status).toBe(201)
  const created = (await response.json()) as { templateId: string; versionId: string }
  const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
  indices.set([1, 2, TRANSPARENT_INDEX, 3], 20010)
  const canvas = await encodeIndexedPng(1000, 1000, indices)
  const runtime = createBackendRuntime(makeBackendContext(blobs, sql, counters))
  const metadata = {
    season: 3,
    tile: { x: 0, y: 0 },
    hash: await sha256Hex(canvas),
    observedAt: seconds(Math.floor(Date.now() / 1000)),
    includeUnpublished: true,
    tokenHash: 'a'.repeat(64),
    wplaceUserId: 42,
    displayName: 'Painter',
  }
  await runtime.run(uploadTile(metadata, canvas))
  expect(await sql.readTemplateStatuses(3, true)).toMatchObject([
    { templateId: created.templateId, total: 3, correct: 1, wrong: 1, blank: 1 },
  ])
  const result = await runtime.run(
    readMismatchMask({
      season: 3,
      templateId: created.templateId,
      versionId: created.versionId,
      tile: metadata.tile,
      includeUnpublished: true,
    }),
  )
  expect(result.kind).toBe('found')
  if (result.kind !== 'found') throw new Error('Expected classification mask')
  const mask = decodeMismatchMask(result.bytes)
  if (mask === null) throw new Error('Expected valid mismatch mask')
  expect([10, 11, 12].map((x) => mismatchClassAt(mask, x, 20))).toEqual([0, 1, 2])
  await expect(
    runtime.run(uploadTile({ ...metadata, hash: '0'.repeat(64) }, canvas)),
  ).rejects.toThrow()
  expect(await sql.readTemplateStatuses(3, true)).toMatchObject([
    { total: 3, correct: 1, wrong: 1, blank: 1 },
  ])
})

it('keeps a regression open through partial recovery and ignores follow-ups from an old episode', () => {
  const snapshot = {
    templateId: 'template',
    versionId: 'version',
    total: 10,
    correct: 7,
    observedAt: millis(1000),
  }
  const opened = evaluateAlarmSnapshot(
    null,
    snapshot,
    { kind: 'observation', previousCorrect: 10 },
    () => 'episode',
  )
  expect(opened).toMatchObject({
    scheduleFollowUp: true,
    state: { peakCorrect: 10, alarm: { id: 'episode', pixelsLost: 3, kind: 'regression' } },
  })
  const partial = evaluateAlarmSnapshot(
    opened.state,
    { ...snapshot, correct: 9 },
    { kind: 'scan' },
    () => 'unused',
  )
  expect(partial.state.alarm).toMatchObject({ id: 'episode', pixelsLost: 1 })
  const stale = evaluateAlarmSnapshot(
    partial.state,
    { ...snapshot, correct: 0 },
    { kind: 'follow-up', alarmId: 'old', pixelsLost: 1, dueAt: millis(1000) },
    () => 'unused',
  )
  expect(stale.state).toEqual(partial.state)
  const recovered = evaluateAlarmSnapshot(
    partial.state,
    { ...snapshot, correct: 10 },
    { kind: 'scan' },
    () => 'unused',
  )
  expect(recovered.state.alarm).toBeNull()
})

it('tells public live subscribers nothing about tiles only a draft covers', async () => {
  const { app, sql, blobs, counters } = await createTestBackend()
  const form = new FormData()
  form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
  form.set('name', 'Draft')
  form.set('season', '3')
  form.set('originX', '10')
  form.set('originY', '20')
  expect(
    (await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))).status,
  ).toBe(201)
  const runtime = createBackendRuntime(
    makeBackendContext(blobs, sql, counters, new DirectStatusReadModel(sql)),
  )
  let observedAt = Math.floor(Date.now() / 1000)
  const upload = async (colour: number) => {
    const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
    indices[20010] = colour
    const canvas = await encodeIndexedPng(1000, 1000, indices)
    return await runtime.run(
      uploadTile(
        {
          season: 3,
          tile: { x: 0, y: 0 },
          hash: await sha256Hex(canvas),
          observedAt: seconds(++observedAt),
          includeUnpublished: true,
          tokenHash: 'a'.repeat(64),
          wplaceUserId: 42,
          displayName: 'Painter',
        },
        canvas,
      ),
    )
  }
  // The first upload seeds the projection; the second is the incremental change subscribers get.
  await upload(2)
  const change = await upload(1)
  expect(change?.admin.invalidatedTiles).toEqual(['0/0'])
  expect(change?.public.invalidatedTiles ?? []).toEqual([])
})

it('wakes alarm subscribers only when an observation changes an alarm', async () => {
  const { app, sql, blobs, counters } = await createTestBackend()
  const form = new FormData()
  form.set('png', new File([await encodeIndexedPng(3, 1, new Uint8Array([1, 1, 1]))], 'art.png'))
  form.set('name', 'Alarmed')
  form.set('season', '3')
  form.set('originX', '10')
  form.set('originY', '20')
  expect(
    (await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))).status,
  ).toBe(201)
  let alarmNotifications = 0
  const readModel = new (class extends DirectStatusReadModel {
    async notifyAlarmChange(): Promise<void> {
      alarmNotifications++
    }
  })(sql)
  const runtime = createBackendRuntime(makeBackendContext(blobs, sql, counters, readModel))
  let observedAt = Math.floor(Date.now() / 1000)
  const observe = async (correct: number) => {
    const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
    indices.fill(1, 20010, 20010 + correct)
    const canvas = await encodeIndexedPng(1000, 1000, indices)
    await runtime.run(
      uploadTile(
        {
          season: 3,
          tile: { x: 0, y: 0 },
          hash: await sha256Hex(canvas),
          observedAt: seconds(++observedAt),
          includeUnpublished: true,
          tokenHash: 'a'.repeat(64),
          wplaceUserId: 42,
          displayName: 'Painter',
        },
        canvas,
      ),
    )
  }
  // Painting toward a new high-water mark moves no alarm.
  await observe(1)
  await observe(2)
  expect(alarmNotifications).toBe(0)
  // Losing a correct pixel opens one.
  await observe(1)
  expect(alarmNotifications).toBe(1)
  expect(await sql.readActiveAlarms(3, true)).toHaveLength(1)
})

it('wakes alarm subscribers from a tile scan only when it changes an alarm', async () => {
  const { app, sql, blobs, counters } = await createTestBackend()
  const form = new FormData()
  form.set('png', new File([await encodeIndexedPng(3, 1, new Uint8Array([1, 1, 1]))], 'art.png'))
  form.set('name', 'Scanned')
  form.set('season', '3')
  form.set('originX', '10')
  form.set('originY', '20')
  expect(
    (await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))).status,
  ).toBe(201)
  let alarmNotifications = 0
  const statusReadModel = new (class extends DirectStatusReadModel {
    async notifyAlarmChange(): Promise<void> {
      alarmNotifications++
    }
  })(sql)
  let now = Math.floor(Date.now() / 1000)
  const scan = async (correct: number) => {
    const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
    indices.fill(1, 20010, 20010 + correct)
    const canvas = await encodeIndexedPng(1000, 1000, indices)
    now += 60
    // Stands in for Wplace's tile server, which the scan reads over `fetch`.
    const fetchImpl = Object.assign(async () => new Response(canvas), {
      preconnect: fetch.preconnect,
    })
    await fetchCanvasTiles(
      { blobs, sql, counters, statusReadModel },
      { season: 3, now: seconds(now), fetchImpl },
    )
  }
  // A complete scan seeds the baseline, and a repeat moves no alarm.
  await scan(3)
  await scan(3)
  expect(alarmNotifications).toBe(0)
  await scan(2)
  expect(alarmNotifications).toBe(1)
  expect(await sql.readActiveAlarms(3, true)).toHaveLength(1)
})

it('wakes alarm subscribers for changes committed before a later alarm evaluation fails', async () => {
  const { app, sql, blobs, counters } = await createTestBackend()
  for (const originY of ['20', '21']) {
    const form = new FormData()
    form.set('png', new File([await encodeIndexedPng(3, 1, new Uint8Array([1, 1, 1]))], 'art.png'))
    form.set('name', `Row ${originY}`)
    form.set('season', '3')
    form.set('originX', '10')
    form.set('originY', originY)
    expect(
      (await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))).status,
    ).toBe(201)
  }
  let alarmNotifications = 0
  const statusReadModel = new (class extends DirectStatusReadModel {
    async notifyAlarmChange(): Promise<void> {
      alarmNotifications++
    }
  })(sql)
  const runtime = createBackendRuntime(makeBackendContext(blobs, sql, counters, statusReadModel))
  // Fails the second template's evaluation after the first has committed its alarm change.
  const evaluate = sql.evaluateTemplateAlarm.bind(sql)
  let failSecondEvaluation = false
  let evaluations = 0
  sql.evaluateTemplateAlarm = async (...args) => {
    if (failSecondEvaluation && ++evaluations === 2) throw new Error('evaluation failed')
    return await evaluate(...args)
  }
  let now = Math.floor(Date.now() / 1000)
  const canvas = async (correct: number) => {
    const indices = new Uint8Array(1000000).fill(TRANSPARENT_INDEX)
    indices.fill(1, 20010, 20010 + correct)
    indices.fill(1, 21010, 21010 + correct)
    return await encodeIndexedPng(1000, 1000, indices)
  }
  const observe = async (correct: number) => {
    const bytes = await canvas(correct)
    await runtime.run(
      uploadTile(
        {
          season: 3,
          tile: { x: 0, y: 0 },
          hash: await sha256Hex(bytes),
          observedAt: seconds(++now),
          includeUnpublished: true,
          tokenHash: 'a'.repeat(64),
          wplaceUserId: 42,
          displayName: 'Painter',
        },
        bytes,
      ),
    )
  }
  const scan = async (correct: number) => {
    const bytes = await canvas(correct)
    now += 60
    // Stands in for Wplace's tile server, which the scan reads over `fetch`.
    const fetchImpl = Object.assign(async () => new Response(bytes), {
      preconnect: fetch.preconnect,
    })
    await fetchCanvasTiles(
      { blobs, sql, counters, statusReadModel },
      { season: 3, now: seconds(now), fetchImpl },
    )
  }

  await observe(3)
  failSecondEvaluation = true
  await expect(observe(2)).rejects.toThrow()
  expect(alarmNotifications).toBe(1)

  // The observation opened one alarm; the scan clears it and fails on the other template.
  evaluations = 0
  await expect(scan(3)).rejects.toThrow('evaluation failed')
  expect(alarmNotifications).toBe(2)
})
