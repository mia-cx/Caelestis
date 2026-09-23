import { execFileSync } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const suites = ['approve', 'userscript', 'portable', 'cloudflare']

/** Bind a maintainer's manual approval to the current head of a same-repository Dependabot PR. */
export function approveDependabotHead(pr, { repository, number, sha, event, ref }) {
  if (event !== 'workflow_dispatch' || ref !== 'refs/heads/main') {
    throw new Error('Start Dependabot full validation from main with workflow_dispatch.')
  }
  if (!/^[1-9]\d*$/.test(number) || !/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Supply a PR number and its full lowercase 40-character head SHA.')
  }
  if (
    pr.number !== Number(number) ||
    pr.state !== 'open' ||
    pr.user?.login !== 'dependabot[bot]' ||
    pr.user?.type !== 'Bot' ||
    pr.base?.repo?.full_name !== repository ||
    pr.base?.ref !== 'main' ||
    pr.head?.repo?.full_name !== repository ||
    pr.head?.repo?.fork !== false
  ) {
    throw new Error('Select an open, same-repository Dependabot PR targeting main.')
  }
  if (pr.head.sha !== sha) {
    throw new Error('The PR head changed. Review the new commit and start a new run with its SHA.')
  }
  return sha
}

/** A missing, failed, cancelled, or skipped suite must never publish a passing commit status. */
export function validationState(needs) {
  return suites.every((suite) => needs[suite]?.result === 'success') ? 'success' : 'failure'
}

function api(path, fields) {
  const args = ['api', path]
  for (const [key, value] of Object.entries(fields ?? {})) args.push('-f', `${key}=${value}`)
  return JSON.parse(execFileSync('gh', args, { encoding: 'utf8' }))
}

function status(repository, sha, state, runUrl) {
  api(`repos/${repository}/statuses/${sha}`, {
    state,
    context: 'Dependabot full validation',
    description:
      state === 'pending'
        ? 'Approved commit: running all disposable targets'
        : state === 'success'
          ? 'Every validation suite passed'
          : 'Validation failed, was cancelled, or skipped a required suite',
    target_url: runUrl,
  })
}

function main(mode) {
  const env = process.env
  const repository = env.GITHUB_REPOSITORY
  const sha = env.APPROVED_SHA
  const runUrl = `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`
  if (mode === 'approve') {
    // Validate before composing the API path. Inputs are data, never shell source.
    if (!/^[1-9]\d*$/.test(env.PR_NUMBER ?? '')) throw new Error('Invalid PR number.')
    const pr = api(`repos/${repository}/pulls/${env.PR_NUMBER}`)
    approveDependabotHead(pr, {
      repository,
      number: env.PR_NUMBER,
      sha,
      event: env.GITHUB_EVENT_NAME,
      ref: env.GITHUB_REF,
    })
    status(repository, sha, 'pending', runUrl)
    appendFileSync(env.GITHUB_OUTPUT, `sha=${sha}\n`)
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      `Approved PR #${pr.number} at [${sha}](${env.GITHUB_SERVER_URL}/${repository}/commit/${sha}).\n\nWorkflow definitions: ${env.GITHUB_SHA}.\n`,
    )
    return
  }
  if (mode !== 'report') throw new Error(`Unknown mode: ${mode}`)
  if (!/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Missing approved commit.')
  const needs = JSON.parse(env.VALIDATION_NEEDS)
  const state = validationState(needs)
  status(repository, sha, state, runUrl)
  appendFileSync(
    env.GITHUB_STEP_SUMMARY,
    `Commit: ${sha}\n\n| Suite | Result |\n| --- | --- |\n${suites.map((suite) => `| ${suite} | ${needs[suite]?.result ?? 'missing'} |`).join('\n')}\n\n[Logs and artifacts](${runUrl})\n`,
  )
  if (state !== 'success') process.exitCode = 1
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2])
}
