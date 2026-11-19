---
title: Self-hosting
order: 1
---

Run your own Caelestis server to share templates and progress with a group. The backend stores the data. The frontend serves the dashboard and forwards client requests.

## Choose a deployment

| Setup | Database and artwork storage | Guide |
| --- | --- | --- |
| Docker, default | SQLite and files in Docker volumes | [Run with Docker](Run-with-Docker) |
| Docker with PostgreSQL | PostgreSQL container and filesystem objects | [PostgreSQL](Docker-Compose-with-PostgreSQL) |
| Docker with MariaDB | MariaDB 11.8 container and filesystem objects | [MariaDB](Docker-Compose-with-MariaDB) |
| Docker with an existing CNPG database | External PostgreSQL primary and filesystem or S3 objects | [CNPG](Docker-Compose-with-CNPG) |
| Docker with S3 | Any supported database, with RustFS or an external bucket | [S3 storage](S3-object-storage) |
| Kubernetes | Helm chart with your database and storage | [Kubernetes with Helm](Kubernetes-with-Helm) |
| Cloudflare | Workers, D1, R2, and Durable Objects | [Deploy on Cloudflare](Deploy-on-Cloudflare) |

For a first local installation, start with Docker's default stack. You can choose another database or object store before creating data.

Changing a storage setting does not move existing data to another provider.

## What you need

For Docker, you need Docker Compose and disk space for the database, template images, and retained tile history. The supplied stack builds the backend and frontend from the checkout.

For remote access, you also need an HTTPS address. Put a reverse proxy in front of the frontend, enable WebSocket forwarding, and set `ORIGIN` to its public URL.

The frontend is available to anyone who can reach its URL. Its backend read token is a server credential, not a visitor login. Restrict access at your proxy if the dashboard should be private.

## Backend replicas

Run one active backend per database. The backend holds an ownership lock and stops if it loses the database connection.

PostgreSQL can have replicas and failover, including through CNPG. Caelestis connects to the writable primary. Use a direct connection or session pooling, not transaction pooling.

SQLite needs local or block-backed storage with working POSIX locks. Do not put its database on a network filesystem.

## After installation

[Connect from Wplace](Connect-to-a-server), add artwork, and create report tokens for painters. Keep the bootstrap administrator token private.

## Set up the dashboard for your group

1. In the Wplace panel, connect as an administrator. On the server row, choose **Edit server details**.

   ![The server row's controls, with Edit server details outlined.](images/self-hosting/edit-server-details-button.png)

2. Set **Name**, **Description**, **Home page copy** and **Discord invite**. The invite adds a join button to the dashboard header.
3. Set **Logo text** or upload a **Logo image**. Use **Link preview image** for the home page's share image. Click **Save details**.

   ![Edit server details with a name, description, home page copy, logo text and the logo and link preview uploads.](images/self-hosting/edit-server-details.png)

   ![The dashboard home page showing the saved name and home page copy above the template folders.](images/self-hosting/dashboard-result.png)

Before upgrading, read [Storage and backups](Storage-and-backups) and [Deployment and upgrades](Deployment-and-upgrades).

The [source configuration reference](https://github.com/mia-cx/Caelestis/blob/main/docs/self-hosting.md) lists all runtime variables.
