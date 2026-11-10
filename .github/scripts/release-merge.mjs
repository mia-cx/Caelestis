import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Only a merged release PR from this repository authorizes publication of this exact commit. */
export const isReleaseMerge = (pullRequests, context) =>
  Boolean(releasePullRequest(pullRequests, context))

/** Identify the merged Changesets PR whose head can authorize reuse of release checks. */
export const releasePullRequest = (pullRequests, { sha, repository }) =>
  pullRequests.find(
    (pr) =>
      typeof pr.merged_at === 'string' &&
      pr.merge_commit_sha === sha &&
      pr.base?.ref === 'main' &&
      pr.base?.repo?.full_name === repository &&
      pr.head?.ref === 'changeset-release/main' &&
      pr.head?.repo?.full_name === repository,
  )

const validatingWorkflows = ['portable-ci.yml', 'userscript-ci.yml']

const validationRun = (workflowRuns, pullRequest, workflow) =>
  workflowRuns.find(
    (run) =>
      run.event === 'pull_request' &&
      run.path?.split('@')[0] === `.github/workflows/${workflow}` &&
      run.head_sha === pullRequest.head.sha &&
      run.head_branch === pullRequest.head.ref &&
      run.head_repository?.full_name === pullRequest.head.repo.full_name &&
      run.status === 'completed' &&
      run.conclusion === 'success',
  )

/** Require both PR workflows on the exact release head, even after GitHub clears pull_requests. */
export const releaseValidated = (workflowRuns, pullRequest) =>
  validatingWorkflows.every((workflow) =>
    Boolean(validationRun(workflowRuns, pullRequest, workflow)),
  )

/** Reuse checks only when both successful runs recorded the exact tree being released. */
function validatedRelease(pullRequests, context) {
  const { sha, repository, event, ref } = context
  if (event !== 'push' || ref !== 'refs/heads/main') return false
  const pr = releasePullRequest(pullRequests, context)
  if (!pr || !/^[a-f0-9]{40}$/.test(pr.head.sha) || !Number.isSafeInteger(pr.number)) return false
  const runs = validatingWorkflows.flatMap((workflow) => {
    const pages = JSON.parse(
      execFileSync(
        'gh',
        [
          'api',
          `repos/${repository}/actions/workflows/${workflow}/runs?event=pull_request&head_sha=${pr.head.sha}&status=success&per_page=100`,
          '--paginate',
          '--slurp',
        ],
        { encoding: 'utf8' },
      ),
    )
    return pages.flatMap((page) => page.workflow_runs)
  })
  if (!releaseValidated(runs, pr)) return false
  const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
  // Squash merges and branch deletion can leave the tested head outside the checkout's history.
  git('fetch', '--no-tags', 'origin', `refs/pull/${pr.number}/head`)
  const releaseTree = git('rev-parse', `${sha}^{tree}`)
  const sameTree = releaseTree === git('rev-parse', `${pr.head.sha}^{tree}`)
  if (!sameTree)
    console.warn('::warning::Release tree differs from the validated PR; running checks.')
  if (!sameTree) return false
  const directory = mkdtempSync(join(tmpdir(), 'caelestis-release-check-trees-'))
  try {
    for (const workflow of validatingWorkflows) {
      const run = validationRun(runs, pr, workflow)
      const destination = join(directory, workflow)
      execFileSync(
        'gh',
        [
          'run',
          'download',
          String(run.id),
          '--repo',
          repository,
          '--name',
          'release-check-tree',
          '--dir',
          destination,
        ],
        { stdio: 'pipe' },
      )
      // PR runs normally check out a synthetic merge, not the head in the run's API metadata.
      const testedTree = readFileSync(join(destination, 'release-check-tree.txt'), 'utf8').trim()
      if (testedTree !== releaseTree) {
        console.warn(`::warning::${workflow} tested a different tree; running checks.`)
        return false
      }
    }
    return true
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [sha, repository, mode] = process.argv.slice(2)
  if (!sha || !repository) throw new Error('release-merge needs a commit SHA and repository')
  if (mode === 'validated') {
    const env = process.env
    let validated = false
    try {
      validated = validatedRelease(JSON.parse(readFileSync(0, 'utf8')).flat(), {
        sha,
        repository,
        event: env.GITHUB_EVENT_NAME,
        ref: env.GITHUB_REF,
      })
    } catch (cause) {
      console.warn(`::warning::Unable to reuse release PR checks; running checks. ${cause.message}`)
    }
    const output = `validated=${validated}\n`
    process.stdout.write(output)
    if (env.GITHUB_OUTPUT) appendFileSync(env.GITHUB_OUTPUT, output)
  } else {
    if (mode) throw new Error(`Unknown release-merge mode: ${mode}`)
    const pages = JSON.parse(readFileSync(0, 'utf8'))
    process.stdout.write(`${isReleaseMerge(pages.flat(), { sha, repository })}\n`)
  }
}
