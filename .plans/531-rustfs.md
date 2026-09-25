# #531 Replace the withdrawn MinIO image with RustFS, and migrate existing Compose data

## Summary
MinIO's images can't be pulled anymore, so CI, releases, and new `s3.yaml` installs fail. Switch
the bundled S3 service to RustFS. Existing Compose servers move their MinIO volume by copy, with
the old volume left untouched for rollback. The operator deletes it after the migration.

## Acceptance criteria
- [ ] CI, the Helm stack test, and the Compose stack test run against a pinned RustFS image.
- [ ] A fresh `s3.yaml` install starts with RustFS and needs no MinIO.
- [ ] An existing install upgrades with no manual steps; objects and metadata arrive; old volume unchanged.
- [ ] Starting again after a migration doesn't copy again.
- [ ] Existing `MINIO_ROOT_USER` / `MINIO_ROOT_PASSWORD` keep working.
- [ ] Docs cover the switch, rollback, and deleting the old volume.
- [ ] A backend Changeset.

## TODOs
- [x] Add a fixture of a volume written by the real MinIO image, with a manifest.
- [ ] Switch `deploy/compose/s3.yaml` to RustFS with a copy migration and a count check.
- [ ] Cover the migration in the Compose stack test.
- [ ] Switch CI and the Helm stack test to RustFS.
- [ ] Update self-hosting docs; Changeset.
- [ ] Final validation: run the S3 Compose stack locally, lint, script tests.

## Notes
- Design change from the issue: copy the raw volume files instead of reading through
  `pgsty/minio`. RustFS converts MinIO's single-drive layout on first start, so it converts the
  copy. The old volume is mounted read-only. No dependency on the fork staying pullable.
- Verified locally on 2026-09-26: 40 objects written by `quay.io/minio/minio@sha256:14cea4...`,
  copied and chowned to 10001, served by `rustfs/rustfs:1.0.0` with matching bytes, ETags,
  content types, metadata, and a 412 for `If-None-Match: *`.
- RustFS runs as uid 10001 and MinIO wrote files as root, so the copy needs a chown.
- The backend image runs as `node` (uid 1000); the migration state volume must be writable by it.
