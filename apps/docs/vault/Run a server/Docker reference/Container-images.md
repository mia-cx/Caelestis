---
title: Container images
---

Download the backend and frontend image references from the same server release.

## Images and architectures

| Image | Docker Hub | GHCR |
| --- | --- | --- |
| Backend | `miacx/caelestis-backend` | `ghcr.io/mia-cx/caelestis-backend` |
| Frontend | `miacx/caelestis-frontend` | `ghcr.io/mia-cx/caelestis-frontend` |

The release workflow builds `linux/amd64` and `linux/arm64`. The paired backend image uses Bun. Choose the release's Node backend image reference if you need Node. Use the same frontend with either runtime.

## Find a release pair

Open [GitHub releases](https://github.com/mia-cx/Caelestis/releases) and look for a release titled **Caelestis server** followed by the version pair.

The `*-dockerhub-image.txt` and `*-ghcr-image.txt` assets contain immutable image references. Use both references from one release and registry. If no server release is available, [build with Docker](Run-with-Docker).

Pair tags include both app versions, such as `backend-1.2.3-frontend-4.5.6`. That is a format example, not a version to copy.

## Use the images

Copy both image references into `.env`.

~~~dotenv
CAELESTIS_BACKEND_IMAGE=replace-with-the-backend-image-reference
CAELESTIS_FRONTEND_IMAGE=replace-with-the-frontend-image-reference
~~~

Pull and start the pair with your usual Compose file list.

~~~sh
docker compose pull
docker compose up -d --no-build --wait
~~~

The `--no-build` flag uses the configured images instead of building the checkout. Include your database and storage overlays as described in [Docker Compose stacks](Docker-Compose-stacks).

## Container settings

| Setting | Value |
| --- | --- |
| Application UID/GID | `1000:1000` |
| Listener port | `3000` in each Compose container |
| Backend persistent directory | `/data` |
| Shared filesystem objects | `/objects` |
| Health endpoints | `/health/live` and `/health/ready` |

Before changing versions, follow [Deployment and upgrades](Deployment-and-upgrades).
