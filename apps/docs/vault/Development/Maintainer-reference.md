---
title: Maintainer reference
---

These repository documents cover implementation and operation beyond the user guides.

## Deployment and releases

- [Self-hosting reference](https://github.com/mia-cx/Caelestis/blob/main/docs/self-hosting.md): runtime variables, adapters, migrations, and deployment details.
- [Stack testing](https://github.com/mia-cx/Caelestis/blob/main/docs/stack-testing.md): deployment test matrix and CI setup.
- [App releases](https://github.com/mia-cx/Caelestis/blob/main/docs/app-releases.md): Changesets and release publication.
- [Backend API versioning](https://github.com/mia-cx/Caelestis/blob/main/docs/backend-api-versioning.md): versioned routes and compatibility.

## Data and performance

- [Progress accounting](https://github.com/mia-cx/Caelestis/blob/main/docs/progress-recount.md): historical measurements and repair.
- [Capacity metrics](https://github.com/mia-cx/Caelestis/blob/main/docs/capacity-metrics.md): metrics and repeatable queries.
- [Collaboration performance](https://github.com/mia-cx/Caelestis/blob/main/docs/collaboration-performance.md): measured userscript profiling.
- [Live-sync acceptance](https://github.com/mia-cx/Caelestis/blob/main/docs/sync-acceptance.md): recovery and rollout checks.

Benchmark reports describe the version and environment tested. Re-run the checks before using them as current performance measurements.

## Docs maintenance

The docs live in `apps/docs/vault`. [Documentation screenshots](Documentation-screenshots) describes how to capture and check their images. Update the instructions and their image together when a workflow changes.
