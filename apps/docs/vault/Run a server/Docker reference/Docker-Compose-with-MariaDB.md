---
title: MariaDB Docker stack
---

Run the backend, dashboard, and MariaDB 11.8 on one Docker host. Artwork and tile objects stay in the `objects` volume.

## Setup

Complete the checkout and common `.env` settings in [Run with Docker](Run-with-Docker#1-download-caelestis). Generate a password for the database before starting it.

~~~sh
openssl rand -hex 32
~~~

Put the generated password in `.env`.

~~~dotenv
MARIADB_PASSWORD=replace-with-the-generated-password
~~~

Start the containers and check their health.

~~~sh
docker compose -f compose.yaml -f deploy/compose/mariadb.yaml up --build -d --wait
docker compose -f compose.yaml -f deploy/compose/mariadb.yaml ps
~~~

Open [http://localhost:3000](http://localhost:3000). The [Docker guide](Run-with-Docker#4-open-the-dashboard) shows the dashboard and Wplace connection steps.

## Parameters

| Variable | Required | Purpose |
| --- | --- | --- |
| `ADMIN_TOKEN` | Yes | Bootstrap administrator token. |
| `CAELESTIS_READ_TOKEN` | Yes | Separate dashboard read token. |
| `SEASON` | Set explicitly | The Wplace canvas season. |
| `MARIADB_PASSWORD` | Yes | Password for the `caelestis` database user. |

The overlay supplies the backend's MariaDB connection and adapter settings. MariaDB listens on port 3306 inside the Compose network.

## Volumes

| Volume | Contents |
| --- | --- |
| `mariadb` | MariaDB database, including progress, tokens, and coordinator state. |
| `objects` | Template artwork, tile blobs, and social images. |
| `data` | Backend local files and cache. |

Back up `mariadb` and `objects` together. See [Storage and backups](Storage-and-backups).

## Operations

~~~sh
docker compose -f compose.yaml -f deploy/compose/mariadb.yaml logs -f
docker compose -f compose.yaml -f deploy/compose/mariadb.yaml down
~~~

Run one backend. It holds an ownership lock through its database connection and stops if that connection is lost.

For updates, follow [Deployment and upgrades](Deployment-and-upgrades). To use RustFS or an external bucket, see [S3 object storage](S3-object-storage).
