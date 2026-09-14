import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { acceptance, waitFor } from './stack-tests/acceptance.mjs'
import { kubernetesRun } from './stack-tests/kubernetes-run.mjs'
import { availablePort, run, start } from './stack-tests/process.mjs'
import { importWplace, verifyWplace } from './stack-tests/wplace.mjs'

const [backend, frontend, stack] = process.argv.slice(2)
if (!backend || !frontend || !['sqlite', 'cnpg', 'mariadb'].includes(stack))
  throw new Error(
    'Usage: node scripts/test-helm-stack.mjs BACKEND_IMAGE FRONTEND_IMAGE sqlite|cnpg|mariadb',
  )
const context = process.env.CAELESTIS_KUBE_CONTEXT
const storage = process.env.CAELESTIS_TEST_STORAGE ?? (stack === 'sqlite' ? 'filesystem' : 's3')
assert.ok(['filesystem', 's3'].includes(storage))
const keep = process.env.CAELESTIS_TEST_KEEP === 'true'
assert.ok(!keep || context, 'Keeping a stack requires an explicit existing cluster context')
const origin = process.env.CAELESTIS_TEST_ORIGIN
  ? new URL(process.env.CAELESTIS_TEST_ORIGIN)
  : undefined
assert.ok(!keep || origin, 'Keeping a stack requires CAELESTIS_TEST_ORIGIN')
if (origin) {
  assert.ok(context, 'Traefik acceptance requires an explicit existing cluster context')
  assert.equal(origin.protocol, 'https:')
  assert.match(origin.hostname, /^[a-z0-9.-]+$/)
}
const name = context
  ? `caelestis-test-${stack}-${storage}-${Date.now().toString(36)}`
  : `caelestis-ci-${process.pid}`
const directory = mkdtempSync(`${tmpdir()}/${name}-`)
const output = resolve(context ? `test-results/${name}` : `test-results/helm-${stack}`)
rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
const log = `${output}/provision.log`
const env = context ? { ...process.env } : { ...process.env, KUBECONFIG: `${directory}/kubeconfig` }
const cluster = context ? kubernetesRun({ context, namespace: name, output }) : undefined
const kubeArgs = context ? ['--context', context, '--namespace', name] : []
const namespace = context ? name : 'default'
const adminToken = randomBytes(32).toString('hex')
const readToken = randomBytes(32).toString('hex')
const s3Password = randomBytes(32).toString('hex')
const mariaPassword = randomBytes(32).toString('hex')
const kind = process.env.KIND ?? 'kind'
const kubectl = (...args) =>
  execFileSync('kubectl', [...kubeArgs, ...args], {
    env,
    encoding: 'utf8',
    timeout: 240_000,
  }).trim()
const apply = (...items) =>
  execFileSync('kubectl', [...kubeArgs, 'apply', '-f', '-'], {
    env,
    input: JSON.stringify({ apiVersion: 'v1', kind: 'List', items }),
    encoding: 'utf8',
  })
const secret = (name, stringData) => ({
  apiVersion: 'v1',
  kind: 'Secret',
  metadata: { name },
  stringData,
})
const service = (name, port) => ({
  apiVersion: 'v1',
  kind: 'Service',
  metadata: { name },
  spec: { selector: { app: name }, ports: [{ port }] },
})
const claim = (name) => ({
  apiVersion: 'v1',
  kind: 'PersistentVolumeClaim',
  metadata: { name },
  spec: {
    accessModes: ['ReadWriteOnce'],
    resources: { requests: { storage: '1Gi' } },
    ...(context ? { storageClassName: 'longhorn-single' } : {}),
  },
})
const workload = (name, image, port, variables, args = [], volumes = []) => ({
  apiVersion: 'apps/v1',
  kind: 'Deployment',
  metadata: { name },
  spec: {
    replicas: 1,
    selector: { matchLabels: { app: name } },
    template: {
      metadata: { labels: { app: name } },
      spec: {
        automountServiceAccountToken: false,
        containers: [
          {
            name,
            image,
            args,
            env: Object.entries(variables).map(([name, value]) => ({ name, value })),
            ports: [{ containerPort: port }],
            resources: {
              requests: { cpu: '100m', memory: '128Mi' },
              limits: { cpu: '1', memory: '1Gi' },
            },
            readinessProbe: {
              ...(name === 's3'
                ? { httpGet: { path: '/minio/health/ready', port } }
                : { tcpSocket: { port } }),
              periodSeconds: 2,
            },
            volumeMounts: volumes.map(({ name, mountPath }) => ({ name, mountPath })),
          },
        ],
        volumes: volumes.map(({ name, secret, claim }) => ({
          name,
          ...(secret
            ? { secret: { secretName: secret } }
            : { persistentVolumeClaim: { claimName: claim } }),
        })),
      },
    },
  },
})
const imageValues = (image) => {
  const colon = image.lastIndexOf(':')
  assert.ok(colon > image.lastIndexOf('/'), 'Test images must have an explicit tag')
  return { repository: image.slice(0, colon), tag: image.slice(colon + 1), pullPolicy: 'Never' }
}
let forward
let created = false
let passed = false
let cleanupPromise
const cleanup = () =>
  (cleanupPromise ??= (async () => {
    await forward?.stop()
    if (created) {
      for (const [file, args] of [
        ['pods', ['get', 'pods', '-o', 'wide']],
        ['events', ['get', 'events', '--sort-by=.lastTimestamp']],
        ['backend', ['logs', 'deployment/test-caelestis', '-c', 'backend', '--tail=300']],
        ['frontend', ['logs', 'deployment/test-caelestis', '-c', 'frontend', '--tail=300']],
      ]) {
        const result = spawnSync('kubectl', [...kubeArgs, ...args], {
          env,
          encoding: 'utf8',
          timeout: 30_000,
        })
        const text = (result.stdout ?? '') + (result.stderr ?? '')
        writeFileSync(
          `${output}/${file}.log`,
          [adminToken, readToken, s3Password, mariaPassword].reduce(
            (text, secret) => text.replaceAll(secret, '[REDACTED]'),
            text,
          ),
        )
      }
    }
    try {
      if (cluster) {
        try {
          cluster.capture()
        } finally {
          if (!passed || !keep) await cluster.cleanup()
        }
      } else {
        await run(kind, ['delete', 'cluster', '--name', name], { env, log })
      }
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })())
for (const signal of ['SIGINT', 'SIGTERM'])
  process.once(signal, () => {
    passed = false
    void cleanup().then(
      () => process.exit(130),
      (error) => {
        console.error(error)
        process.exit(1)
      },
    )
  })
try {
  if (cluster) {
    const storageClass = JSON.parse(kubectl('get', 'storageclass', 'longhorn-single', '-o', 'json'))
    assert.equal(storageClass.provisioner, 'driver.longhorn.io')
    assert.equal(storageClass.reclaimPolicy, 'Delete')
    cluster.create()
    created = true
    console.log(`Testing ${stack}/${storage} in ${name}; cleanup inventory: ${cluster.file}`)
  } else {
    await run(
      kind,
      [
        'create',
        'cluster',
        '--name',
        name,
        '--kubeconfig',
        env.KUBECONFIG,
        '--image',
        'kindest/node:v1.35.8@sha256:07b2536e30b803ed61d1677a79df6115f798ce64c80f9e22f6ed45afd09323c0',
        '--wait',
        '180s',
      ],
      { env, log, timeout: 360_000 },
    )
    created = true
    await run(kind, ['load', 'docker-image', '--name', name, backend, frontend], { env, log })
  }
  apply(
    secret('caelestis-server', {
      ADMIN_TOKEN: adminToken,
      CAELESTIS_READ_TOKEN: readToken,
    }),
  )
  const values = {
    image: imageValues(backend),
    frontend: { image: imageValues(frontend) },
    server: { origin: process.env.CAELESTIS_TEST_ORIGIN ?? '', name: 'Caelestis k3s test' },
    ingress: { enabled: false },
    persistence: {
      enabled: stack === 'sqlite' || storage === 'filesystem',
      size: '1Gi',
      ...(context ? { storageClass: 'longhorn-single' } : {}),
    },
  }
  const files = []
  if (stack !== 'sqlite') {
    files.push('-f', `deploy/helm/${stack}-s3.example.yaml`)
    values.database = {
      host: stack === 'cnpg' ? `caelestis-db-rw.${namespace}.svc` : `mariadb.${namespace}.svc`,
    }
  }
  values.storage = {
    adapter: storage,
    s3: { existingSecret: storage === 's3' ? 'caelestis-s3' : '' },
  }
  if (storage === 's3') {
    apply(
      secret('caelestis-s3', {
        AWS_ACCESS_KEY_ID: 'stack-test',
        AWS_SECRET_ACCESS_KEY: s3Password,
      }),
      service('s3', 9000),
      claim('s3'),
      workload(
        's3',
        'quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e',
        9000,
        { MINIO_ROOT_USER: 'stack-test', MINIO_ROOT_PASSWORD: s3Password },
        ['server', '/data'],
        [{ name: 'data', claim: 's3', mountPath: '/data' }],
      ),
    )
    kubectl('rollout', 'status', 'deployment/s3', '--timeout=180s')
    apply({
      apiVersion: 'batch/v1',
      kind: 'Job',
      metadata: { name: 'bucket' },
      spec: {
        backoffLimit: 0,
        template: {
          spec: {
            restartPolicy: 'Never',
            containers: [
              {
                name: 'bucket',
                image: backend,
                imagePullPolicy: 'Never',
                workingDir: '/app/apps/backend',
                envFrom: [{ secretRef: { name: 'caelestis-s3' } }],
                command: [
                  'node',
                  '--input-type=module',
                  '-e',
                  `import {createRequire} from 'node:module';
                  import {setTimeout} from 'node:timers/promises';
                  const deadline=Date.now()+60000;
                  for(;;) {
                    try { if((await fetch('http://s3:9000/minio/health/ready',{signal:AbortSignal.timeout(3000)})).ok) break; } catch {}
                    if(Date.now()>deadline) throw new Error('MinIO service routing did not become ready');
                    await setTimeout(1000);
                  }
                  const {S3Client,CreateBucketCommand}=createRequire(import.meta.resolve('@caelestis/storage/s3'))('@aws-sdk/client-s3');
                  const client=new S3Client({endpoint:'http://s3:9000',region:'us-east-1',forcePathStyle:true});
                  await client.send(new CreateBucketCommand({Bucket:'caelestis'})); client.destroy();`,
                ],
              },
            ],
          },
        },
      },
    })
    kubectl('wait', '--for=condition=complete', 'job/bucket', '--timeout=90s')
    Object.assign(values.storage.s3, {
      endpoint: 'http://s3:9000',
      bucket: 'caelestis',
      forcePathStyle: true,
    })
  }
  if (stack === 'cnpg') {
    if (!context) {
      await run(
        'kubectl',
        [
          'apply',
          '--server-side',
          '-f',
          'https://raw.githubusercontent.com/cloudnative-pg/artifacts/0a96e6b4debcc6a0a01ea8e7e52dbacd9fe7fab2/manifests/operator-manifest.yaml',
        ],
        { env, log },
      )
      kubectl(
        'rollout',
        'status',
        'deployment/cnpg-controller-manager',
        '-n',
        'cnpg-system',
        '--timeout=180s',
      )
    } else {
      kubectl('get', 'crd', 'clusters.postgresql.cnpg.io')
    }
    apply({
      apiVersion: 'postgresql.cnpg.io/v1',
      kind: 'Cluster',
      metadata: { name: 'caelestis-db' },
      spec: {
        instances: process.env.CAELESTIS_TEST_EXTENDED === 'true' ? 2 : 1,
        imageName:
          'ghcr.io/cloudnative-pg/postgresql:17.6@sha256:30b304a2e300ed80b6d1b740e4369e9b0f25599fb518de78c01fd9f25531791b',
        storage: { size: '1Gi', ...(context ? { storageClass: 'longhorn-single' } : {}) },
        resources: {
          requests: { cpu: '100m', memory: '256Mi' },
          limits: { cpu: '1', memory: '1Gi' },
        },
        bootstrap: { initdb: { database: 'caelestis', owner: 'caelestis' } },
      },
    })
    kubectl('wait', '--for=condition=Ready', 'cluster/caelestis-db', '--timeout=240s')
  }
  if (stack === 'mariadb') {
    execFileSync(
      'openssl',
      [
        'req',
        '-x509',
        '-newkey',
        'rsa:2048',
        '-nodes',
        '-days',
        '2',
        '-keyout',
        `${directory}/key.pem`,
        '-out',
        `${directory}/cert.pem`,
        '-subj',
        `/CN=mariadb.${namespace}.svc`,
        '-addext',
        `subjectAltName=DNS:mariadb.${namespace}.svc`,
      ],
      { stdio: 'ignore' },
    )
    apply(
      secret('caelestis-mariadb', {
        username: 'caelestis',
        password: mariaPassword,
        database: 'caelestis',
      }),
      secret('mariadb-ca', { 'ca.crt': readFileSync(`${directory}/cert.pem`, 'utf8') }),
      secret('mariadb-tls', {
        'ca.crt': readFileSync(`${directory}/cert.pem`, 'utf8'),
        'tls.crt': readFileSync(`${directory}/cert.pem`, 'utf8'),
        'tls.key': readFileSync(`${directory}/key.pem`, 'utf8'),
      }),
      service('mariadb', 3306),
      claim('mariadb'),
      workload(
        'mariadb',
        'mariadb:11.8@sha256:2d2f4095530294735a857cfe22bb101e19b0849b416911c796ec4aa81b164a62',
        3306,
        {
          MARIADB_DATABASE: 'caelestis',
          MARIADB_USER: 'caelestis',
          MARIADB_PASSWORD: mariaPassword,
          MARIADB_RANDOM_ROOT_PASSWORD: '1',
        },
        [
          '--ssl-ca=/tls/ca.crt',
          '--ssl-cert=/tls/tls.crt',
          '--ssl-key=/tls/tls.key',
          '--require-secure-transport=ON',
        ],
        [
          { name: 'tls', secret: 'mariadb-tls', mountPath: '/tls' },
          { name: 'data', claim: 'mariadb', mountPath: '/var/lib/mysql' },
        ],
      ),
    )
    kubectl('rollout', 'status', 'deployment/mariadb', '--timeout=180s')
  }
  const override = `${directory}/values.json`
  writeFileSync(override, JSON.stringify(values))
  const helm = (...args) =>
    run(
      'helm',
      [
        ...(context ? ['--kube-context', context, '--namespace', name] : []),
        'upgrade',
        '--install',
        'test',
        'deploy/helm/caelestis',
        ...files,
        '-f',
        override,
        ...args,
      ],
      { env, log },
    )
  await helm('--wait', '--timeout', '4m')
  cluster?.capture()
  const port = await availablePort()
  const site = `http://127.0.0.1:${port}`
  const connect = async () => {
    await forward?.stop()
    forward = start(
      'kubectl',
      [
        ...kubeArgs,
        'port-forward',
        'service/test-caelestis',
        `${port}:80`,
        '--address',
        '127.0.0.1',
      ],
      { env, log },
    )
    await waitFor(
      async () =>
        (await fetch(`${site}/api/v1/manifest`, { signal: AbortSignal.timeout(3000) })).ok,
      'Helm frontend',
    )
  }
  if (origin)
    apply({
      apiVersion: 'traefik.io/v1alpha1',
      kind: 'IngressRoute',
      metadata: { name: 'caelestis' },
      spec: {
        entryPoints: ['websecure'],
        routes: [
          {
            kind: 'Rule',
            match: `Host(\`${origin.hostname}\`)`,
            services: [{ name: 'test-caelestis', port: 80 }],
          },
        ],
        tls: {},
      },
    })
  await connect()
  const suite = acceptance({ site, adminToken, readToken })
  const state = await suite.seed()
  const publicSuite = origin
    ? acceptance({ site: origin.origin, adminToken, readToken })
    : undefined
  const api = `${site}/backend/v1`
  const template = process.env.CAELESTIS_TEST_WPLACE
    ? await importWplace({ api, adminToken, filename: process.env.CAELESTIS_TEST_WPLACE })
    : undefined
  const verify = async () => {
    await suite.verify(state)
    if (publicSuite) {
      await waitFor(
        async () => (await fetch(`${origin.origin}/health/ready`)).ok,
        'Traefik frontend',
      )
      await publicSuite.verify(state)
    }
    if (template) await verifyWplace({ api, readToken, template })
  }
  await verify()
  const frontendEnv = kubectl(
    'exec',
    'deployment/test-caelestis',
    '-c',
    'frontend',
    '--',
    'node',
    '-e',
    'console.log(JSON.stringify(Object.keys(process.env)))',
  )
  assert.ok(
    !JSON.parse(frontendEnv).some((name) =>
      /^(ADMIN_TOKEN|PGPASSWORD|MARIADB_PASSWORD|DATABASE_URL)$/.test(name),
    ),
  )
  kubectl('delete', 'pod', '-l', 'app.kubernetes.io/instance=test', '--wait=true')
  kubectl('rollout', 'status', 'deployment/test-caelestis', '--timeout=180s')
  await connect()
  await verify()
  if (stack === 'cnpg' && process.env.CAELESTIS_TEST_EXTENDED === 'true') {
    const backendRestarts = () =>
      JSON.parse(
        kubectl('get', 'pods', '-l', 'app.kubernetes.io/instance=test', '-o', 'json'),
      ).items[0].status.containerStatuses.find((container) => container.name === 'backend')
        .restartCount
    const before = backendRestarts()
    const primary = kubectl(
      'get',
      'cluster',
      'caelestis-db',
      '-o',
      'jsonpath={.status.currentPrimary}',
    )
    const replicas = JSON.parse(
      kubectl('get', 'pods', '-l', 'cnpg.io/cluster=caelestis-db', '-o', 'json'),
    ).items
    const replacement = replicas.find((pod) => pod.metadata.name !== primary).metadata.name
    kubectl(
      'patch',
      'cluster',
      'caelestis-db',
      '--type=merge',
      '-p',
      JSON.stringify({ status: { targetPrimary: replacement } }),
      '--subresource=status',
    )
    await waitFor(
      () =>
        kubectl('get', 'cluster', 'caelestis-db', '-o', 'jsonpath={.status.currentPrimary}') ===
        replacement,
      'CNPG switchover',
      180_000,
    )
    kubectl('wait', '--for=condition=Ready', 'cluster/caelestis-db', '--timeout=180s')
    await waitFor(() => backendRestarts() > before, 'backend restart after primary connection loss')
    await connect()
    await verify()
  }
  if (stack === 'mariadb' && process.env.CAELESTIS_TEST_EXTENDED === 'true') {
    kubectl(
      'exec',
      'deployment/mariadb',
      '--',
      'sh',
      '-c',
      'export MYSQL_PWD="$MARIADB_PASSWORD"; kills=$(mariadb --ssl --skip-ssl-verify-server-cert -h 127.0.0.1 -u "$MARIADB_USER" "$MARIADB_DATABASE" -N -e "SELECT CONCAT(\'KILL \',ID,\';\') FROM information_schema.PROCESSLIST WHERE ID != CONNECTION_ID() AND USER = \'caelestis\'"); test -n "$kills" && mariadb --ssl --skip-ssl-verify-server-cert -h 127.0.0.1 -u "$MARIADB_USER" "$MARIADB_DATABASE" -e "$kills"',
    )
    await waitFor(
      () =>
        JSON.parse(
          kubectl('get', 'pods', '-l', 'app.kubernetes.io/instance=test', '-o', 'json'),
        ).items[0].status.containerStatuses.find((c) => c.name === 'backend').restartCount > 0,
      'backend restart after MariaDB connection loss',
    )
    await connect()
    await verify()
  }
  await forward.stop()
  kubectl('scale', 'deployment/test-caelestis', '--replicas=0')
  kubectl('wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/instance=test', '--timeout=90s')
  await helm(
    '--set',
    'replicaCount=0,migration.enabled=true',
    '--wait',
    '--wait-for-jobs',
    '--timeout',
    '4m',
  )
  await helm('--wait', '--timeout', '4m')
  await connect()
  await verify()
  await suite.remove(state)
  if (keep && origin) {
    const response = await fetch(`${api}/admin/tokens`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'Mia laptop test', scope: 'report' }),
    })
    assert.equal(response.status, 201)
    const token = await response.json()
    writeFileSync(
      `${output}/credentials.json`,
      JSON.stringify({
        site: origin.origin,
        backend: `${origin.origin}/backend`,
        adminToken,
        reportToken: token.token,
      }),
      { mode: 0o600 },
    )
    writeFileSync(`${output}/values.json`, JSON.stringify(values, null, 2))
    writeFileSync(
      `${output}/ingressroute.json`,
      kubectl('get', 'ingressroute', 'caelestis', '-o', 'json'),
    )
  }
  writeFileSync(
    `${output}/result.json`,
    JSON.stringify({
      stack,
      storage,
      passed: true,
      backend,
      frontend,
      template: template
        ? { name: template.name, chunks: template.chunks.length, bbox: template.bbox }
        : null,
      retained: keep,
      traefik: origin?.origin ?? null,
    }),
  )
  passed = true
  console.log(
    `Helm ${stack}/${storage}: acceptance, Box Art, pod replacement, TLS and migration passed${keep ? '; retained for laptop testing' : ''}`,
  )
} finally {
  await cleanup()
}
