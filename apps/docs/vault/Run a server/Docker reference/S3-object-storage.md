---
title: S3 object storage
---

Store template artwork, tile history and social images in a local or external S3-compatible bucket.

You can combine S3 with SQLite, PostgreSQL, MariaDB, or CNPG. Choose the store before importing data. Changing the adapter does not copy existing objects.

## Local RustFS

The supplied S3 Compose file starts RustFS and creates a `caelestis` bucket. Data stays in a Docker volume on this host.

Set the object-store password in `.env`.

~~~dotenv
MINIO_ROOT_PASSWORD=replace-with-a-long-private-password
~~~

Include the S3 overlay to start SQLite with RustFS.

~~~sh
docker compose -f compose.yaml -f deploy/compose/s3.yaml up --build -d --wait
~~~

For PostgreSQL, include both overlays.

~~~sh
docker compose -f compose.yaml -f deploy/compose/postgres.yaml -f deploy/compose/s3.yaml up --build -d --wait
~~~

| Parameter | Default or purpose |
| --- | --- |
| `MINIO_ROOT_USER` | `caelestis` |
| `MINIO_ROOT_PASSWORD` | Required. Used by RustFS and the application containers in this local example. |
| `rustfs` volume | RustFS's persistent data. |
| Internal endpoint | `http://s3:9000` on the Compose network. |

Both application containers use the same bucket. The overlay keeps the `MINIO_ROOT_USER` and `MINIO_ROOT_PASSWORD` variable names for RustFS.

For an existing MinIO installation, the migration service reads the old `s3` volume and copies its files into `rustfs`. Initialisation checks the migrated objects before the backend starts. Keep a [database and bucket backup](Storage-and-backups) before upgrading.

## External S3 provider

Create a dedicated bucket and credentials with your provider. Use the base Compose file and your database overlay.

Configure the external bucket and its credentials in `.env`.

~~~dotenv
OBJECT_STORAGE=s3
S3_BUCKET=caelestis
S3_ENDPOINT=https://s3.example.com
S3_REGION=us-east-1
S3_FORCE_PATH_STYLE=false
AWS_ACCESS_KEY_ID=replace-with-your-access-key
AWS_SECRET_ACCESS_KEY=replace-with-your-secret-key
~~~

Use your provider's endpoint and signing region. Set `S3_FORCE_PATH_STYLE=true` if the provider requires it. Temporary credentials can also use `AWS_SESSION_TOKEN`.

The credentials need object read, write, delete, and bucket-list permissions. The provider must support conditional object creation with `If-None-Match: *`.

Start your chosen database stack with its normal Compose files. Both application containers receive the S3 settings from the base file.

## Backups

Back up the database and bucket while application writes are stopped. Keep matching copies from the same backup window.

Use one application bucket per Caelestis database. CNPG database backups belong in a separate backup location.

See [Storage and backups](Storage-and-backups) and [Kubernetes with Helm](Kubernetes-with-Helm) for Kubernetes configuration.
