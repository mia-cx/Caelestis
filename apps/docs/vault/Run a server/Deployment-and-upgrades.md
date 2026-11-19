---
title: Deployment and upgrades
---

Update the backend and frontend together. Use the image references from one server release, or build both from the same checkout.

## Before an update

Stop application writes and take a matching database-and-object backup. Save the current image references or source commit with it.

[Storage and backups](Storage-and-backups) explains what each stack needs.

## Docker from source

In the checkout, stop the applications. Add the `-f` files your stack uses, such as a database or S3 overlay, to every `docker compose` command below. Without them, the applications restart with the default stores.

~~~sh
docker compose stop backend frontend
~~~

Take the backup, then update to the source version you intend to run. Build and start both applications from that version.

~~~sh
docker compose up --build -d --wait
docker compose ps
docker compose logs --tail=100 backend frontend
~~~

Do not change database or object-storage adapters as part of a normal version update.

## Docker with release images

After the backup, put the target release's image references in `.env`. Pull that pair and start the stack.

~~~sh
docker compose pull
docker compose up -d --no-build --wait
docker compose ps
~~~

Keep any database and S3 overlays in the file list. See [Container images](Container-images) for finding the references.

The backend acquires ownership and applies migrations before accepting traffic.

## Helm

Update `my-values.yaml` with the target image pair. Run the migration Job first, then start the backend with the same chart values.

~~~sh
helm upgrade caelestis deploy/helm/caelestis \
  --namespace caelestis -f my-values.yaml \
  --set replicaCount=0,migration.enabled=true \
  --wait --wait-for-jobs --timeout 15m

helm upgrade caelestis deploy/helm/caelestis \
  --namespace caelestis -f my-values.yaml \
  --set replicaCount=1,migration.enabled=false \
  --wait --timeout 10m
~~~

Use the same chart version, namespace, values, storage, and Secrets in both commands. For a published chart, replace the local path with its pinned chart reference.

## Cloudflare

Keep your self-hosted configuration and secrets. Build the target release, apply backend D1 migrations, and deploy the backend before the frontend.

~~~sh
pnpm install --frozen-lockfile
pnpm build
pnpm --dir apps/backend exec wrangler d1 migrations apply DB --remote --config wrangler.self-hosted.toml
pnpm --dir apps/backend exec wrangler deploy --config wrangler.self-hosted.toml
pnpm --dir apps/frontend exec wrangler deploy --config wrangler.self-hosted.toml
~~~

Review release-specific migration instructions before running these commands. A Worker rollback does not restore D1 or R2 data.

## Check the result

Open the dashboard and a known template. Confirm its artwork and progress load. Open the connected server in the Wplace panel and check that shared updates arrive.

On Docker, check the readiness endpoint.

~~~sh
curl --fail http://localhost:3000/health/ready
~~~

Use your configured port if it differs.

## Rollback

Restore the matching backup if a migration prevents the previous version from starting.

Stop the application, restore the pre-update database and matching objects, then start the previous version. A Helm rollback alone does not restore the database.
