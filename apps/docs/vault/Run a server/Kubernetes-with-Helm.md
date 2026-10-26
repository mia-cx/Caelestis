---
title: Kubernetes with Helm
---

The chart runs the backend and frontend in one Pod. It creates a Service, an optional Ingress, and an optional persistent volume claim.

You supply the database, object bucket, credentials, and TLS configuration.

## Get the chart

You need an existing Kubernetes cluster, kubectl, and Helm. These commands do not create a cluster.

~~~sh
git clone https://github.com/mia-cx/Caelestis.git
cd Caelestis
kubectl create namespace caelestis
~~~

Skip namespace creation if it already exists. Keep Secrets and the Helm release in the same namespace.

## Choose storage

| Setup | Starting configuration |
| --- | --- |
| SQLite and filesystem | [Default values](https://github.com/mia-cx/Caelestis/blob/main/deploy/helm/caelestis/values.yaml), with persistence enabled |
| CNPG and S3 | [CNPG example](https://github.com/mia-cx/Caelestis/blob/main/deploy/helm/cnpg-s3.example.yaml) |
| MariaDB and S3 | [MariaDB example](https://github.com/mia-cx/Caelestis/blob/main/deploy/helm/mariadb-s3.example.yaml) |

Copy the appropriate file to `my-values.yaml`. Replace its example hostnames, bucket, Secret names, and public origin.

For the default SQLite/filesystem stack:

~~~sh
cp deploy/helm/caelestis/values.yaml my-values.yaml
~~~

For CNPG, use the writable-primary service. For SQLite, use local or block-backed storage with POSIX locks.

## Create the Secrets

Create these in the same namespace as Caelestis, using your usual secret-management process:

| Secret referenced by | Keys |
| --- | --- |
| `server.existingSecret` | `ADMIN_TOKEN`, `CAELESTIS_READ_TOKEN`, with different private values |
| `database.existingSecret` | `username`, `password`, `dbname`, unless you changed `database.secretKeys` |
| `database.tls.existingSecret` | `ca.crt`, unless you changed `database.tls.caKey` |
| `storage.s3.existingSecret` | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, optionally `AWS_SESSION_TOKEN` |

Database and S3 Secrets apply only to those storage choices. The database user needs permission to create and migrate application tables.

Keep secret values out of the values file.

For a new default stack, create the server Secret from a private file:

~~~sh
umask 077
printf 'ADMIN_TOKEN=%s\nCAELESTIS_READ_TOKEN=%s\n' \
  "$(openssl rand -hex 32)" "$(openssl rand -hex 32)" > server-secrets.env
kubectl -n caelestis create secret generic caelestis-server --from-env-file=server-secrets.env
~~~

Store that file securely and exclude it from Git. It contains the administrator credential you need to connect the userscript.

## Configure the chart

| Value | Set it to |
| --- | --- |
| `server.name` | Your server's display name |
| `server.season` | The Wplace canvas season |
| `server.origin` | Public dashboard origin, such as `https://caelestis.example.com` |
| `database.adapter` | `sqlite`, `postgres`, or `mariadb` |
| `database.host` | The writable database primary, for PostgreSQL or MariaDB |
| `database.tls.mode` | `verify-full` for a remote database |
| `storage.adapter` | `filesystem` or `s3` |
| `persistence.enabled` | `true` for SQLite or filesystem objects |
| `ingress` | Your ingress class, hostname, and existing TLS Secret |

For PostgreSQL or MariaDB with S3, you can disable the application PVC.

## Install from a checkout

Set `image` and `frontend.image` in your values file to a matching [release pair](Container-images). For a local build, publish both images to a registry your cluster can reach.

For a digest reference such as `miacx/caelestis-backend@sha256:...`, put the part before `@` in `repository` and the rest in `digest`:

~~~yaml
image:
  repository: miacx/caelestis-backend
  digest: sha256:REPLACE_WITH_BACKEND_DIGEST
frontend:
  image:
    repository: miacx/caelestis-frontend
    digest: sha256:REPLACE_WITH_FRONTEND_DIGEST
~~~

Replace both placeholders with values from the same release. For tagged images, set `tag` instead of `digest`.

Then run:

~~~sh
helm lint deploy/helm/caelestis -f my-values.yaml
helm upgrade --install caelestis deploy/helm/caelestis \
  --namespace caelestis --create-namespace \
  -f my-values.yaml --wait --timeout 10m
kubectl -n caelestis get pods,services
~~~

Ingress is disabled by default. For a local check, forward the Service:

~~~sh
kubectl -n caelestis port-forward service/caelestis-caelestis 3000:80
~~~

Open `http://localhost:3000` while that command runs. For public access, set `ingress.enabled: true`, configure its host and TLS, and use that HTTPS URL.

Before adding artwork, the dashboard shows an empty library.

![A new dashboard with no templates.](images/dashboard/empty-server.png)

## Operation

Keep `replicaCount: 1`. The chart uses `Recreate` updates so the old backend releases database ownership before its replacement starts.

An ingress must forward WebSocket upgrades and permit long-lived connections. The frontend is available to visitors who can reach it; add access control if it should be private.

For upgrades and rollback, follow [Deployment and upgrades](Deployment-and-upgrades). A Helm rollback does not reverse database migrations.
