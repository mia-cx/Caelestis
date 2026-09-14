# #400 Publish portable images to Docker Hub and GHCR

## Summary

Promote each tested portable image to Docker Hub and GHCR from one checksummed build artifact.
Keep Docker Hub as the Helm default and expose immutable references for both registries.

## Acceptance criteria

- [ ] The release publishes amd64 and arm64 Node, Bun, and frontend images to both registries.
- [ ] Both registries receive the default Node, explicit Node, explicit Bun, and frontend manifest lists.
- [ ] Release retries verify existing per-architecture images and manifest lists before succeeding.
- [ ] GHCR uses the workflow package token; Docker Hub keeps its existing secret.
- [ ] Release assets and self-hosting docs expose digest-pinned references for both registries.
- [ ] Local release tests, workflow validation, and repository checks pass without publishing a release.

## TODOs

- [x] Define and test canonical image variants and registry locations.
- [~] Publish tested image artifacts to both registries with retry-safe verification.
- [ ] Document both registries and add release notes for the new distribution option.
- [ ] Complete repository checks and file the pull request.

## Notes

- Docker Hub publication and the architecture build already exist after #390. This issue adds GHCR to the same promotion step; it does not rebuild images.
- Keep `docker.io/miacx/caelestis-backend` and `docker.io/miacx/caelestis-frontend` as chart defaults.
- Mirror them at `ghcr.io/mia-riezebos/caelestis-backend` and `ghcr.io/mia-riezebos/caelestis-frontend`.
- Preserve the existing `*-image.txt` Docker Hub release assets for compatibility. Add explicit Docker Hub and GHCR assets beside them.
- TODO 1: `portableImages` defines the four tags once and maps them to matching Docker Hub and GHCR packages. The release preparation command writes this as `images.json`. Three release helper tests and Biome pass.
