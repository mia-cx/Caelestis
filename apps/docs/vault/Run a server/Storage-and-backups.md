---
title: Storage and backups
---

Back up the database and application objects together on Docker or Kubernetes. The database stores progress and token records. The object store holds artwork and tile history.

On Cloudflare, state is split across D1, R2, and Durable Objects. A D1 export plus an R2 copy is not a complete equivalent of the portable backup below.

## Move between deployments

Use a server archive to move between Cloudflare, Docker and Kubernetes, including across database and object-storage types.

1. Prepare an empty destination database and object store. Configure the destination's server settings and credentials.
2. Build the archive client with `pnpm --filter @caelestis/backend build`. Set `ADMIN_TOKEN` in your shell to the source server's administrator token.
3. Export the archive during downtime. The source pauses writes and most reads, and stays paused after the file finishes. Replace the example address with the source API root.

   ~~~sh
   node apps/backend/dist/archive/cli.js export https://source.example.com/backend/v1 server.ndjson
   ~~~

4. For a backup, run `finish-export` against the same API root to reopen the source. For a move, keep the source paused. Set `ADMIN_TOKEN` to the destination's administrator token and import into the empty destination.

   ~~~sh
   node apps/backend/dist/archive/cli.js import https://destination.example.com/backend/v1 server.ndjson
   ~~~

5. Check a template and its history, then issue destination tokens and reconnect clients. Archives include artwork, history and progress. Access tokens and deployment secrets stay with the installation that owns them.

See the [server archive reference](https://github.com/mia-cx/Caelestis/blob/main/docs/server-archives.md) for status, interrupted transfers and restore requirements.

## What to keep

| Store | Contents |
| --- | --- |
| Relational database | Templates, folders, progress, tokens, coordinator state, and scheduled work. |
| Application objects | Artwork, retained tile blobs, and social images. |
| Deployment configuration | Version references, environment settings, and securely stored credentials. |

For default Docker, the database is in `data` and objects are in `objects`. PostgreSQL and MariaDB stacks use their own database volume. The local RustFS service stores bucket data in the `rustfs` volume.

Docker prefixes volume names with the Compose project name. Check the actual names before backing up or restoring them.

## Take a consistent backup

Stop both applications to pause writes to the database and object store.

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
| S3 or RustFS | Capture the complete application bucket, including object metadata. |

Record the app version beside the backup. Store credentials securely, separate from copies shared for debugging.

Restart the applications after both stores are backed up.

~~~sh
docker compose start backend frontend
~~~

For CNPG, database backups do not include the Caelestis object bucket. Back up that bucket separately.

## Default Docker backup

For SQLite and filesystem storage, export both volumes from the checkout while the application containers are stopped.

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

Inspect both tar archives before restarting the applications.

~~~sh
tar -tf "$backup_dir/data.tar"
tar -tf "$backup_dir/objects.tar"
docker compose start backend frontend
~~~

Copy the backup off the Docker host. Keep the matching private `.env` securely with your deployment records, not in Git.

## PostgreSQL and MariaDB

Leave the database container running while the application containers are stopped. With the usual Compose files selected, create a dated backup directory.

~~~sh
umask 077
backup_dir="backups/$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$backup_dir"
~~~

For PostgreSQL, write a custom-format dump.

~~~sh
docker compose exec -T postgres pg_dump -U caelestis -d caelestis -Fc > "$backup_dir/postgres.dump"
~~~

For MariaDB, write a consistent SQL dump.

~~~sh
docker compose exec -T mariadb sh -c \
  'MYSQL_PWD="$MARIADB_PASSWORD" mariadb-dump --user=caelestis --single-transaction caelestis' > "$backup_dir/mariadb.sql"
~~~

These files contain private server data. `umask 077` makes the directory and dump readable only by you. Back up the matching object store before restarting the applications.

Use [PostgreSQL's restore procedure](https://www.postgresql.org/docs/current/app-pgrestore.html) or [MariaDB's dump and restore procedure](https://mariadb.com/kb/en/mariadb-dump/) for the database. For CNPG, use your operator's backup and recovery process.

## Restore

Stop the application. Restore the database and objects from the same backup window, then start the application version recorded with that backup.

First test the restore in an isolated environment. Do not point a test backend at the live database or bucket.

For SQLite/filesystem, use an isolated checkout with the same application version and **empty destination volumes**. Extract both archives before starting the applications.

~~~sh
docker compose run --rm --no-deps -T --entrypoint tar backend \
  -C /data -xf - < /path/to/backup/data.tar
docker compose run --rm --no-deps -T --entrypoint tar backend \
  -C /objects -xf - < /path/to/backup/objects.tar
docker compose up -d --no-build --wait
~~~

Use the backed-up configuration and image references. Do not extract over a running server or nonempty volumes. Leftover files may not belong to the backup.

Open a known template and confirm that its artwork, progress, and history load before reopening writes.

## Storage constraints

SQLite requires a filesystem with working POSIX locks. Use local or block-backed storage, not a network filesystem.

Keep each Caelestis database paired with its own object directory or bucket. Let the storage adapter manage its object files.

Changing `DB_ADAPTER` or `OBJECT_STORAGE` selects a different store. It is not a migration command.

For upgrade rollback, see [Deployment and upgrades](Deployment-and-upgrades#rollback).
