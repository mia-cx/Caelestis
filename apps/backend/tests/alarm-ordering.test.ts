import { encodeIndexedPng, millis, sha256Hex, TRANSPARENT_INDEX } from '@caelestis/shared'
import { expect, it } from 'vitest'
import { RelationalSqlStore } from '../src/adapters/relational-sql-store.js'
import { authorized, createTestBackend } from './support/backend.js'
import { openRelationalStore } from './support/relational.js'

it.each(['loss-first', 'recovery-first'])(
  'keeps recovered alarms closed after %s completion',
  async (order) => {
    const opened = await openRelationalStore()
    const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    const entered = [Promise.withResolvers<void>(), Promise.withResolvers<void>()]
    let delayed = false
    let evaluations = 0
    class DelayedAlarms extends RelationalSqlStore {
      override async evaluateTemplateAlarm(
        ...args: Parameters<RelationalSqlStore['evaluateTemplateAlarm']>
      ) {
        if (delayed) {
          const index = evaluations++
          entered[index]?.resolve()
          await gates[index]?.promise
        }
        return super.evaluateTemplateAlarm(...args)
      }
    }
    const pending: Promise<Response>[] = []
    try {
      const sql = new DelayedAlarms(opened.connection)
      const { app } = await createTestBackend({ sql })
      const form = new FormData()
      form.set('png', new File([await encodeIndexedPng(1, 1, new Uint8Array([1]))], 'art.png'))
      for (const [key, value] of Object.entries({
        name: 'Alarm ordering',
        season: '3',
        originX: '0',
        originY: '0',
      }))
        form.set(key, value)
      expect(
        (await app.fetch(authorized('/admin/templates', { method: 'POST', body: form }))).status,
      ).toBe(201)
      const at = Math.floor(Date.now() / 1000) - 10
      const upload = async (pixel: number, offset: number) => {
        const indices = new Uint8Array(1_000_000).fill(TRANSPARENT_INDEX)
        indices[0] = pixel
        const bytes = await encodeIndexedPng(1000, 1000, indices)
        return app.fetch(
          authorized(`/v1/telemetry/tiles/0/0/${await sha256Hex(bytes)}`, {
            method: 'PUT',
            body: bytes,
            headers: {
              'x-caelestis-season': '3',
              'x-caelestis-observed-at': String(at + offset),
              'x-caelestis-wplace-user-id': '42',
              'x-caelestis-display-name': 'Painter',
            },
          }),
        )
      }
      expect((await upload(1, 0)).status).toBe(200)
      delayed = true
      pending.push(upload(2, 1))
      await Promise.race([
        entered[0]?.promise,
        pending[0]?.then(() => {
          throw new Error('Loss upload bypassed alarm evaluation')
        }),
      ])
      pending.push(upload(1, 2))
      await Promise.race([
        entered[1]?.promise,
        pending[1]?.then(() => {
          throw new Error('Recovery upload bypassed alarm evaluation')
        }),
      ])
      // Both observations are committed. Delay only the real SQL alarm evaluation, then release each order.
      for (const index of order === 'loss-first' ? [0, 1] : [1, 0]) {
        gates[index]?.resolve()
        expect((await pending[index])?.status).toBe(200)
      }
      expect(await sql.readTemplateStatuses(3, true)).toMatchObject([{ correct: 1, wrong: 0 }])
      expect(await sql.readActiveAlarms(3, true)).toEqual([])
      expect(await sql.listDueAlarmProbes(millis(Date.now() + 86_400_000))).toEqual([])
    } finally {
      for (const gate of gates) gate.resolve()
      await Promise.allSettled(pending)
      await opened.close()
    }
  },
)
