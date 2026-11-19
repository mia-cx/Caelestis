---
title: PostgreSQL Docker stack
---

Run the backend, dashboard, and PostgreSQL 17 on one Docker host. Artwork and tile objects stay in the `objects` volume.

## Setup

Complete the checkout and common `.env` settings in [Run with Docker](Run-with-Docker#1-download-caelestis). Generate a password for the database before starting it.

~~~sh
openssl rand -hex 32
~~~

Put the generated password in `.env`.

~~~dotenv
POSTGRES_PASSWORD=replace-with-the-generated-password
~~~

Start the containers and check their health.

~~~sh
docker compose -f compose.yaml -f deploy/compose/postgres.yaml up --build -d --wait
docker compose -f compose.yaml -f deploy/compose/postgres.yaml ps
~~~

Open [http://localhost:3000](http://localhost:3000). The [Docker guide](Run-with-Docker#4-open-the-dashboard) shows the dashboard and Wplace connection steps.

## Parameters

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | Yes | Bootstrap administrator token. |
| `CAELESTIS_READ_TOKEN` | Yes | Separate dashboard read token. |
| `SEASON` | Set explicitly | The Wplace canvas season. |
| `POSTGRES_PASSWORD` | Yes | Password for the `caelestis` database user. |

The overlay supplies the backend's PostgreSQL host, user, database, and adapter settings. It overrides the example's SQLite selection.

PostgreSQL listens on port 5432 inside the Compose network. The file does not publish that port to the host.

## Volumes

| Volume | Contents |
| --- | --- |
| `postgres` | PostgreSQL database, including progress, tokens, and coordinator state. |
| `objects` | Template artwork, tile blobs, and social images. |
| `data` | Backend local files and cache. |

Back up `postgres` and `objects` together. See [Storage and backups](Storage-and-backups).

## Operations

Pass the base file and the database overlay when inspecting or stopping the stack.

~~~sh
docker compose -f compose.yaml -f deploy/compose/postgres.yaml logs -f
docker compose -f compose.yaml -f deploy/compose/postgres.yaml down
~~~

`down` keeps the volumes. For updates, follow [Deployment and upgrades](Deployment-and-upgrades).

To store artwork in RustFS, add `-f deploy/compose/s3.yaml` and configure its password. For an existing database managed by CNPG, use [CNPG Docker stack](Docker-Compose-with-CNPG).
