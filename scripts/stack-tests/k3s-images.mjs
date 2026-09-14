import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { kubernetesRun } from './kubernetes-run.mjs'

const [mode, context, output, ...images] = process.argv.slice(2)
assert.ok(
  ['import', 'remove'].includes(mode) && context && output,
  'Usage: node scripts/stack-tests/k3s-images.mjs import|remove CONTEXT OUTPUT [IMAGE ...]',
)
const namespace = `caelestis-test-images-${Date.now().toString(36)}`
const cluster = kubernetesRun({ context, namespace, output: resolve(output, namespace) })
const file = resolve(output, 'images.json')
const kubectl = (...args) =>
  execFileSync('kubectl', ['--context', context, '-n', namespace, ...args], {
    encoding: 'utf8',
    timeout: 240_000,
  }).trim()
const record =
  mode === 'import'
    ? {
        context,
        nodes: JSON.parse(kubectl('get', 'nodes', '-o', 'json')).items.map((n) => n.metadata.name),
        images: images.map((image) => (image.includes('/') ? image : `docker.io/library/${image}`)),
        identities: images
          .map(
            (image) =>
              JSON.parse(
                execFileSync('docker', ['image', 'inspect', image], { encoding: 'utf8' }),
              )[0],
          )
          .map((i) => ({ id: i.Id, digests: i.RepoDigests })),
      }
    : JSON.parse(readFileSync(file, 'utf8'))
assert.equal(record.context, context)
assert.ok(record.images.length > 0)
let cleaning
const cleanup = () => (cleaning ??= Promise.resolve().then(() => cluster.cleanup()))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    void cleanup().then(
      () => process.exit(130),
      (error) => {
        console.error(error)
        process.exit(1)
      },
    )
  })
try {
  cluster.create()
  if (mode === 'import') writeFileSync(file, JSON.stringify(record, null, 2))
  for (const [index, node] of record.nodes.entries()) {
    const pod = `image-transfer-${index}`
    execFileSync('kubectl', ['--context', context, '-n', namespace, 'create', '-f', '-'], {
      input: JSON.stringify({
        apiVersion: 'v1',
        kind: 'Pod',
        metadata: { name: pod },
        spec: {
          nodeName: node,
          restartPolicy: 'Never',
          automountServiceAccountToken: false,
          containers: [
            {
              name: 'transfer',
              image: 'alpine:3.22',
              command: ['sleep', '3600'],
              resources: {
                requests: { cpu: '10m', memory: '32Mi' },
                limits: { cpu: '1', memory: '256Mi' },
              },
              securityContext: { allowPrivilegeEscalation: false, capabilities: { drop: ['ALL'] } },
              volumeMounts: [
                { name: 'k3s', mountPath: '/k3s', readOnly: true },
                { name: 'socket', mountPath: '/containerd.sock', readOnly: true },
              ],
            },
          ],
          volumes: [
            { name: 'k3s', hostPath: { path: '/usr/local/bin/k3s', type: 'File' } },
            {
              name: 'socket',
              hostPath: { path: '/run/k3s/containerd/containerd.sock', type: 'Socket' },
            },
          ],
        },
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30_000,
    })
    kubectl('wait', '--for=condition=Ready', `pod/${pod}`, '--timeout=120s')
    const ctr = [
      'exec',
      pod,
      '--',
      '/k3s',
      'ctr',
      '--address',
      '/containerd.sock',
      '--namespace',
      'k8s.io',
    ]
    if (mode === 'import') {
      const before = kubectl(...ctr, 'images', 'list', '-q').split('\n')
      assert.ok(
        record.images.every((image) => !before.includes(image)),
        'Refusing to overwrite existing image references',
      )
      const source = spawn('docker', ['save', ...images], { stdio: ['ignore', 'pipe', 'inherit'] })
      const target = spawn(
        'kubectl',
        [
          '--context',
          context,
          '-n',
          namespace,
          'exec',
          '-i',
          pod,
          '--',
          '/k3s',
          'ctr',
          '--address',
          '/containerd.sock',
          '--namespace',
          'k8s.io',
          'images',
          'import',
          '--all-platforms',
          '-',
        ],
        { stdio: ['pipe', 'inherit', 'inherit'] },
      )
      source.stdout.pipe(target.stdin)
      const results = await Promise.all([once(source, 'close'), once(target, 'close')])
      for (const [code] of results) assert.equal(code, 0)
      const after = kubectl(...ctr, 'images', 'list', '-q').split('\n')
      assert.ok(record.images.every((image) => after.includes(image)))
      console.log(`Imported test images on ${node}`)
    } else {
      kubectl(...ctr, 'images', 'remove', ...record.images)
      const after = kubectl(...ctr, 'images', 'list', '-q').split('\n')
      assert.ok(record.images.every((image) => !after.includes(image)))
      console.log(`Removed test image references on ${node}`)
    }
    kubectl('delete', 'pod', pod, '--wait=true', '--timeout=60s')
  }
  if (mode === 'remove') {
    record.cleanedAt = new Date().toISOString()
    writeFileSync(file, JSON.stringify(record, null, 2))
  }
} finally {
  await cleanup()
}
