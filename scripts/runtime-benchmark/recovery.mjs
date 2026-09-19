import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Supporting coordinator benchmark: real compiled code and SQLite, restored socket attachments.
// It measures recovery preparation, not network delivery or a deployed Workers runtime.
const [baseline, candidate, output] = process.argv.slice(2)
assert(baseline && candidate && output)
const surface = { kind: 'world', allianceId: null }
const identity = (index) => ({
  tokenHash: String(Math.floor(index / 16) % 2).repeat(64),
  actorId: index % 16,
})
const results = []
for (const claims of [37, 512]) {
  for (let pair = 0; pair < 3; pair++) {
    for (const variant of pair % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) {
      const root = resolve(variant === 'baseline' ? baseline : candidate)
      const load = (file) => import(pathToFileURL(`${root}/${file}`).href)
      const [
        { PresenceCoordinator },
        { sqliteConnection },
        { RelationalSqlStore },
        { IngestTimings },
      ] = await Promise.all([
        load('presence-coordinator.js'),
        load('node/database.js'),
        load('adapters/relational-sql-store.js'),
        load('telemetry/ingest-timing.js'),
      ])
      const database = sqliteConnection(':memory:')
      try {
        database.migrate(resolve('apps/backend/migrations'))
        const sql = new RelationalSqlStore(database)
        const expected = []
        for (let index = 0; index < claims; index++) {
          const id = `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`
          const owner = identity(index)
          expected.push({ id, ...owner })
          assert(
            await sql.regions.createRegion(
              {
                id,
                season: 0,
                surface,
                rect: { x: index * 8, y: 0, w: 8, h: 8 },
                document: {
                  items: [
                    {
                      id: 'shape',
                      op: 'add',
                      shape: { kind: 'rectangle', x: index * 8, y: 0, w: 8, h: 8 },
                    },
                  ],
                },
                claimant: { wplaceUserId: owner.actorId, displayName: `Painter ${owner.actorId}` },
                label: '',
                createdAt: Date.now(),
                expiresAt: Date.now() + 86_400_000,
              },
              owner.tokenHash,
            ),
          )
        }
        const samples = []
        for (let repeat = -1; repeat < 5; repeat++) {
          const now = Date.now()
          const sockets = Array.from({ length: 256 }, (_, index) => {
            const owner = identity(index)
            let attachment = {
              sessionId: String(index).padStart(4, '0'),
              season: 0,
              surface,
              painter: { wplaceUserId: owner.actorId, displayName: `Painter ${owner.actorId}` },
              tokenHash: owner.tokenHash,
              clientHash: String(index).padStart(64, '0'),
              credentialScope: 'report',
              anonymous: index === 255,
              revocable: false,
              viewport: { x: 0, y: 0, w: 128, h: 128 },
              draftRect: null,
              draftPixels: 0,
              lastSeenAt: now,
              renewedAt: now,
            }
            return {
              readyState: 1,
              messages: [],
              send(message) {
                this.messages.push(message)
              },
              close() {
                assert.fail('Fresh recovery socket closed')
              },
              deserializeAttachment: () => attachment,
              serializeAttachment: (value) => {
                attachment = value
              },
            }
          })
          const timings = new IngestTimings()
          const room = new PresenceCoordinator(
            {
              getWebSockets: () => sockets,
              storage: {
                get: async () => undefined,
                getAlarm: async () => null,
                setAlarm: async () => {},
              },
            },
            sql,
            timings,
          )
          const cpu = process.cpuUsage()
          const started = performance.now()
          await room.alarm()
          const wallMs = performance.now() - started
          const used = process.cpuUsage(cpu)
          const stages = timings.snapshot()
          room.stop()
          for (const socket of sockets) {
            assert.equal(socket.messages.length, 1)
            const ready = JSON.parse(socket.messages[0])
            const attachment = socket.deserializeAttachment()
            assert.equal(ready.type, 'presence-ready')
            assert.equal(ready.regions.length, claims)
            assert.equal(ready.peers.length, 64)
            assert.deepEqual(
              ready.ownedRegionIds.sort(),
              expected
                .filter(
                  (owner) =>
                    !attachment.anonymous &&
                    owner.tokenHash === attachment.tokenHash &&
                    owner.actorId === attachment.painter.wplaceUserId,
                )
                .map(({ id }) => id)
                .sort(),
            )
          }
          if (repeat >= 0) samples.push({ wallMs, cpuMs: (used.user + used.system) / 1000, stages })
        }
        results.push({
          pair,
          variant,
          claims,
          sockets: 256,
          runtime: process.versions,
          samples,
          coordinatorSha256: createHash('sha256')
            .update(await readFile(`${root}/presence-coordinator.js`))
            .digest('hex'),
          correctness: true,
        })
        await writeFile(output, JSON.stringify(results, null, 2))
        console.log(
          `${claims} claims ${pair} ${variant}: ${samples.map(({ wallMs }) => wallMs.toFixed(1)).join('/')} ms`,
        )
      } finally {
        await database.close()
      }
    }
  }
}
