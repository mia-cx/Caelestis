import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run from the repository root after pnpm install and building shared packages. This freezes
// the independently measured variants. Import the linked measured-source bundle before running.
const repo = process.cwd()
const root = mkdtempSync(join(tmpdir(), 'caelestis-raid-rebuild-'))
const finalSource = '21aef4797e508acc96f05edf86f3fc2a240be844'
const guardedSource = 'ebf78847dc5003197d5c3757e2644cc1e6f07d83'
const manifest = []
const git = (...args) => execFileSync('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024 })
const archive = (name, revision, app) => {
  const target = join(root, name)
  mkdirSync(target, { recursive: true })
  execFileSync('tar', ['-x', '-C', target], {
    input: git('archive', revision, `apps/${app}`, 'tsconfig.base.json'),
  })
  symlinkSync(join(repo, 'node_modules'), join(target, 'node_modules'))
  symlinkSync(join(repo, 'packages'), join(target, 'packages'))
  symlinkSync(join(repo, `apps/${app}/node_modules`), join(target, `apps/${app}/node_modules`))
  return target
}
for (const [name, revision] of [
  ['base', 'aeff3cae'],
  ['467', '2e375022'],
  ['468', '432451e2'],
  ['469', 'dd9f4129'],
  ['471', '43111095'],
  ['472', '86ee89d9'],
  ['473', 'c796e4f2'],
  ['final', finalSource],
]) {
  const target = archive(`browser-${name}`, revision, 'userscript')
  const overrides = []
  if (name !== 'base') {
    const path = 'apps/userscript/src/presence-client.ts'
    writeFileSync(join(target, path), git('show', `${finalSource}:${path}`))
    overrides.push(path)
  }
  if (!['base', '467'].includes(name)) {
    const path = join(target, 'apps/userscript/src/gl/presence-layer.ts')
    writeFileSync(
      path,
      readFileSync(path, 'utf8').replaceAll(
        'item.mask !== null || item.document !== undefined',
        'item.mask !== null',
      ),
    )
  }
  execFileSync(process.execPath, ['build.mjs'], {
    cwd: join(target, 'apps/userscript'),
    stdio: 'inherit',
  })
  const bundle = join(target, 'apps/userscript/dist/wplace-template-server.user.js')
  copyFileSync(bundle, join(root, `rebased-${name}.user.js`))
  manifest.push({
    name,
    revision: git('rev-parse', revision).toString().trim(),
    overrides,
    sha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'),
  })
}
for (const name of ['474', '475', '476', '477']) {
  const target = archive(`backend-${name}`, finalSource, 'backend')
  if (name !== '477') {
    const path = 'apps/backend/src/work/relational-region-store.ts'
    writeFileSync(join(target, path), git('show', `a30b28b5:${path}`))
    const patch = git(
      'diff',
      'e4bb7799^',
      'e4bb7799',
      '--',
      'apps/backend/src/presence-coordinator.ts',
    )
    execFileSync('git', ['apply', '--reverse', '-'], { cwd: target, input: patch })
  }
  for (const [change, applies] of [
    ['48e05386', ['474', '475']],
    ['1724a236', ['474']],
  ]) {
    if (!applies.includes(name)) continue
    const patch = git(
      'diff',
      `${change}^`,
      change,
      '--',
      'apps/backend/src/presence-coordinator.ts',
    )
      .toString()
      .replaceAll('ingestTimings.', 'this.timings.')
    execFileSync('git', ['apply', '--reverse', '-'], { cwd: target, input: patch })
  }
  // Apply the same snapshot correctness guard to both sides, including pre-publication builds.
  const coordinator = 'apps/backend/src/presence-coordinator.ts'
  const guarded = git('show', `${guardedSource}:${coordinator}`).toString()
  const guard = guarded.slice(
    guarded.indexOf('      if (', guarded.indexOf('  private send(')),
    guarded.indexOf('      const payload = JSON.stringify(event)'),
  )
  let source = readFileSync(join(target, coordinator), 'utf8').replace(
    '      const payload = JSON.stringify(event)',
    `${guard}      const payload = JSON.stringify(event)`,
  )
  if (['476', '477'].includes(name)) {
    const start = guarded.indexOf('        const grouped = ')
    const end = guarded.indexOf('          let actors = ', start)
    source = source.replace(
      / {8}const grouped = new Map<string, Map<number, string\[\]>>\(\)\n {8}for \(const owner of owners\) \{\n/,
      guarded.slice(start, end),
    )
  }
  writeFileSync(join(target, coordinator), source)
  for (const config of ['tsconfig.json', 'tsconfig.bun.json'])
    execFileSync(join(repo, 'node_modules/.bin/tsc'), ['-p', config], {
      cwd: join(target, 'apps/backend'),
      stdio: 'inherit',
    })
  console.log(`Built backend ${name}`)
}
writeFileSync(join(root, 'build-manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Frozen builds: ${root}`)
