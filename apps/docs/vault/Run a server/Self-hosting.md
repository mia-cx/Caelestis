---
title: Self-hosting
order: 1
---

Run your own Caelestis server to share templates and progress with a group. The backend stores the data; the frontend serves the dashboard and forwards userscript requests.

## Choose a deployment

| Setup | Database and artwork storage | Guide |
| --- | --- | --- |
| Docker, default | SQLite and files in Docker volumes | [Run with Docker](Run-with-Docker) |
| Docker with PostgreSQL | PostgreSQL container and filesystem objects | [PostgreSQL](Docker-Compose-with-PostgreSQL) |
| Docker with MariaDB | MariaDB 11.8 container and filesystem objects | [MariaDB](Docker-Compose-with-MariaDB) |
| Docker with an existing CNPG database | External PostgreSQL primary and filesystem or S3 objects | [CNPG](Docker-Compose-with-CNPG) |
| Docker with S3 | Any supported database, with MinIO or an external bucket | [S3 storage](S3-object-storage) |
| Kubernetes | Helm chart with your database and storage | [Kubernetes with Helm](Kubernetes-with-Helm) |
| Cloudflare | Workers, D1, R2, and Durable Objects | [Deploy on Cloudflare](Deploy-on-Cloudflare) |

For a first local installation, start with Docker's default stack. You can choose another database or object store before creating data.

Changing a storage setting does not move existing data to the new provider.

## What you need

For Docker, you need Docker Compose and disk space for the database, template images, and retained tile history. The supplied stack builds the backend and frontend from the checkout.

For remote access, you also need an HTTPS address. Put a reverse proxy in front of the frontend, enable WebSocket forwarding, and set `ORIGIN` to its public URL.

The frontend is available to anyone who can reach its URL. Its backend read token is a server credential, not a visitor login. Restrict access at your proxy if the dashboard should be private.

## Backend replicas

Run one active backend per database. The backend holds an ownership lock and stops if it loses the database connection.

PostgreSQL can have replicas and failover, including through CNPG. Caelestis connects to the writable primary. Use a direct connection or session pooling, not transaction pooling.

SQLite needs local or block-backed storage with working POSIX locks. Do not put its database on a network filesystem.

## After installation

[Connect the userscript](Connect-to-a-server), add artwork, and create report tokens for painters. Keep the bootstrap administrator token private.

Before upgrading, read [Storage and backups](Storage-and-backups) and [Deployment and upgrades](Deployment-and-upgrades).

The [source configuration reference](https://github.com/mia-cx/Caelestis/blob/main/docs/self-hosting.md) lists all runtime variables.
