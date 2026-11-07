import { millis, type TemplateStatus } from '@caelestis/shared'
import { describe, expect, it, vi } from 'vitest'
import { coordinatorDatabase } from '../src/adapters/node/coordinator-database.js'
import { SqlCoordinatorStorage } from '../src/adapters/node/coordinator-storage.js'
import { createKeyedStatusPersistence } from '../src/status-coordinator.js'
import { createSeasonStatusReadModel } from '../src/status-read-model/model.js'
import { createTileGenerationCache } from '../src/status-read-model/tile-generation-cache.js'
import { openRelationalStore } from './support/relational.js'

describe('tile generation cache', () => {
  it('does not let a losing or expired prepared commit overwrite the newest tile generation', async () => {
    let now = 1_000
    let sequence = 0
    const cache = createTileGenerationCache({
      now: () => now,
      ttlMilliseconds: 100,
      createCoverageToken: () => `coverage-${sequence++}`,
    })
    const tile = { x: 4, y: 8 }
    const first = cache.prepare(tile)
    const second = cache.prepare(tile)

    await cache.apply({
      tile,
      hash: 'new',
      observedAt: millis(2),
      commitOrder: 2,
      coverageToken: second.coverageToken,
      commitToken: second.commitToken,
      commitExpiresAt: second.commitExpiresAt,
      visibleToPublic: true,
      visibleToAdmin: true,
    })
    await cache.finish(tile, first)

    expect(await cache.resolve('public', [{ deliveryId: 'd', tile, hash: 'new' }])).toMatchObject({
      acknowledgedDeliveryIds: ['d'],
      unresolvedDeliveryIds: [],
    })

    now = first.commitExpiresAt + 1
    await cache.finish(tile, first)
    expect(await cache.resolve('public', [{ deliveryId: 'old', tile, hash: 'old' }])).toMatchObject(
      {
        unresolvedDeliveryIds: ['old'],
      },
    )
  })
})

describe('status projection', () => {
  it('keeps the public projection filtered while serving cache hits without another source read', async () => {
    let reads = 0
    let revision = 0
    const source = {
      read: async (_season: number, scope: 'public' | 'admin') => {
        reads++
        const published = {
          templateId: 'published',
          correct: 4,
          wrong: 1,
          blank: 0,
          total: 5,
          observedAt: millis(1),
        }
        const privateTemplate = {
          templateId: 'private',
          correct: 0,
          wrong: 5,
          blank: 0,
          total: 5,
          observedAt: millis(1),
        }
        return scope === 'public' ? [published] : [published, privateTemplate]
      },
    }
    let saved = false
    const model = createSeasonStatusReadModel({
      season: 1,
      source,
      persistence: {
        load: async () => null,
        save: async (state) => {
          void state
          saved = true
        },
      },
      revisions: {
        current: async () => revision,
        commit: async (_season, expected) => {
          if (expected !== revision) return null
          revision++
          return revision
        },
      },
    })

    expect(
      (await model.reconcileSnapshot('public')).snapshot.templates.map(
        (template) => template.templateId,
      ),
    ).toEqual(['published'])
    expect(
      (await model.reconcileSnapshot('admin')).snapshot.templates.map(
        (template) => template.templateId,
      ),
    ).toEqual(['published', 'private'])
    expect(reads).toBe(2)
    expect(saved).toBe(true)
    await model.reconcileSnapshot('admin')
    expect(reads).toBe(2)
  })
})

describe('status projection freshness', () => {
  it('rereads the source within one TTL of the last reconciliation, however often mutations land', async () => {
    let now = 0
    let revision = 0
    const model = createSeasonStatusReadModel({
      season: 1,
      now: () => now,
      ttlMilliseconds: 100,
      source: { read: async () => [] },
      persistence: { load: async () => null, save: async () => {} },
      revisions: {
        current: async () => revision,
        commit: async (_season, expected) => (expected === revision ? ++revision : null),
      },
    })
    await model.reconcileSnapshot('public')

    // A steady stream of incremental mutations, each inside the TTL of the one before it.
    for (now = 60; now < 200; now += 60) {
      await model.applyCommittedChange({
        baseRevision: revision,
        revision: ++revision,
        changes: [],
      })
    }
    expect((await model.reconcileSnapshot('public')).cacheOutcome).toBe('stale')
  })
})

describe('keyed status persistence', () => {
  it('writes only changed templates and a restart recovers the saved projection', async () => {
    const store = await openRelationalStore()
    try {
      const database = coordinatorDatabase(store.connection)
      await SqlCoordinatorStorage.initialize(database)
      const storage = new SqlCoordinatorStorage(database, 'season:1')
      await storage.put('status-read-model:v2:manifest', { season: 1 })
      const persistence = createKeyedStatusPersistence(storage, 1)
      // The older whole-season layout is dropped; the model rebuilds from its source.
      expect(await persistence.load()).toBeNull()
      expect(await storage.get('status-read-model:v2:manifest')).toBeUndefined()

      const status = (index: number, correct = 0): TemplateStatus => ({
        templateId: `template-${String(index).padStart(3, '0')}`,
        correct,
        wrong: 0,
        blank: 4 - correct,
        total: 4,
        observedAt: millis(index),
      })
      const templates = Array.from({ length: 100 }, (_, index) => status(index))
      const first = {
        season: 1,
        revision: 1,
        reconciledAt: 10,
        publicTemplates: templates.slice(0, 50),
        adminTemplates: templates,
      }
      await persistence.save(first)

      // One template progresses and one draft is deleted: the commit writes those, not the season.
      const progressed = status(7, 3)
      const replace = (list: readonly TemplateStatus[]) =>
        list
          .filter((held) => held.templateId !== 'template-099')
          .map((held) => (held.templateId === progressed.templateId ? progressed : held))
      const second = {
        ...first,
        revision: 2,
        publicTemplates: replace(first.publicTemplates),
        adminTemplates: replace(first.adminTemplates),
      }
      const puts = vi.spyOn(SqlCoordinatorStorage.prototype, 'put')
      const deletes = vi.spyOn(SqlCoordinatorStorage.prototype, 'delete')
      await persistence.save(second)
      expect(puts.mock.calls.map(([key]) => key).sort()).toEqual([
        'status-read-model:v3:admin:template-007',
        'status-read-model:v3:manifest',
        'status-read-model:v3:public:template-007',
      ])
      expect(deletes.mock.calls.map(([key]) => key)).toEqual([
        'status-read-model:v3:admin:template-099',
      ])
      puts.mockRestore()
      deletes.mockRestore()

      expect(await createKeyedStatusPersistence(storage, 1).load()).toEqual(second)
    } finally {
      await store.close()
    }
  })
})
