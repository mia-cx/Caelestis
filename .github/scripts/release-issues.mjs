import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Lists the issues the next release ships in the release PR, as `Closes #N`, so merging the
 * release closes them.
 *
 * A pull request that adds a Changeset names its issue with `Ships #N` instead of `Closes #N`, so
 * the issue stays open until the change reaches users. Run after changesets/action rewrites the
 * release PR body: `release-issues.mjs <release PR number> <owner/repo>`.
 */

const SHIPS =
  /\bships\s+(?:\[#(\d+)\]\([^)\s]*\)|#(\d+)|https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/(\d+))/gi
const MARKER = '<!-- release-issues -->'

/** Issue numbers a pull request body ships, in order of first mention. */
export const shippedIssues = (body) => [
  ...new Set(
    [...(body ?? '').matchAll(SHIPS)].map((match) => Number(match[1] ?? match[2] ?? match[3])),
  ),
]

/** The release PR body with its `Closes` list replaced; the list is dropped when nothing ships. */
export const releaseBody = (body, issues) => {
  const base = body.split(MARKER)[0].trimEnd()
  if (issues.length === 0) return `${base}\n`
  const closes = issues.map((issue) => `Closes #${issue}`).join('\n')
  return `${base}\n\n${MARKER}\n## Issues\n\n${closes}\n`
}

const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8' })

/** Open issues shipped by the pull requests that added each pending Changeset. */
const pendingIssues = (repository) => {
  const changesets = readdirSync('.changeset').filter(
    (file) => file.endsWith('.md') && file !== 'README.md',
  )
  const commits = new Set(
    changesets
      .map((file) =>
        execFileSync(
          'git',
          ['log', '--diff-filter=A', '--format=%H', '-1', '--', `.changeset/${file}`],
          {
            encoding: 'utf8',
          },
        ).trim(),
      )
      .filter(Boolean),
  )
  const issues = [...commits].flatMap((sha) =>
    JSON.parse(gh('api', `repos/${repository}/commits/${sha}/pulls`))
      .filter((pr) => typeof pr.merged_at === 'string' && pr.base?.ref === 'main')
      .flatMap((pr) => shippedIssues(pr.body)),
  )
  return [...new Set(issues)]
    .filter((issue) => {
      const found = JSON.parse(gh('api', `repos/${repository}/issues/${issue}`))
      return found.state === 'open' && found.pull_request === undefined
    })
    .sort((a, b) => a - b)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [pr, repository] = process.argv.slice(2)
  if (!/^\d+$/.test(pr ?? '') || !repository) {
    throw new Error('Usage: release-issues.mjs <release PR number> <owner/repo>')
  }
  const issues = pendingIssues(repository)
  const body = JSON.parse(gh('pr', 'view', pr, '--repo', repository, '--json', 'body')).body
  const file = join(tmpdir(), `release-pr-${pr}.md`)
  writeFileSync(file, releaseBody(body, issues))
  gh('pr', 'edit', pr, '--repo', repository, '--body-file', file)
  console.log(
    issues.length ? `Release PR #${pr} closes #${issues.join(', #')}` : 'No pending issues ship.',
  )
}
