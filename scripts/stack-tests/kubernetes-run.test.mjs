import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import test from 'node:test'

const moduleUrl = new URL('./kubernetes-run.mjs', import.meta.url).href

function cleanupAttempt(t, { namespace, server = 'https://test-cluster', uid = 'original' }) {
  const directory = mkdtempSync(resolve(tmpdir(), 'caelestis-cleanup-test-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  writeFileSync(
    resolve(directory, 'inventory.json'),
    JSON.stringify({
      context: 'test',
      namespace: 'caelestis-test-owned',
      server: 'https://test-cluster',
      run: 'owner',
      uid,
      volumes: [],
      resources: [],
    }),
  )
  writeFileSync(
    resolve(directory, 'kubectl'),
    `#!${process.execPath}
const fs=require('node:fs');const args=process.argv.slice(2);
fs.appendFileSync(process.env.TEST_TRACE,JSON.stringify(args)+'\\n');
if(args.includes('config'))process.stdout.write(JSON.stringify({clusters:[{cluster:{server:process.env.TEST_SERVER}}]}));
else if(args.includes('get')&&args.includes('namespace'))process.stdout.write(process.env.TEST_NAMESPACE);
else {console.error('Unexpected kubectl command');process.exit(1);}
`,
    { mode: 0o700 },
  )
  const trace = resolve(directory, 'trace.jsonl')
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
import {kubernetesRun} from ${JSON.stringify(moduleUrl)};
await kubernetesRun({context:'test',namespace:'caelestis-test-owned',output:process.env.TEST_OUTPUT,resume:true}).cleanup();
`,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}${delimiter}${process.env.PATH}`,
        TEST_TRACE: trace,
        TEST_SERVER: server,
        TEST_NAMESPACE: namespace ? JSON.stringify(namespace) : '',
        TEST_OUTPUT: directory,
      },
    },
  )
  const commands = readFileSync(trace, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.ok(
    commands.every((args) => !args.includes('delete')),
    'Must not issue a deletion',
  )
  return {
    result,
    inventory: JSON.parse(readFileSync(resolve(directory, 'inventory.json'), 'utf8')),
  }
}

test('cleanup refuses a different cluster behind the same context', (t) => {
  const { result } = cleanupAttempt(t, { server: 'https://different-cluster' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Cluster endpoint changed/)
})

test('cleanup refuses a namespace owned by another run', (t) => {
  const { result } = cleanupAttempt(t, {
    namespace: { metadata: { uid: 'original', labels: { 'caelestis.test/run': 'someone-else' } } },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Namespace ownership mismatch/)
})

test('cleanup refuses a replaced namespace even with the same label', (t) => {
  const { result } = cleanupAttempt(t, {
    namespace: { metadata: { uid: 'replacement', labels: { 'caelestis.test/run': 'owner' } } },
  })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Namespace was replaced/)
})

test('cleanup records completion when the namespace and volumes are already gone', (t) => {
  const { result, inventory } = cleanupAttempt(t, {})
  assert.equal(result.status, 0, result.stderr)
  assert.ok(inventory.cleanedAt)
})
