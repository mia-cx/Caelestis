---
title: S3 object storage
---

S3 holds template artwork, tile blobs, and social images. It does not replace the relational database.

You can combine S3 with SQLite, PostgreSQL, MariaDB, or CNPG. Configure it before importing data; changing the adapter does not copy existing objects.

## Local MinIO

The supplied S3 Compose file starts MinIO and creates a `caelestis` bucket. Data stays in a Docker volume on this host.

Add a password to `.env`:

~~~dotenv
MINIO_ROOT_PASSWORD=replace-with-a-long-private-password
~~~

Start SQLite with MinIO:

~~~sh
docker compose -f compose.yaml -f deploy/compose/s3.yaml up --build -d --wait
~~~

Or PostgreSQL with MinIO:

~~~sh
docker compose -f compose.yaml -f deploy/compose/postgres.yaml -f deploy/compose/s3.yaml up --build -d --wait
~~~

| Parameter | Default or purpose |
| --- | --- |
| `MINIO_ROOT_USER` | `caelestis` |
| `MINIO_ROOT_PASSWORD` | Required. Used by MinIO and the application containers in this local example. |
| `s3` volume | MinIO's persistent data. |
| Internal endpoint | `http://s3:9000`; not published to the host. |

The overlay configures both application containers to use the same bucket.

## External S3 provider

Create a dedicated bucket and credentials with your provider. Do **not** add `deploy/compose/s3.yaml`; that file is for local MinIO.

Set these values in `.env`:

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
