# #432 ci: CNPG operator never becomes ready in the helm stack tests

## Summary
The helm stack test installs the CloudNativePG operator from a pinned commit of `cloudnative-pg/artifacts`. That manifest points at `ghcr.io/cloudnative-pg/cloudnative-pg-testing:release-1.30@sha256:b57e...`, a nightly testing image. GitHub pruned that digest, so the operator pod can never pull its image and the rollout wait times out. Switch to the official 1.30.0 release manifest, pin it by tag commit, checksum and image digest, and capture operator diagnostics on failure.

## Acceptance criteria
- [ ] `helm (cnpg, node)` and `helm (cnpg, bun)` reach ready on GitHub-hosted runners with a fresh kind cluster.
- [ ] The operator manifest and image are pinned so an upstream change cannot break unrelated PRs.
- [ ] A failing run captures `cnpg-system` pods, events and operator logs.
- [ ] Everything still runs on GitHub Actions without a self-hosted runner; an existing cluster context stays optional.

## TODOs
- [ ] Install the operator from the pinned official 1.30.0 release manifest with checksum and image digest verification.
- [ ] Capture `cnpg-system` diagnostics in the stack cleanup.
- [ ] Validate with a local kind smoke test and the PR's Portable server CI run.

## Notes
- `docker manifest inspect` on the old testing digest fails with "manifest verification failed"; the `release-1.30` tag now points elsewhere. That matches the 2026-09-17 break with no repo change.
- Release manifest: `cloudnative-pg/cloudnative-pg` tag `v1.30.0` = commit `4b5e244a7d031f67e025c83c1555e7726ecbbfa1`, `releases/cnpg-1.30.0.yaml` sha256 `f8bede43fe4ee0d478c2355b204a36876b2ae4faac60f2a9452280b293da3b88`, image `ghcr.io/cloudnative-pg/cloudnative-pg:1.30.0` index digest `sha256:a2701eb97cdd2a34b1fdb2cb51987f544b706e40bec72ae7146cd8580efefebb`.
- Runner choice: the script already creates a kind cluster when `CAELESTIS_KUBE_CONTEXT` is unset, so GitHub-hosted runners need nothing extra. No self-hosted runner requirement is added.
