import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { waitFor } from './acceptance.mjs'

const ownerLabel = 'caelestis.test/run'

/** Own one namespace on an existing cluster, with a durable cleanup inventory. */
export function kubernetesRun({ context, namespace, output, resume = false }) {
  assert.match(namespace, /^caelestis-test-[a-z0-9-]+$/)
  assert.ok(context, 'An explicit Kubernetes context is required')
  mkdirSync(output, { recursive: true })
  const file = resolve(output, 'inventory.json')
  const command = (...args) =>
    execFileSync('kubectl', ['--context', context, ...args], {
      encoding: 'utf8',
      timeout: 240_000,
    }).trim()
  const json = (...args) => JSON.parse(command(...args, '-o', 'json'))
  const server = JSON.parse(command('config', 'view', '--minify', '-o', 'json')).clusters[0].cluster
    .server
  const inventory = resume
    ? JSON.parse(readFileSync(file, 'utf8'))
    : {
        context,
        namespace,
        server,
        run: randomUUID(),
        volumes: [],
        resources: [],
      }
  assert.equal(inventory.context, context)
  assert.equal(inventory.namespace, namespace)
  assert.equal(inventory.server, server, 'Cluster endpoint changed; inspect before cleanup')
  const save = () => writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`)
  const owned = () => {
    const raw = command('get', 'namespace', namespace, '--ignore-not-found', '-o', 'json')
    if (!raw) return false
    const ns = JSON.parse(raw)
    assert.equal(ns.metadata.labels?.[ownerLabel], inventory.run, 'Namespace ownership mismatch')
    if (inventory.uid) assert.equal(ns.metadata.uid, inventory.uid, 'Namespace was replaced')
    return true
  }
  const captureVolumes = () => {
    const current = json('get', 'pv').items.filter(
      (pv) => pv.spec.claimRef?.namespace === namespace,
    )
    for (const pv of current) {
      assert.equal(
        pv.spec.persistentVolumeReclaimPolicy,
        'Delete',
        `PV ${pv.metadata.name} requires manual storage cleanup`,
      )
      assert.equal(
        pv.spec.csi?.driver,
        'driver.longhorn.io',
        'This driver verifies Longhorn backing storage only',
      )
      if (!inventory.volumes.some((v) => v.name === pv.metadata.name))
        inventory.volumes.push({
          name: pv.metadata.name,
          uid: pv.metadata.uid,
          handle: pv.spec.csi.volumeHandle,
        })
    }
    save()
  }
  return {
    context,
    namespace,
    inventory,
    file,
    create() {
      save() // Record identity before the first cluster mutation, including interrupted creates.
      execFileSync('kubectl', ['--context', context, 'create', '-f', '-'], {
        input: JSON.stringify({
          apiVersion: 'v1',
          kind: 'Namespace',
          metadata: {
            name: namespace,
            labels: { [ownerLabel]: inventory.run },
          },
        }),
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 30_000,
      })
      inventory.uid = json('get', 'namespace', namespace).metadata.uid
      save()
    },
    capture() {
      if (!owned()) return
      captureVolumes()
      inventory.resources = []
      const types = command(
        'api-resources',
        '--namespaced=true',
        '--verbs=list',
        '-o',
        'name',
      ).split('\n')
      for (const type of types) {
        const metadata = command(
          'get',
          type,
          '-n',
          namespace,
          '-o',
          'jsonpath={range .items[*]}{.metadata.name}{"\\t"}{.metadata.uid}{"\\n"}{end}',
        )
        for (const row of metadata ? metadata.split('\n') : []) {
          const [name, uid] = row.split('\t')
          inventory.resources.push({ type, name, uid })
        }
      }
      save()
    },
    async cleanup() {
      if (owned()) {
        captureVolumes()
        command('delete', 'namespace', namespace, '--wait=true', '--timeout=180s')
      }
      assert.equal(command('get', 'namespace', namespace, '--ignore-not-found', '-o', 'name'), '')
      for (const volume of inventory.volumes) {
        await waitFor(
          () => command('get', 'pv', volume.name, '--ignore-not-found', '-o', 'name') === '',
          `PV deletion: ${volume.name}`,
        )
        await waitFor(
          () =>
            command(
              'get',
              'volumes.longhorn.io',
              volume.handle,
              '-n',
              'longhorn-system',
              '--ignore-not-found',
              '-o',
              'name',
            ) === '',
          `Longhorn volume deletion: ${volume.handle}`,
        )
        for (const type of ['replicas.longhorn.io', 'engines.longhorn.io']) {
          assert.equal(
            json('get', type, '-n', 'longhorn-system', '-l', `longhornvolume=${volume.handle}`)
              .items.length,
            0,
          )
        }
      }
      inventory.cleanedAt = new Date().toISOString()
      save()
      rmSync(resolve(output, 'credentials.json'), { force: true })
    },
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [file] = process.argv.slice(2)
  assert.ok(file, 'Usage: node scripts/stack-tests/kubernetes-run.mjs INVENTORY_JSON')
  const inventory = JSON.parse(readFileSync(file, 'utf8'))
  await kubernetesRun({ ...inventory, output: resolve(file, '..'), resume: true }).cleanup()
  console.log(`Verified cleanup of ${inventory.namespace}`)
}
