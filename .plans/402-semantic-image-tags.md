# #402 Publish semantic image tags with Bun as the default runtime

## Summary

Publish familiar semantic image aliases for each app version. Point unsuffixed backend tags and the
published chart at Bun, while retaining explicit Bun and Node choices and immutable paired-release
tags.

## Acceptance criteria

- [ ] Backend Bun images use unsuffixed and `-bun` latest, major, minor, patch, and paired tags.
- [ ] Backend Node images use `-node` latest, major, minor, patch, and paired tags.
- [ ] Frontend images use unsuffixed latest, major, minor, patch, and paired tags.
- [ ] Patch and paired tags stay immutable. Moving aliases update only when their app version changes.
- [ ] Published Helm charts pin the Bun backend image by default.
- [ ] Both registries receive the same tested image manifests.

## TODOs

- [x] Define the tag matrix, Bun default mapping, and release tests.
- [x] Publish immutable and moving aliases only for apps released by the Changesets merge.
- [ ] Update self-hosting docs and release notes, then run all validation.

## Notes

- Keep the paired `backend-X.Y.Z-frontend-X.Y.Z` tags and digest assets for server release provenance.
- `node --test .github/scripts/prepare-portable-release.test.mjs` passes with four tests.
- `pnpm test:release` passes all 50 tests.
- `actionlint -shellcheck=''` passes both changed workflows.
