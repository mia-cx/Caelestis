# MinIO volume

`volume.tar.gz` is the `/data` directory of a single-drive MinIO server, written on 2026-09-26 by
`quay.io/minio/minio@sha256:14cea493d9a34af32f524e538b8346cf79f3321eff8e708c1e2960462bd8936e`,
the image `deploy/compose/s3.yaml` ran before RustFS. That image can no longer be pulled, so this
archive is the only way to test the Compose migration against bytes MinIO really wrote.

`manifest.json` lists the objects in the `caelestis` bucket: key, MD5, size, content type, and
user metadata. The root credentials were `caelestis` / `compose-minio-test-password`.
