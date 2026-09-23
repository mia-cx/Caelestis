import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { approveDependabotHead, validationState } from './dependabot-validation.mjs'

const sha = 'a'.repeat(40)
const repository = 'mia-riezebos/Caelestis'
const approval = {
  repository,
  number: '508',
  sha,
  event: 'workflow_dispatch',
  ref: 'refs/heads/main',
}
const pr = {
  number: 508,
  state: 'open',
  user: { login: 'dependabot[bot]', type: 'Bot' },
  base: { ref: 'main', repo: { full_name: repository } },
  head: { sha, repo: { full_name: repository, fork: false } },
}

describe('Dependabot approval', () => {
  it('accepts only the exact reviewed head', () => {
    assert.equal(approveDependabotHead(pr, approval), sha)
    assert.throws(() =>
      approveDependabotHead({ ...pr, head: { ...pr.head, sha: 'b'.repeat(40) } }, approval),
    )
  })

  it('rejects automatic events, arbitrary refs, malformed numbers, and abbreviated SHAs', () => {
    for (const change of [
      { event: 'pull_request' },
      { event: 'pull_request_target' },
      { ref: 'refs/heads/dependabot/test' },
      { ref: 'refs/tags/main' },
      { number: '508; echo unsafe' },
      { number: '0' },
      { number: '5e2' },
      { sha: 'abcdef0' },
      { sha: 'A'.repeat(40) },
    ]) {
      assert.throws(() => approveDependabotHead(pr, { ...approval, ...change }))
    }
  })

  it('rejects closed, unrelated, human-authored, deleted-head, and fork PRs', () => {
    for (const change of [
      { state: 'closed' },
      { number: 507 },
      { user: { login: 'mia-riezebos', type: 'User' } },
      { user: { login: 'dependabot[bot]', type: 'User' } },
      { head: { ...pr.head, repo: null } },
      { head: { ...pr.head, repo: { full_name: repository, fork: true } } },
      { head: { ...pr.head, repo: { full_name: 'other/repo', fork: false } } },
      { base: { ...pr.base, ref: 'release' } },
      { base: { ...pr.base, repo: { full_name: 'other/repo' } } },
    ]) {
      assert.throws(() => approveDependabotHead({ ...pr, ...change }, approval))
    }
  })
})

describe('Dependabot validation result', () => {
  const passing = Object.fromEntries(
    ['approve', 'userscript', 'portable', 'cloudflare'].map((suite) => [
      suite,
      { result: 'success' },
    ]),
  )

  it('requires every suite to pass', () => {
    assert.equal(validationState(passing), 'success')
    assert.equal(validationState({}), 'failure')
    for (const suite of Object.keys(passing)) {
      for (const result of ['failure', 'cancelled', 'skipped', 'pending', undefined]) {
        assert.equal(validationState({ ...passing, [suite]: { result } }), 'failure')
      }
      const missing = { ...passing }
      delete missing[suite]
      assert.equal(validationState(missing), 'failure')
    }
  })
})
