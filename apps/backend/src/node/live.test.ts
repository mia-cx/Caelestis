import { describe, expect, it } from 'vitest'
import type { CoordinatorStorage } from '../coordination/database.js'
import { NodeLiveHost } from './live.js'

const host = () =>
  new NodeLiveHost({} as CoordinatorStorage, () => ({
    webSocketMessage: () => undefined,
    webSocketClose: () => undefined,
  }))

describe('node live socket attachments', () => {
  it('hands every reader a frozen copy taken when the attachment was stored', () => {
    const { server } = host().connect({ season: 0, projections: [{ resource: 'x' }] })
    const source = { season: 1, projections: [{ resource: 'telemetry-alarms' }] }
    server.serializeAttachment(source)
    source.season = 2
    const projection = source.projections[0]
    if (projection !== undefined) projection.resource = 'changed'

    const first = server.deserializeAttachment() as typeof source
    expect(first).toEqual({ season: 1, projections: [{ resource: 'telemetry-alarms' }] })
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.projections)).toBe(true)
    expect(Object.isFrozen(first.projections[0])).toBe(true)
    expect(() => {
      ;(first as { season: number }).season = 3
    }).toThrow(TypeError)
  })
})
