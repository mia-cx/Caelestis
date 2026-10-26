---
title: Docker Compose stacks
---

Every stack starts with `compose.yaml`, which runs the backend and frontend. Additional Compose files replace the database or object-storage settings.

## Stack files

| Database | Filesystem objects | Local MinIO objects |
| --- | --- | --- |
| SQLite | `compose.yaml` | Base + `deploy/compose/s3.yaml` |
| PostgreSQL | Base + `deploy/compose/postgres.yaml` | Base + PostgreSQL + S3 files |
| MariaDB | Base + `deploy/compose/mariadb.yaml` | Base + MariaDB + S3 files |
| Existing CNPG | Base + `deploy/compose/cnpg.yaml` | Base + CNPG + S3 files |

For an external S3 provider, configure the bucket in `.env` instead of adding the MinIO file.

## Set up once

Clone the repository and configure the common environment values as shown in [Run with Docker](Run-with-Docker#1-download-caelestis). Then use the guide for your chosen stack:

- [PostgreSQL](Docker-Compose-with-PostgreSQL)
- [MariaDB](Docker-Compose-with-MariaDB)
- [Existing CNPG](Docker-Compose-with-CNPG)
- [Local or external S3](S3-object-storage)

Configure the stack before its first start. Selecting another adapter later does not migrate the existing database or objects.

## Keep the same file list

Every operation must use the same Compose files. Save the list in `.env` to avoid repeating it.

For PostgreSQL and MinIO on Linux or macOS:

~~~dotenv
COMPOSE_FILE=compose.yaml:deploy/compose/postgres.yaml:deploy/compose/s3.yaml
~~~

On Windows, use semicolons instead of colons between paths.

Then run:

~~~sh
docker compose up --build -d --wait
docker compose ps
docker compose logs -f
~~~

Alternatively, supply the files explicitly each time:

~~~sh
docker compose -f compose.yaml -f deploy/compose/postgres.yaml -f deploy/compose/s3.yaml up --build -d --wait
~~~

## Common operations

| Task | Command, with your configured file list |
| --- | --- |
| Start or rebuild from source | `docker compose up --build -d --wait` |
| Check health | `docker compose ps` |
| Follow logs | `docker compose logs -f` |
| Stop and keep data | `docker compose down` |
| Pull configured release images | `docker compose pull` |
| Start pulled images | `docker compose up -d --no-build --wait` |

Do not use `down --volumes` unless you want to delete the stack's data.

See [Container images](Container-images) for release references and [Deployment and upgrades](Deployment-and-upgrades) for updates.
