---
title: CNPG Docker stack
---

Runs Caelestis in Docker against an existing CloudNativePG database. It does not install CNPG or create a Kubernetes cluster.

If Caelestis will run inside Kubernetes too, use [Kubernetes with Helm](Kubernetes-with-Helm).

## Requirements

You need a writable PostgreSQL primary reachable from the Docker network, an application database and user, and its CA certificate.

A Kubernetes-only `.svc` address usually is not reachable from a separate Docker host. Use a reachable hostname covered by the database certificate.

## Setup

Complete the checkout and common settings in [Run with Docker](Run-with-Docker#1-download-caelestis). Add your CNPG connection to `.env`:

~~~dotenv
PGHOST=postgres.example.com
PGPORT=5432
PGDATABASE=caelestis
PGUSER=caelestis
PGPASSWORD=replace-with-the-application-password
PG_TLS_CA_FILE=/absolute/path/to/cnpg-ca.crt
~~~

Use the database name, user, and password from your CNPG application Secret. The user must be able to create and migrate tables.

Start the stack:

~~~sh
docker compose -f compose.yaml -f deploy/compose/cnpg.yaml up --build -d --wait
docker compose -f compose.yaml -f deploy/compose/cnpg.yaml ps
~~~

Open [http://localhost:3000](http://localhost:3000). The [Docker guide](Run-with-Docker#4-open-the-dashboard) shows the initial dashboard and userscript connection steps.

## Parameters

| Variable | Purpose |
| --- | --- |
| `PGHOST` | Writable-primary hostname, also used for certificate verification. |
| `PGPORT` | Database port; defaults to `5432`. |
| `PGDATABASE`, `PGUSER`, `PGPASSWORD` | Application database credentials. |
| `PG_TLS_CA_FILE` | Existing CA file on the Docker host. The overlay mounts it read-only. |

Keep the common `ADMIN_TOKEN`, `CAELESTIS_READ_TOKEN`, and `SEASON` settings. The overlay selects PostgreSQL and `verify-full` TLS.

## Storage

The database lives in CNPG. By default, application objects live in the Docker `objects` volume.

You can instead configure [S3 object storage](S3-object-storage). CNPG's database backup bucket does not contain Caelestis artwork or tile objects. Back up both stores.

## Failover and operations

Use a direct connection or session pooling. Transaction pooling cannot preserve the backend's ownership lock.

Run one backend. If it loses its database connection, it stops. The restart policy lets it reconnect when the writable primary becomes available.

~~~sh
docker compose -f compose.yaml -f deploy/compose/cnpg.yaml logs -f backend
docker compose -f compose.yaml -f deploy/compose/cnpg.yaml down
~~~
