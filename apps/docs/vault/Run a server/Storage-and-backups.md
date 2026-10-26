---
title: Storage and backups
---

This page covers the Docker and Kubernetes runtimes. A complete portable backup has two parts: the database and application objects. The database alone cannot restore template images or tile history.

On Cloudflare, state is split across D1, R2, and Durable Objects. A D1 export plus an R2 copy is not a complete equivalent of the portable backup below.

## What to keep

| Store | Contents |
| --- | --- |
| Relational database | Templates, folders, progress, tokens, coordinator state, and scheduled work. |
| Application objects | Artwork, retained tile blobs, and social images. |
| Deployment configuration | Version references, environment settings, and securely stored credentials. |

For default Docker, the database is in `data` and objects are in `objects`. PostgreSQL and MariaDB stacks use their own database volume. MinIO uses the `s3` volume.

Docker prefixes volume names with the Compose project name. Check the actual names before backing up or restoring them.

## Take a consistent backup

Stop the backend and frontend so objects and database records stop changing:

~~~sh
docker compose stop backend frontend
~~~

Use the same Compose file list as the running stack.

Back up the database with the tool for that adapter. Copy the matching object directory or bucket while writes remain stopped.

| Adapter | Backup requirements |
| --- | --- |
| SQLite | Copy the full data directory while stopped, including any WAL files. |
| PostgreSQL | Use a consistent database backup including all Caelestis tables. |
| MariaDB | Use a consistent database backup including all Caelestis tables. |
| Filesystem objects | Copy the complete object directory. |
| S3 or MinIO | Capture the complete application bucket, including object metadata. |

Record the app version beside the backup. Store credentials securely, separate from copies shared for debugging.

Restart the unchanged stack afterward:

~~~sh
docker compose start backend frontend
~~~

For CNPG, database backups do not include the Caelestis object bucket. Back up that bucket separately.

## Default Docker backup

For the default SQLite/filesystem stack, run from the checkout while both application containers are stopped:

~~~sh
umask 077
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
docker compose run --rm --no-deps -T --entrypoint tar backend \
  -C /data -cf - . > "$backup_dir/data.tar"
docker compose run --rm --no-deps -T --entrypoint tar backend \
  -C /objects -cf - . > "$backup_dir/objects.tar"
git rev-parse HEAD > "$backup_dir/source-commit.txt"
docker compose images > "$backup_dir/images.txt"
~~~

Check that both archive commands succeeded. Inspect their contents before restarting:

~~~sh
tar -tf "$backup_dir/data.tar"
tar -tf "$backup_dir/objects.tar"
docker compose start backend frontend
~~~

Copy the backup off the Docker host. Keep the matching private `.env` securely with your deployment records, not in Git.

## PostgreSQL and MariaDB

Leave the database container running while the application containers are stopped. With the usual Compose files selected, create a new backup directory:

~~~sh
umask 077
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
~~~

Then export PostgreSQL:

~~~sh
docker compose exec -T postgres pg_dump -U caelestis -d caelestis -Fc > "$backup_dir/postgres.dump"
~~~

Or MariaDB:

~~~sh
docker compose exec -T mariadb sh -c \
  'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump --user=caelestis --single-transaction caelestis' > "$backup_dir/mariadb.sql"
~~~

These files contain private server data. `umask 077` makes the new directory and dump readable only by you. Back up the matching object store before restarting the applications.

Use [PostgreSQL's restore procedure](https://www.postgresql.org/docs/current/app-pgrestore.html) or [MariaDB's dump and restore procedure](https://mariadb.com/kb/en/mariadb-dump/) for the database. For CNPG, use your operator's backup and recovery process.

## Restore

Stop the application. Restore the database and objects from the same backup window, then start the application version recorded with that backup.

First test the restore in an isolated environment. Do not point a test backend at the live database or bucket.

For SQLite/filesystem, use an isolated checkout with the same application version and **empty destination volumes**. Restore before starting the applications:

~~~sh
docker compose run --rm --no-deps -T --entrypoint tar backend \
  -C /data -xf - < /path/to/backup/data.tar
docker compose run --rm --no-deps -T --entrypoint tar backend \
  -C /objects -xf - < /path/to/backup/objects.tar
docker compose up -d --no-build --wait
~~~

Use the backed-up configuration and image references. Do not extract over a running server or nonempty volumes; leftover files may not belong to the backup.

Open a known template and confirm that its artwork, progress, and history load before allowing new writes.

## Storage constraints

SQLite requires a filesystem with working POSIX locks. Use local or block-backed storage, not a network filesystem.

Keep each Caelestis database paired with its own object directory or bucket. The object files belong to the storage adapter; do not edit individual files by hand.

Changing `DB_ADAPTER` or `OBJECT_STORAGE` selects a different store. It is not a migration command.

For upgrade rollback, see [Deployment and upgrades](Deployment-and-upgrades#rollback).
