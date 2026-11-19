import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Lists the issues the next release ships in the release PR, as `Closes #N`, so merging the
 * release closes them.
 *
 * A pull request that adds a Changeset names its issue with `Ships #N` instead of `Closes #N`, so
 * the issue stays open until the change reaches users. Versioning deletes the pending Changesets,
 * so the workflow reads them first and edits the release PR after changesets/action rewrites it:
 *
 *   release-issues.mjs pending <owner/repo>              prints the open issues pending Changesets ship
 *   release-issues.mjs close <PR> <owner/repo> [N ...]   lists those issues in the release PR
 */

const MARKER = '<!-- release-issues -->'

/** `Ships #N`, `Ships [#N](<issue URL>)` or `Ships <issue URL>`; URLs must point into `repository`. */
const shipsPattern = (repository) => {
  const issueUrl = `https://github\\.com/${repository.replace(/[.\\/]/g, '\\$&')}/issues/(\\d+)`
  return new RegExp(`\\bships\\s+(?:\\[#\\d+\\]\\(${issueUrl}\\)|#(\\d+)\\b|${issueUrl})`, 'gi')
}

/** Issue numbers a pull request body ships in `repository`, in order of first mention. */
export const shippedIssues = (body, repository) => [
  ...new Set(
    [...(body ?? '').matchAll(shipsPattern(repository))].map((match) =>
      Number(match[1] ?? match[2] ?? match[3]),
    ),
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
          { encoding: 'utf8' },
        ).trim(),
      )
      .filter(Boolean),
  )
  const issues = [...commits].flatMap((sha) =>
    JSON.parse(gh('api', `repos/${repository}/commits/${sha}/pulls`))
      .filter((pr) => typeof pr.merged_at === 'string' && pr.base?.ref === 'main')
      .flatMap((pr) => shippedIssues(pr.body, repository)),
  )
  return [...new Set(issues)]
    .filter((issue) => {
      const found = JSON.parse(gh('api', `repos/${repository}/issues/${issue}`))
      return found.state === 'open' && found.pull_request === undefined
    })
    .sort((a, b) => a - b)
}

const closeIssues = (pr, repository, issues) => {
  const body = JSON.parse(gh('pr', 'view', pr, '--repo', repository, '--json', 'body')).body
  execFileSync('gh', ['pr', 'edit', pr, '--repo', repository, '--body-file', '-'], {
    input: releaseBody(body, issues),
  })
  console.log(
    issues.length ? `Release PR #${pr} closes #${issues.join(', #')}` : 'No pending issues ship.',
  )
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, ...args] = process.argv.slice(2)
  if (command === 'pending' && args.length === 1) {
    console.log(pendingIssues(args[0]).join(' '))
  } else if (command === 'close' && /^\d+$/.test(args[0] ?? '') && args[1]) {
    const issues = args
      .slice(2)
      .flatMap((list) => list.split(/\s+/))
      .filter(Boolean)
    if (!issues.every((issue) => /^\d+$/.test(issue))) throw new Error(`Bad issues: ${issues}`)
    closeIssues(args[0], args[1], issues.map(Number))
  } else {
    throw new Error(
      'Usage: release-issues.mjs pending <owner/repo> | close <PR> <owner/repo> [issue ...]',
    )
  }
}
