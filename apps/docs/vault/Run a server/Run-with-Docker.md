---
title: Run with Docker
---

This setup runs the backend and dashboard on one machine. It uses SQLite for records and Docker volumes for artwork and tile history.

The commands below build from source. You do not need a GitHub fork unless you want to keep your own code changes.

## Requirements

Install Git and [Docker with the Compose plugin](https://docs.docker.com/compose/install/). On macOS or Windows, start Docker Desktop before continuing.

Check that both commands work:

~~~sh
git --version
docker compose version
~~~

## 1. Download Caelestis

~~~sh
git clone https://github.com/mia-cx/Caelestis.git
cd Caelestis
cp .env.example .env
~~~

Run the remaining commands from this directory.

## 2. Configure the server

Open `.env` in a text editor. Set these values:

| Variable | Value |
| --- | --- |
| `ADMIN_TOKEN` | A new private token for administrator access. |
| `CAELESTIS_READ_TOKEN` | A different private token for the dashboard. |
| `SERVER_NAME` | The name people should see. |
| `SEASON` | The Wplace season whose canvas you are using. |

Generate each token separately:

~~~sh
openssl rand -hex 32
openssl rand -hex 32
~~~

Copy the first result into `ADMIN_TOKEN` and the second into `CAELESTIS_READ_TOKEN`. Keep `.env` out of Git.

On first startup, the backend registers the dashboard token as read-only. Do not give the frontend your administrator token.

## 3. Start the containers

~~~sh
docker compose up --build -d --wait
docker compose ps
~~~

Both `backend` and `frontend` should be running and healthy. If either fails, inspect its logs:

~~~sh
docker compose logs --tail=100 backend frontend
~~~

## 4. Open the dashboard

Open [http://localhost:3000](http://localhost:3000) on the same machine. A new server shows **No templates yet**.

![A new Caelestis dashboard showing No templates yet.](images/dashboard/empty-server.png)

Upload artwork through an administrator connection in the userscript. Published templates then appear on the dashboard.

## Optional: connect the userscript

Open **Settings** in Caelestis on Wplace.

![The Settings gear in the Caelestis panel.](images/settings/connection-open-settings.png)

Enter `http://localhost:3000` and click **Add**. For a server on another machine, use its public HTTPS address instead.

![The local server address beside the Add button.](images/settings/connection-add-local-address.png)

Expand the server if needed. Paste a token from this server and click **Connect**. Use your administrator token for setup; create **report** tokens for painters afterward.

![The token field and Connect button. The masked value is an example.](images/settings/connection-enter-token.png)

See [Authentication and tokens](Authentication-and-tokens) for creating those tokens.

## Ports and volumes

| Setting | Default |
| --- | --- |
| Host address | `127.0.0.1`, accessible only from this machine |
| Host port | `3000`, set by `CAELESTIS_HTTP_PORT` |
| `data` volume | Backend database and local state, mounted at `/data` |
| `objects` volume | Artwork and tile objects, mounted at `/objects` in both containers |

The images run as UID/GID `1000`. If you replace named volumes with host directories, make them writable by that user.

## Stop or update

~~~sh
docker compose down
~~~

This keeps the data volumes. Adding `--volumes` deletes them.

For updates, follow [Deployment and upgrades](Deployment-and-upgrades). For another database or S3 storage, choose a [Docker Compose stack](Docker-Compose-stacks).
