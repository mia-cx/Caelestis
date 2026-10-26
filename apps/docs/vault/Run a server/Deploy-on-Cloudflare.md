---
title: Deploy on Cloudflare
---

This guide deploys two Workers in your Cloudflare account: the backend and the dashboard. The backend uses D1, R2, and Durable Objects.

Use the self-hosted configuration examples. The normal `wrangler.toml` files contain the project's own deployment settings.

## Requirements

You need a Cloudflare account with Workers, D1, R2, and Analytics Engine available, plus Git, Node.js, and pnpm. Use the Node version in the repository's `Dockerfile` and the pnpm version in `package.json`.

A fork is useful if you plan to maintain code changes. It is not required for manual deployment.

## 1. Download and build

~~~sh
git clone https://github.com/mia-cx/Caelestis.git
cd Caelestis
corepack enable
pnpm install --frozen-lockfile
pnpm build
~~~

Run the remaining commands from the repository root. Cloudflare is the default frontend build target; do not set `CAELESTIS_TARGET=node` for this build.

## 2. Sign in and create storage

~~~sh
pnpm --dir apps/backend exec wrangler login
~~~

Complete the authorization in your browser for the account that will own this server.

Choose your own resource names. The examples below use `my-caelestis`:

~~~sh
pnpm --dir apps/backend exec wrangler d1 create my-caelestis
pnpm --dir apps/backend exec wrangler r2 bucket create my-caelestis-blobs
~~~

Save the D1 `database_id` printed by the first command.

## 3. Configure both Workers

~~~sh
cp apps/backend/wrangler.self-hosted.example.toml apps/backend/wrangler.self-hosted.toml
cp apps/frontend/wrangler.self-hosted.example.toml apps/frontend/wrangler.self-hosted.toml
npx --yes uuid@latest v7
~~~

Use the generated UUID for `SERVER_ID`.

Edit `apps/backend/wrangler.self-hosted.toml`:

| Field | Example or value |
| --- | --- |
| `name` | `my-caelestis-backend` |
| R2 `bucket_name` | `my-caelestis-blobs` |
| D1 `database_name` | `my-caelestis` |
| D1 `database_id` | The ID returned when you created the database. |
| Analytics Engine `dataset` | A name for this server, such as `my_caelestis_metrics`. |
| `vars.SERVER_ID` | Your generated UUIDv7. |
| `vars.SERVER_NAME` | The display name for your server. |
| `vars.SEASON` | The Wplace canvas season you use. |

Keep the Durable Object bindings and migration declarations from the example.

Edit `apps/frontend/wrangler.self-hosted.toml`:

| Field | Value |
| --- | --- |
| `name` | `my-caelestis-frontend` |
| Service binding `service` | Your backend Worker name, here `my-caelestis-backend`. |
| R2 `bucket_name` | The same bucket as the backend. |

Keep `workers_dev = true` to use Cloudflare's generated URLs without a custom domain.

## 4. Deploy the backend

Generate and securely save an administrator token:

~~~sh
openssl rand -hex 32
~~~

Store it as a Worker secret. Paste it at Wrangler's prompt, not into the configuration file:

~~~sh
pnpm --dir apps/backend exec wrangler secret put ADMIN_TOKEN --config wrangler.self-hosted.toml
~~~

If Wrangler asks to create the Worker, use the name from your self-hosted configuration.

Apply the database migrations, then deploy:

~~~sh
pnpm --dir apps/backend exec wrangler d1 migrations apply DB --remote --config wrangler.self-hosted.toml
pnpm --dir apps/backend exec wrangler deploy --config wrangler.self-hosted.toml
~~~

Save the backend's `workers.dev` URL.

## 5. Create the dashboard token

In the [userscript](Install-the-userscript), open **Settings** and add the backend's `workers.dev` address.

![An example backend Worker address beside Add. Use the URL Wrangler printed for your Worker.](images/settings/connection-add-worker-address.png)

Connect with the administrator token you just created. In that server's **Access tokens**, enter `Dashboard`, select **Read**, and click **Create**.

![Token creation with Dashboard entered as the label and Read selected.](images/settings/create-read-token.png)

Copy the new token when it appears. You cannot retrieve its value later.

![The one-time token result and Copy control. The token value is concealed.](images/settings/copy-new-token.png)

## 6. Deploy the dashboard

Store the new read token in the frontend Worker:

~~~sh
pnpm --dir apps/frontend exec wrangler secret put CAELESTIS_READ_TOKEN --config wrangler.self-hosted.toml
pnpm --dir apps/frontend exec wrangler deploy --config wrangler.self-hosted.toml
~~~

Open the frontend URL printed by Wrangler. A new server has no templates yet.

![The dashboard's initial No templates yet state.](images/dashboard/empty-server.png)

The frontend reads the backend through its Worker service binding. The read token stays on the server; dashboard visitors do not enter it.

## Connect painters

Create a **Report** token for each painter through [Access tokens](Authentication-and-tokens#create-a-token). Give them the backend URL and their token.

They can then follow [Connect to a server](Connect-to-a-server). Keep the administrator token for administration, not everyday painting.

For a private dashboard, restrict access to the frontend with your own access-control layer.
