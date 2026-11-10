import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  assertNoMixedPackageKinds,
  validatePendingUserscriptChangeset,
  validateUserscriptChangeset,
} from './check-userscript-release-notes.mjs'
import { postReleaseAnnouncement, releaseAnnouncementPayloads } from './post-release.mjs'
import { prepareAppRelease } from './prepare-app-release.mjs'
import { portableImages, portableVersion } from './prepare-portable-release.mjs'
import { prepareUserscriptRelease } from './prepare-userscript-release.mjs'
import { isReleaseMerge, releaseValidated } from './release-merge.mjs'
import { releaseNotesFor } from './release-notes.mjs'
import { userscriptMetricVersions } from './userscript-metric-versions.mjs'

const notes = '### Patch Changes\n\n- abc1234: Preserve template placement.'
const changelog = `# Changes\n\n## 1.2.3\n\n${notes}\n\n## 1.2.2\n\nOlder change.\n`
const changeset = '---\n"@caelestis/userscript": patch\n---\n\nPreserve template placement.\n'

test('release credentials cross both reusable workflow boundaries and portable publishing keeps its own gate', () => {
  const workflow = (name) =>
    readFileSync(new URL(`../workflows/${name}.yml`, import.meta.url), 'utf8')
  const job = (source, name) =>
    source.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  [\\w-]+:|$)`))?.[1] ?? ''
  const outer = job(workflow('app-release'), 'portable')
  const release = workflow('portable-release')
  assert.match(outer, /uses: .*portable-release\.yml/)
  assert.match(outer, /secrets: inherit/)
  assert.match(job(release, 'cloudflare'), /secrets: inherit/)
  assert.match(job(release, 'publish'), /needs: validate/)
  assert.doesNotMatch(job(release, 'publish'), /needs:.*cloudflare/)
})

test('validated releases skip only pure checks and retain deployment and portable artifact producers', () => {
  const workflow = (name) =>
    readFileSync(new URL(`../workflows/${name}.yml`, import.meta.url), 'utf8')
  const job = (source, name) =>
    source.match(new RegExp(`\n  ${name}:\n([\\s\\S]*?)(?=\n  [\\w-]+:|$)`))?.[1] ?? ''
  const step = (source, name) =>
    source.match(new RegExp(`- name: ${name}\n([\\s\\S]*?)(?=\n      - |$)`))?.[1] ?? ''
  const app = workflow('app-release')
  const version = job(app, 'version')
  assert.match(version, /actions: read/)
  assert.match(version, /validated: \$\{\{ steps.validate.outputs.validated \}\}/)
  assert.match(
    step(version, 'Check whether the release PR already passed checks'),
    /if: github.event_name == 'push' && github.ref == 'refs\/heads\/main' && steps.release.outputs.release == 'true'/,
  )
  for (const name of ['deploy', 'portable']) {
    assert.match(
      job(app, name),
      /checks_validated: \$\{\{ needs.version.outputs.validated == 'true' \}\}/,
    )
    assert.doesNotMatch(job(app, name).split('uses:')[0], /validated/)
  }
  const userscript = job(app, 'userscript')
  for (const name of ['Typecheck', 'Test']) {
    assert.match(
      step(userscript, `${name} userscript and dependencies`),
      /if: needs.version.outputs.validated != 'true'/,
    )
    assert.doesNotMatch(
      step(workflow('userscript-ci'), `${name} userscript and dependencies`),
      /if:/,
    )
  }
  for (const name of [
    'Build userscript and dependencies',
    'Prepare userscript release',
    'Package the extension and its source',
  ]) {
    assert.doesNotMatch(step(userscript, name), /if:/)
    assert.match(step(userscript, name), /run:/)
  }
  const deploy = workflow('deploy')
  assert.match(step(deploy, 'Check code'), /if: '!inputs.checks_validated'/)
  assert.match(step(deploy, 'Build deployment artifacts'), /run: pnpm build/)
  for (const name of [
    'Build deployment artifacts',
    'Check D1 access',
    'Apply backend database migrations',
    'Deploy docs',
    'Deploy frontend',
    'Ensure share image queue',
    'Deploy backend',
  ]) {
    assert.match(step(deploy, name), /run:/)
    assert.doesNotMatch(step(deploy, name), /if:/)
  }
  const portable = workflow('portable-ci')
  const release = workflow('portable-release')
  assert.match(job(release, 'validate'), /checks_validated: \$\{\{ inputs.checks_validated \}\}/)
  assert.doesNotMatch(job(release, 'validate'), /if:/)
  assert.match(job(release, 'publish'), /needs: validate/)
  assert.match(job(release, 'publish'), /pattern: portable-images-\*/)
  for (const name of ['deploy', 'portable-release', 'portable-ci']) {
    assert.match(workflow(name), /checks_validated:\n[\s\S]*?type: boolean\n {8}default: false/)
  }
  for (const name of ['release-tooling', 'runtime', 'chart']) {
    assert.match(job(portable, name), /if: .* && !inputs.checks_validated/)
  }
  for (const name of ['image', 'compose', 'helm', 'scan']) {
    assert.match(job(portable, name), /if: needs.changes.outputs.stacks == 'true'/)
    assert.doesNotMatch(job(portable, name), /checks_validated/)
  }
  assert.match(job(portable, 'image'), /name: portable-images-\$\{\{ matrix.arch \}\}/)
  const releaseChecks = step(portable, 'Check release code')
  assert.match(
    releaseChecks,
    /if: github.event_name == 'pull_request' && github.head_ref == 'changeset-release\/main'/,
  )
  for (const command of ['lint', 'check', 'test']) {
    assert.ok(step(deploy, 'Check code').includes(`pnpm ${command}`))
    assert.ok(releaseChecks.includes(`pnpm ${command}`))
  }
  for (const source of [job(portable, 'runtime'), job(workflow('userscript-ci'), 'build')]) {
    assert.match(step(source, 'Record the tested release tree'), /git rev-parse 'HEAD\^\{tree\}'/)
    const evidence = step(source, 'Upload the tested release tree')
    assert.match(
      evidence,
      /if: github.event_name == 'pull_request' && github.head_ref == 'changeset-release\/main'/,
    )
    assert.match(evidence, /name: release-check-tree/)
    assert.match(evidence, /path: \$\{\{ runner.temp \}\}\/release-check-tree.txt/)
    assert.match(evidence, /if-no-files-found: error/)
  }
})

test('portable release gates require every artifact job even when pure checks are reused', () => {
  const portable = readFileSync(new URL('../workflows/portable-ci.yml', import.meta.url), 'utf8')
  const gate = portable.match(/node --input-type=module -e '([\s\S]*?)'/)[1]
  const results = Object.fromEntries(
    [
      'changes',
      'matrix',
      'release-tooling',
      'runtime',
      'chart',
      'image',
      'compose',
      'helm',
      'scan',
    ].map((name) => [name, { result: 'success' }]),
  )
  results.changes.outputs = { server: 'true', stacks: 'true', tooling: 'true' }
  const run = (reused) =>
    spawnSync(process.execPath, ['--input-type=module', '-e', gate], {
      env: { ...process.env, RESULTS: JSON.stringify(results), CHECKS_VALIDATED: String(reused) },
      encoding: 'utf8',
    })
  assert.equal(run(false).status, 0)
  for (const name of ['release-tooling', 'runtime', 'chart']) results[name].result = 'skipped'
  assert.equal(run(true).status, 0)
  assert.notEqual(run(false).status, 0)
  for (const name of ['image', 'compose', 'helm', 'scan']) {
    for (const result of ['skipped', 'failure', 'cancelled']) {
      results[name].result = result
      assert.notEqual(run(true).status, 0, `${name}: ${result} cannot authorize publication`)
    }
    results[name].result = 'success'
  }
})

test('every release PR enables all portable checks regardless of its changed files', (t) => {
  const portable = readFileSync(new URL('../workflows/portable-ci.yml', import.meta.url), 'utf8')
  const detect = portable
    .match(/name: Detect server changes[\s\S]*?run: \|\n([\s\S]*?)(?=\n {2}release-tooling:)/)[1]
    .split('\n')
    .map((line) => line.slice(10))
    .join('\n')
  const directory = mkdtempSync(join(tmpdir(), 'caelestis-release-gates-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const output = join(directory, 'output')
  const result = spawnSync('bash', ['-e', '-c', detect], {
    cwd: directory,
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      EVENT: 'pull_request',
      HEAD_REF: 'changeset-release/main',
      RELEASE_SHA: '',
    },
    encoding: 'utf8',
  })
  assert.equal(result.status, 0, result.stderr)
  assert.equal(readFileSync(output, 'utf8'), 'server=true\nstacks=true\ntooling=true\n')
})

test('release artifacts contain the built bytes, their digest, and only the selected release notes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'caelestis-release-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const app of ['userscript', 'backend', 'frontend']) {
    mkdirSync(join(root, 'apps', app, 'dist'), { recursive: true })
    writeFileSync(join(root, 'apps', app, 'package.json'), JSON.stringify({ version: '1.2.3' }))
    writeFileSync(join(root, 'apps', app, 'CHANGELOG.md'), changelog)
  }
  const built = Buffer.from(
    '// ==UserScript==\n// @version      1.2.3\n// ==/UserScript==\nvoid 0;\n',
  )
  const builtPath = join(root, 'apps/userscript/dist/wplace-template-server.user.js')
  writeFileSync(builtPath, built)
  const release = prepareUserscriptRelease({ root, outputDirectory: join(root, 'output') })
  assert.deepEqual(readFileSync(release.stablePath), built)
  assert.deepEqual(readFileSync(release.versionedPath), built)
  const digest = createHash('sha256').update(built).digest('hex')
  assert.equal(release.sha256, digest)
  assert.equal(
    readFileSync(release.checksumPath, 'utf8'),
    `${digest}  caelestis.user.js\n${digest}  caelestis-v1.2.3.user.js\n`,
  )
  assert.equal(readFileSync(release.notesPath, 'utf8'), `${notes}\n`)
  for (const app of ['backend', 'frontend']) {
    const appRelease = prepareAppRelease({ root, app, outputDirectory: join(root, app) })
    assert.equal(appRelease.tag, `${app}-v1.2.3`)
    assert.equal(readFileSync(appRelease.notesPath, 'utf8'), `${notes}\n`)
  }
  writeFileSync(builtPath, '// @version      1.2.2\n')
  assert.throws(
    () => prepareUserscriptRelease({ root, outputDirectory: join(root, 'bad') }),
    /version/,
  )
  assert.throws(
    () => prepareAppRelease({ root, app: '../userscript', outputDirectory: root }),
    /unsupported/,
  )
})

test('release notes require an exact nonempty version section', () => {
  assert.equal(releaseNotesFor(changelog, '1.2.3'), notes)
  assert.throws(() => releaseNotesFor(changelog, '1.2'), /no .* release section/)
  assert.throws(() => releaseNotesFor('## 1.2.3\n\n## 1.2.2\nold', '1.2.3'), /empty/)
})

test('a pending note stays immutable and describes one atomic app change', () => {
  assert.equal(
    validatePendingUserscriptChangeset({ current: changeset, base: changeset, path: 'note.md' }),
    true,
  )
  assert.throws(
    () =>
      validatePendingUserscriptChangeset({
        current: `${changeset}\n`,
        base: changeset,
        path: 'note.md',
      }),
    /new Changeset/,
  )
  assert.throws(
    () =>
      validateUserscriptChangeset(
        changeset.replace('Preserve template placement.', 'Fix placement. Also change colors.'),
      ),
    /one complete sentence/,
  )
  assert.equal(
    validateUserscriptChangeset(`${changeset}\n- Keep the original folder on refusal.\n`),
    true,
  )
  assert.throws(
    () =>
      assertNoMixedPackageKinds({
        content: changeset.replace('---\n\n', '"@caelestis/shared": patch\n---\n\n'),
        ignoredPackages: new Set(['@caelestis/shared']),
        path: 'mixed.md',
      }),
    /do not mix/,
  )
})

test('only the exact merged release commit from this repository authorizes publication', () => {
  const target = { sha: 'release-sha', repository: 'owner/project' }
  const pr = {
    merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: target.sha,
    base: { ref: 'main', repo: { full_name: target.repository } },
    head: { ref: 'changeset-release/main', repo: { full_name: target.repository } },
  }
  assert.equal(isReleaseMerge([pr], target), true)
  for (const invalid of [
    { ...pr, merged_at: null },
    { ...pr, merge_commit_sha: 'other' },
    { ...pr, base: { ref: 'other' } },
    { ...pr, base: { ...pr.base, repo: { full_name: 'other/project' } } },
    { ...pr, head: { ...pr.head, ref: 'feature' } },
    { ...pr, head: { ...pr.head, repo: { full_name: 'fork/project' } } },
  ])
    assert.equal(isReleaseMerge([invalid], target), false)
})

test('release check reuse requires successful PR runs of both workflows for the exact same head', () => {
  const pr = {
    head: {
      sha: 'a'.repeat(40),
      ref: 'changeset-release/main',
      repo: { full_name: 'mia-cx/Caelestis' },
    },
  }
  const runs = ['portable-ci', 'userscript-ci'].map((name) => ({
    event: 'pull_request',
    path: `.github/workflows/${name}.yml@refs/heads/main`,
    head_sha: pr.head.sha,
    head_branch: pr.head.ref,
    head_repository: { full_name: pr.head.repo.full_name },
    // GitHub empties this list after the PR merges (ditherette #484).
    pull_requests: [],
    status: 'completed',
    conclusion: 'success',
  }))
  assert.equal(releaseValidated(runs, pr), true)
  assert.equal(releaseValidated([], pr), false)
  for (const index of [0, 1]) {
    assert.equal(
      releaseValidated(
        runs.filter((_, i) => i !== index),
        pr,
      ),
      false,
    )
    for (const invalid of [
      { event: 'push' },
      { path: '.github/workflows/other.yml' },
      { head_sha: 'b'.repeat(40) },
      { head_branch: 'feature' },
      { head_repository: { full_name: 'fork/Caelestis' } },
      { head_repository: null },
      { status: 'in_progress' },
      { conclusion: 'failure' },
      { conclusion: 'cancelled' },
      { conclusion: 'skipped' },
    ]) {
      const changed = runs.map((run, i) => (i === index ? { ...run, ...invalid } : run))
      assert.equal(releaseValidated(changed, pr), false, JSON.stringify(invalid))
      // An unrelated or failed run must not hide an earlier success.
      assert.equal(releaseValidated([...changed, runs[index]], pr), true)
    }
  }
})

test('release reuse fetches a squash-merged head and fails closed on tree, API, and ref errors', (t) => {
  const directory = mkdtempSync(join(tmpdir(), 'caelestis-release-validation-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const source = join(directory, 'source')
  const checkout = join(directory, 'checkout')
  mkdirSync(source)
  const git = (cwd, ...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git(source, 'init', '-b', 'main')
  git(source, 'config', 'user.name', 'Release test')
  git(source, 'config', 'user.email', 'release@example.test')
  git(source, 'config', 'commit.gpgsign', 'false')
  writeFileSync(join(source, 'app'), 'before')
  git(source, 'add', 'app')
  git(source, 'commit', '-m', 'base')
  git(source, 'checkout', '-b', 'release-head')
  writeFileSync(join(source, 'app'), 'release')
  git(source, 'commit', '-am', 'release PR head')
  const head = git(source, 'rev-parse', 'HEAD')
  git(source, 'update-ref', 'refs/pull/123/head', head)
  git(source, 'checkout', 'main')
  writeFileSync(join(source, 'app'), 'release')
  git(source, 'commit', '-am', 'squash release')
  const sha = git(source, 'rev-parse', 'HEAD')
  const releaseTree = git(source, 'rev-parse', 'HEAD^{tree}')
  git(source, 'checkout', '-b', 'synthetic-merge')
  writeFileSync(join(source, 'capability'), 'present only in the tested synthetic merge')
  git(source, 'add', 'capability')
  git(source, 'commit', '-m', 'main-only capability in synthetic merge')
  const syntheticTree = git(source, 'rev-parse', 'HEAD^{tree}')
  git(source, 'checkout', 'main')
  git(directory, 'clone', '--no-local', '--depth=1', '--branch=main', source, checkout)
  assert.throws(() => git(checkout, 'cat-file', '-e', head))
  const repository = 'mia-cx/Caelestis'
  const pr = {
    number: 123,
    merged_at: '2026-01-01T00:00:00Z',
    merge_commit_sha: sha,
    base: { ref: 'main', repo: { full_name: repository } },
    head: { sha: head, ref: 'changeset-release/main', repo: { full_name: repository } },
  }
  writeFileSync(
    join(directory, 'gh'),
    `#!${process.execPath}
const fs = require('node:fs');
fs.appendFileSync(process.env.REQUEST_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');
if (process.argv[2] === 'run') {
  const directory = process.argv[process.argv.indexOf('--dir') + 1];
  fs.mkdirSync(directory, { recursive: true });
  if (process.env.MISSING_EVIDENCE !== 'true') {
    const tree = process.argv[4] === process.env.DIFFERENT_RUN ? process.env.TESTED_TREE : process.env.RELEASE_TREE;
    fs.writeFileSync(directory + '/release-check-tree.txt', tree + '\\n');
  }
  process.exit(0);
}
if (process.env.API_ERROR === 'true') process.exit(1);
const workflow = process.argv[3].split('/workflows/')[1].split('/runs')[0];
console.log(JSON.stringify([{ workflow_runs: [{
  id: workflow === 'portable-ci.yml' ? 101 : 102,
  event: 'pull_request', path: '.github/workflows/' + workflow,
  head_sha: process.env.PR_HEAD, head_branch: 'changeset-release/main',
  head_repository: { full_name: 'mia-cx/Caelestis' }, pull_requests: [],
  status: 'completed', conclusion: 'success'
}] }]));
`,
    { mode: 0o755 },
  )
  const script = fileURLToPath(new URL('./release-merge.mjs', import.meta.url))
  const run = (overrides = {}, pullRequests = [[pr]]) =>
    spawnSync(process.execPath, [script, sha, repository, 'validated'], {
      cwd: checkout,
      input: JSON.stringify(pullRequests),
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        GITHUB_OUTPUT: join(directory, 'output'),
        GITHUB_EVENT_NAME: 'push',
        GITHUB_REF: 'refs/heads/main',
        REQUEST_LOG: join(directory, 'requests'),
        PR_HEAD: pullRequests[0]?.[0]?.head?.sha ?? head,
        RELEASE_TREE: releaseTree,
        ...overrides,
      },
    })
  const valid = run()
  assert.equal(valid.status, 0, valid.stderr)
  assert.equal(valid.stdout, 'validated=true\n', valid.stderr)
  assert.equal(readFileSync(join(directory, 'output'), 'utf8'), 'validated=true\n')
  const requests = readFileSync(join(directory, 'requests'), 'utf8')
    .trim()
    .split('\n')
    .filter((request) => JSON.parse(request)[0] === 'api')
  assert.equal(requests.length, 2)
  for (const [index, workflow] of ['portable-ci.yml', 'userscript-ci.yml'].entries()) {
    assert.deepEqual(JSON.parse(requests[index]), [
      'api',
      `repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${head}&status=success&per_page=100`,
      '--paginate',
      '--slurp',
    ])
  }
  // Both successful runs must prove the actual checkout, not just match the PR head metadata.
  for (const runId of ['101', '102']) {
    const synthetic = run({ DIFFERENT_RUN: runId, TESTED_TREE: syntheticTree })
    assert.equal(synthetic.status, 0, synthetic.stderr)
    assert.equal(synthetic.stdout, 'validated=false\n')
  }
  const missingEvidence = run({ MISSING_EVIDENCE: 'true' })
  assert.equal(missingEvidence.status, 0, missingEvidence.stderr)
  assert.equal(missingEvidence.stdout, 'validated=false\n')
  assert.match(missingEvidence.stderr, /::warning::Unable to reuse/)
  writeFileSync(join(directory, 'requests'), '')
  for (const [overrides, pulls] of [
    [{ GITHUB_EVENT_NAME: 'workflow_dispatch' }, [[pr]]],
    [{ GITHUB_REF: 'refs/heads/staging' }, [[pr]]],
    [{}, []],
    [{}, [[{ ...pr, merge_commit_sha: 'other' }]]],
    [{ API_ERROR: 'true' }, [[pr]]],
    [{}, [[{ ...pr, head: { ...pr.head, sha: 'bad' } }]]],
  ]) {
    const result = run(overrides, pulls)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, 'validated=false\n')
  }
  // No new API calls for manual retries, staging pushes, or unrelated merges.
  assert.equal(readFileSync(join(directory, 'requests'), 'utf8').trim().split('\n').length, 1)
  writeFileSync(join(source, 'app'), 'different merge tree')
  git(source, 'commit', '-am', 'tree mismatch')
  const different = git(source, 'rev-parse', 'HEAD')
  git(source, 'update-ref', 'refs/pull/123/head', different)
  const mismatch = run({}, [[{ ...pr, head: { ...pr.head, sha: different } }]])
  assert.equal(mismatch.status, 0, mismatch.stderr)
  assert.equal(mismatch.stdout, 'validated=false\n')
  assert.match(mismatch.stderr, /::warning::Release tree differs/)
  git(source, 'update-ref', '-d', 'refs/pull/123/head')
  const missing = run()
  assert.equal(missing.status, 0, missing.stderr)
  assert.equal(missing.stdout, 'validated=false\n')
  assert.match(missing.stderr, /::warning::Unable to reuse/)
})

test('portable releases separate immutable versions from app-scoped moving aliases', () => {
  const identity = portableVersion('2.3.4', '5.6.7')
  const images = portableImages(identity, 'Example/Project')
  assert.equal(identity.chartVersion, '2.3.4+frontend.5.6.7')
  assert.equal(images[0].source, 'backend-bun')
  assert.deepEqual(
    images.map((image) => image.aliases),
    [
      { immutable: ['2.3.4'], moving: ['2.3', '2', 'latest'] },
      { immutable: ['2.3.4-node'], moving: ['2.3-node', '2-node', 'latest-node'] },
      { immutable: ['2.3.4-bun'], moving: ['2.3-bun', '2-bun', 'latest-bun'] },
      { immutable: ['5.6.7'], moving: ['5.6', '5', 'latest'] },
    ],
  )
  assert.equal(images[0].registries.ghcr, 'ghcr.io/example/caelestis-backend')
  assert.equal(images[3].registries.ghcr, 'ghcr.io/example/caelestis-frontend')
  for (const version of ['01.2.3', '1.2', '1.2.3-beta', '../bad'])
    assert.throws(() => portableVersion(version, '1.0.0'))
  assert.throws(() => portableImages(identity, '../bad/repository'))
})

test('metric version lists preserve semantic ordering and omit releases before metrics existed', () => {
  assert.deepEqual(
    userscriptMetricVersions('0.12.0', '## 0.9.0\n## 0.5.4\n## 0.5.5\n## 0.12.0\n'),
    ['0.12.0', '0.9.0', '0.5.5'],
  )
  assert.throws(() => userscriptMetricVersions('invalid', ''), /invalid/)
})

test('announcements preserve release identity and bound content without triggering mentions', () => {
  const [payload] = releaseAnnouncementPayloads({
    app: 'userscript',
    version: '1.2.3',
    tag: 'userscript-v1.2.3',
    notes,
    repository: 'owner/project',
  })
  assert.deepEqual(payload.allowed_mentions, { parse: [] })
  assert.match(payload.embeds[0].description, /Preserve template placement/)
  assert.match(payload.embeds[0].url, /owner\/project\/releases\/tag\/userscript-v1.2.3$/)
  const huge = `### Patch Changes\n\n${Array.from({ length: 50 }, (_, i) => `- ${i}: ${'A'.repeat(250)}.`).join('\n')}`
  const [bounded] = releaseAnnouncementPayloads({
    app: 'frontend',
    version: '1.2.3',
    tag: 'frontend-v1.2.3',
    notes: huge,
    repository: 'owner/project',
  })
  assert.ok(bounded.embeds[0].description.length <= 4000)
  assert.match(bounded.embeds[0].description, /more changes/)
  assert.throws(
    () =>
      releaseAnnouncementPayloads({
        app: 'userscript',
        version: '1.2.3',
        tag: 'frontend-v1.2.3',
        notes,
        repository: 'owner/project',
      }),
    /tag does not match/,
  )
})

test('webhook delivery obeys rate limits and surfaces permanent refusal without real network access', async () => {
  const delays = []
  const requests = []
  await postReleaseAnnouncement({
    webhookUrl: 'https://discord.com/api/webhooks/test/fixture',
    payloads: [{ content: 'fixture' }],
    sleep: async (delay) => {
      delays.push(delay)
    },
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(init.body) })
      return requests.length === 1
        ? Response.json({ retry_after: 0.25 }, { status: 429 })
        : new Response(null, { status: 204 })
    },
  })
  assert.deepEqual(delays, [250])
  assert.equal(requests.length, 2)
  assert.equal(new URL(requests[0].url).searchParams.get('wait'), 'true')
  assert.deepEqual(requests[0].body, { content: 'fixture' })
  await assert.rejects(
    postReleaseAnnouncement({
      webhookUrl: 'https://discord.com/api/webhooks/test/fixture',
      payloads: [{}],
      fetchImpl: async () => new Response('refused', { status: 403 }),
    }),
    /403.*refused/,
  )
  await assert.rejects(
    postReleaseAnnouncement({
      webhookUrl: 'https://example.test/api/webhooks/test',
      payloads: [],
      fetchImpl: async () => {
        throw new Error('must not call')
      },
    }),
    /Discord webhook endpoint/,
  )
})

test('store submission skips every store whose credentials are missing', () => {
  const script = fileURLToPath(new URL('./extension-stores.mjs', import.meta.url))
  for (const store of ['chrome', 'edge', 'firefox']) {
    const output = execFileSync(process.execPath, [script, store, 'unread.zip', 'unread.zip'], {
      env: { PATH: process.env.PATH, CHROME_ITEM_ID: 'set', EDGE_PRODUCT_ID: 'set' },
      encoding: 'utf8',
    })
    assert.match(output, /^::notice::.*credentials are not set up; skipping/m)
  }
})

test('Firefox skips a missing public listing even when configured credentials are stale', () => {
  const script = fileURLToPath(new URL('./extension-stores.mjs', import.meta.url))
  const preload = `
    globalThis.fetch = async (url, init) => {
      if (url !== 'https://addons.mozilla.org/api/v5/addons/addon/caelestis@mia.cx/') {
        throw new Error('Unexpected request: ' + url)
      }
      return init?.headers?.authorization
        ? Response.json({ detail: 'Unknown JWT iss (issuer).' }, { status: 401 })
        : Response.json({ detail: 'Not found.' }, { status: 404 })
    }
  `
  const output = execFileSync(
    process.execPath,
    [
      '--import',
      `data:text/javascript,${encodeURIComponent(preload)}`,
      script,
      'firefox',
      'unread.zip',
      'unread.zip',
    ],
    {
      env: { PATH: process.env.PATH, AMO_JWT_ISSUER: 'stale', AMO_JWT_SECRET: 'stale' },
      encoding: 'utf8',
    },
  )
  assert.match(output, /has no addons.mozilla.org listing yet; skipping Firefox/)
})
