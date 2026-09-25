import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { acceptance, waitFor } from './stack-tests/acceptance.mjs'
import { importWplace, verifyWplace } from './stack-tests/wplace.mjs'

const [backend, frontend, database, storage] = process.argv.slice(2)
if (
  !backend ||
  !frontend ||
  !['sqlite', 'postgres', 'mariadb'].includes(database) ||
  !['filesystem', 's3'].includes(storage)
)
  throw new Error(
    'Usage: node scripts/test-portable-compose.mjs BACKEND_IMAGE FRONTEND_IMAGE sqlite|postgres|mariadb filesystem|s3',
  )
const project = `caelestis-stack-${process.pid}-${database}-${storage}`
const files = ['-f', 'compose.yaml']
if (database !== 'sqlite') files.push('-f', `deploy/compose/${database}.yaml`)
if (storage === 's3') files.push('-f', 'deploy/compose/s3.yaml')
const env = {
  ...process.env,
  ADMIN_TOKEN: 'compose-admin-test',
  CAELESTIS_READ_TOKEN: 'compose-read-test',
  POSTGRES_PASSWORD: 'compose-postgres-test',
  MARIADB_PASSWORD: 'compose-maria-test',
  MINIO_ROOT_PASSWORD: 'compose-minio-test-password',
  CAELESTIS_ENV_FILE: '.env.example',
  CAELESTIS_BACKEND_IMAGE: backend,
  CAELESTIS_FRONTEND_IMAGE: frontend,
  CAELESTIS_HTTP_PORT: '0',
  CAELESTIS_BIND_ADDRESS: '127.0.0.1',
}
const baseline = process.env.CAELESTIS_BASELINE_BACKEND_IMAGE
if (baseline) {
  assert.ok(process.env.CAELESTIS_BASELINE_FRONTEND_IMAGE, 'Both baseline images are required')
  env.CAELESTIS_BACKEND_IMAGE = baseline
  env.CAELESTIS_FRONTEND_IMAGE = process.env.CAELESTIS_BASELINE_FRONTEND_IMAGE
}
const args = ['compose', '--env-file', '.env.example', '-p', project, ...files]
const compose = (...command) =>
  execFileSync('docker', [...args, ...command], { env, encoding: 'utf8', timeout: 240_000 }).trim()
const logs = `test-results/compose-${database}-${storage}`
rmSync(logs, { recursive: true, force: true })
mkdirSync(logs, { recursive: true })
// Every S3 stack starts as an upgrade from MinIO: its old volume holds bytes the real MinIO image
// wrote, which the RustFS stack must copy over on its first start and then leave untouched.
const minioFixture = resolve('fixtures/minio-volume')
const minioManifest = JSON.parse(readFileSync(`${minioFixture}/manifest.json`, 'utf8'))
const minioVolume = `${project}_s3`
const inVolume = (volume, mode, args) =>
  execFileSync(
    'docker',
    ['run', '--rm', '--user', '0', '-v', `${volume}:/volume:${mode}`, ...args],
    {
      encoding: 'utf8',
    },
  ).trim()
const volumeDigest = (volume) =>
  inVolume(volume, 'ro', [
    '--entrypoint',
    'sh',
    backend,
    '-c',
    'cd /volume && find . -type f -exec md5sum {} + | sort | md5sum',
  ])
const verifyMinioObjects = () =>
  compose(
    'exec',
    '-T',
    '-w',
    '/app/apps/backend',
    'backend',
    'node',
    '--input-type=module',
    '-e',
    `
    import { createHash } from 'node:crypto';
    import { createRequire } from 'node:module';
    const { S3Client, GetObjectCommand } = createRequire(import.meta.resolve('@caelestis/storage/s3'))('@aws-sdk/client-s3');
    const client = new S3Client({ endpoint: process.env.S3_ENDPOINT, region: process.env.S3_REGION, forcePathStyle: true });
    const manifest = ${JSON.stringify(minioManifest)};
    for (const object of manifest.objects) {
      const got = await client.send(new GetObjectCommand({ Bucket: manifest.bucket, Key: object.key }));
      const md5 = createHash('md5').update(await got.Body.transformToByteArray()).digest('hex');
      const actual = { md5, contentType: got.ContentType, origin: got.Metadata?.origin };
      const expected = { md5: object.md5, contentType: object.contentType, origin: object.metadata.origin };
      if (JSON.stringify(actual) !== JSON.stringify(expected))
        throw new Error(object.key + ' after migration: ' + JSON.stringify(actual) + ' expected ' + JSON.stringify(expected));
    }
    client.destroy();
  `,
  )
try {
  compose('config', '--quiet')
  if (database !== 'sqlite') compose('pull', '--policy', 'missing', database)
  if (storage === 's3') compose('pull', '--policy', 'missing', 's3')
  let minioDigest
  if (storage === 's3') {
    execFileSync('docker', [
      'volume',
      'create',
      '--label',
      `com.docker.compose.project=${project}`,
      '--label',
      'com.docker.compose.volume=s3',
      minioVolume,
    ])
    inVolume(minioVolume, 'rw', [
      '-v',
      `${minioFixture}:/fixture:ro`,
      '--entrypoint',
      'tar',
      backend,
      '-xzf',
      '/fixture/volume.tar.gz',
      '-C',
      '/volume',
    ])
    minioDigest = volumeDigest(minioVolume)
  }
  compose('up', '-d', '--no-build', '--pull', 'never', '--wait', '--wait-timeout', '180')
  if (storage === 's3') {
    assert.match(compose('logs', '--no-color', 's3-migrate'), /copying the MinIO volume/)
    assert.match(
      compose('logs', '--no-color', 's3-init'),
      new RegExp(`caelestis has all ${minioManifest.objects.length} objects`),
    )
    verifyMinioObjects()
  }
  const site = `http://${compose('port', 'frontend', '3000')}`
  const suite = acceptance({
    site,
    adminToken: env.ADMIN_TOKEN,
    readToken: env.CAELESTIS_READ_TOKEN,
  })
  const state = await suite.seed()
  const imported = process.env.CAELESTIS_TEST_WPLACE
    ? await importWplace({
        api: `${site}/backend/v1`,
        adminToken: env.ADMIN_TOKEN,
        filename: process.env.CAELESTIS_TEST_WPLACE,
      })
    : undefined
  const verify = async () => {
    await suite.verify(state)
    if (imported) {
      await verifyWplace({
        api: `${site}/backend/v1`,
        readToken: env.CAELESTIS_READ_TOKEN,
        template: imported,
      })
    }
  }
  if (baseline) {
    // Keep the public address stable when Compose replaces the older frontend image.
    env.CAELESTIS_HTTP_PORT = new URL(site).port
    compose('stop', 'backend', 'frontend')
    env.CAELESTIS_BACKEND_IMAGE = backend
    env.CAELESTIS_FRONTEND_IMAGE = frontend
    compose(
      'run',
      '--rm',
      '--no-deps',
      'backend',
      'node',
      'apps/backend/dist/node/main.js',
      'migrate',
    )
    compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180')
  }
  compose(
    'exec',
    '-T',
    'backend',
    'node',
    '--input-type=module',
    '-e',
    `
    import { Worker } from 'node:worker_threads';
    import { once } from 'node:events';
    const worker = new Worker('/app/apps/backend/dist/node/social-worker.js', { execArgv: [], workerData: {
      site: 'http://127.0.0.1:3000', apiPath: '/backend/v1/', readToken: process.env.CAELESTIS_READ_TOKEN, output: '/data/social-smoke'
    } });
    const [code] = await once(worker, 'exit');
    if (code !== 0) throw new Error('Packaged social worker failed');
  `,
  )
  await verify()
  const variables = JSON.parse(
    execFileSync(
      'docker',
      ['inspect', '--format', '{{json .Config.Env}}', compose('ps', '-q', 'frontend')],
      { encoding: 'utf8' },
    ),
  )
  assert.ok(
    !variables.some((value) =>
      /^(ADMIN_TOKEN|PGPASSWORD|MARIADB_PASSWORD|DATABASE_URL)=/.test(value),
    ),
  )
  const rivalName = `${project}-rival`
  try {
    const rival = spawnSync(
      'docker',
      [...args, 'run', '--name', rivalName, '--no-deps', '--rm', 'backend'],
      { env, encoding: 'utf8', timeout: 30_000 },
    )
    assert.equal(rival.error, undefined, 'Second owner must fail promptly')
    assert.notEqual(rival.status, 0)
    assert.match(rival.stdout + rival.stderr, /owns|owner|lock|already running/i)
  } finally {
    spawnSync('docker', ['rm', '-f', rivalName], { stdio: 'ignore' })
  }
  // SIGKILL proves persistence without relying on a graceful shutdown flush.
  compose('kill', '-s', 'SIGKILL', 'backend')
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180')
  await verify()
  if (process.env.CAELESTIS_TEST_EXTENDED === 'true' && database !== 'sqlite') {
    const owner = compose('ps', '-q', 'backend')
    const before = Number(
      execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', owner], {
        encoding: 'utf8',
      }),
    )
    compose('restart', database)
    await waitFor(
      () =>
        Number(
          execFileSync('docker', ['inspect', '--format', '{{.RestartCount}}', owner], {
            encoding: 'utf8',
          }),
        ) > before,
      'backend replacement after database connection loss',
    )
    await waitFor(
      async () =>
        (await fetch(`${site}/api/v1/manifest`, { signal: AbortSignal.timeout(3000) })).ok,
      'database recovery',
    )
    await verify()
  }
  compose('stop', 'backend')
  env.CAELESTIS_BACKEND_IMAGE = backend
  env.CAELESTIS_FRONTEND_IMAGE = frontend
  compose(
    'run',
    '--rm',
    '--no-deps',
    'backend',
    'node',
    'apps/backend/dist/node/main.js',
    'migrate',
  )
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180')
  await verify()
  if (storage === 's3') {
    // Later starts find the recorded migration and copy nothing; MinIO's volume is still as it was.
    const migrate = compose('logs', '--no-color', 's3-migrate').split('\n')
    assert.match(migrate.at(-1) ?? '', /MinIO migration: verified$/)
    verifyMinioObjects()
    assert.equal(volumeDigest(minioVolume), minioDigest)
  }
  await suite.remove(state)
  writeFileSync(
    `${logs}/result.json`,
    JSON.stringify({
      database,
      storage,
      upgrade: Boolean(baseline),
      importedTemplate: imported?.name,
      importedChunks: imported?.chunks.length,
      images: Object.fromEntries(
        ['backend', 'frontend'].map((component) => [
          component,
          execFileSync(
            'docker',
            ['inspect', '--format', '{{.Image}}', compose('ps', '-q', component)],
            { encoding: 'utf8' },
          ).trim(),
        ]),
      ),
      passed: true,
    }),
  )
  console.log(`${database}/${storage}: acceptance, ownership, crash recovery and migration passed`)
} catch (error) {
  if (database === 'postgres') {
    const result = spawnSync(
      'docker',
      [
        ...args,
        'exec',
        '-T',
        'postgres',
        'psql',
        '-U',
        'caelestis',
        '-d',
        'caelestis',
        '-c',
        'SELECT * FROM template_tile_statuses; SELECT * FROM canvas_tiles; SELECT * FROM version_tiles; SELECT * FROM template_versions;',
      ],
      { env, encoding: 'utf8' },
    )
    writeFileSync(`${logs}/database.log`, (result.stdout ?? '') + (result.stderr ?? ''))
  }
  throw error
} finally {
  const output = spawnSync('docker', [...args, 'logs', '--no-color', '--tail', '300'], {
    env,
    encoding: 'utf8',
  })
  writeFileSync(`${logs}/containers.log`, output.stdout + output.stderr)
  compose('down', '--volumes', '--remove-orphans')
}
