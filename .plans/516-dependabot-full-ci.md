# #516 Approved full validation for Dependabot PRs

## Summary

Manually approve an exact Dependabot PR head for userscript validation and the complete disposable deployment matrix.

## Acceptance criteria

- [x] Reject closed, foreign, non-Dependabot, and stale PR selections before candidate code runs.
- [x] Run userscript/shared/UI checks and the extended portable and Cloudflare acceptance suites.
- [x] Publish a commit status with the run link; require every suite to succeed.
- [x] Keep production credentials, publication, and deployment outside this workflow.
- [ ] Document approval and the distinction between candidate source and trusted workflow definitions.

## TODOs

- [x] Add the exact-commit approval and result reporter with adversarial tests.
- [x] Connect reusable validation workflows and test their routing and permissions.
- [ ] Document the manual run, validate workflow syntax and release tooling, and file the PR.

## Notes

- Created issue #516 and branch `t3code/dependabot-full-ci` from current `origin/main` before implementation.
- Workflow dispatch runs trusted definitions from main; the maintainer supplies both the PR number and reviewed head SHA.
- Only the Cloudflare test token crosses the reusable-workflow boundary. The called job uses the existing `stack-tests` environment.
- GitHub Actions version changes still need their ordinary PR checks; manual validation uses main's action versions.
- Approval/result tests pass for stale commits, untrusted selections, and every non-success suite result. Read-only validation against actual PR #508 also passed.
- All 62 release-tooling tests pass, including the command entrypoint with intercepted GitHub API calls. Actionlint 1.7.12 accepts all four changed workflows. Lint passes with the existing adjacent-space regex warning in release-workflow.test.mjs.
- Added wire-schema tests to portable runtime coverage; full userscript calls also run lint and the root fixture, capacity, progress, and live-paint suites.
