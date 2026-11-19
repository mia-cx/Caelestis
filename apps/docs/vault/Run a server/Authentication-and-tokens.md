---
title: Authentication and tokens
---

Create separate credentials for painters, dashboard readers and administrators. Each token grants access to one server.

## Token scopes

| Scope | Allows |
| --- | --- |
| **Read** | Published templates, progress, and other read-only server data. |
| **Report** | Read access, painting and tile reports, presence, favourites, and the painter's own claims. |
| **Admin** | Report access, template administration, unpublished data, and token management. |

Use **Report** for painters. Use **Read** for the dashboard's backend connection. Use **Admin** only for people who manage the server.

## Create a token

1. [Connect Caelestis](Connect-to-a-server) with your administrator token.
2. In **Settings**, expand the server and find **Access tokens**.
3. Enter a label for the person or service, choose a scope and click **Create**.

![Dashboard entered as the token label, with Read selected and Create visible.](images/settings/create-read-token.png)

![The Access tokens list for a server, with each token's label, scope and creation date, and the form for a new token.](images/settings/access-tokens.png)

In **Access token created**, choose **Copy token** or **Copy invite link** before closing the dialog. Send the value privately. Opening the invite connects Caelestis to the server on Wplace. For the dashboard's backend credential, copy the token itself.

![Access token created for Madeline, with masked token and invite link values beside Copy token and Copy invite link.](images/settings/token-created.png)

## Revoke a token

In **Access tokens**, find the token by its label. Use the delete button beside its label, then confirm **Delete**. The token stops granting access. Existing historical reports remain part of the server's records.

![The delete control beside a token, outlined in orange.](images/settings/revoke-token.png)

If you lose a token's value, revoke it and create a replacement.

## Bootstrap administrator token

Set `ADMIN_TOKEN` in the backend environment or Worker secrets to administer the server before issuing tokens.

This token is managed through the deployment, not the token list. Change or remove it in the environment when you need to rotate it.

## Dashboard read token

`CAELESTIS_READ_TOKEN` is the frontend's private backend credential. The frontend uses it to fetch data for its visitors.

In Docker, the backend registers the configured read token on first startup. For Cloudflare, create a **Read** token and store it in the frontend Worker.

Use a different value from `ADMIN_TOKEN`. The backend refuses to start while `CAELESTIS_READ_TOKEN` names a revoked token. To rotate it, create a new **Read** token and set `CAELESTIS_READ_TOKEN` to its value. In Docker, both applications read it from `.env`, so recreate both with `docker compose up -d`, adding any `-f` overlays your stack uses. Revoke the old token only after the dashboard loads with the new one. If the backend already stopped on a revoked token, set `CAELESTIS_READ_TOKEN` to another active **Read** token and recreate both.

Anyone who can reach the dashboard can view what it serves. Protect the frontend separately if you want a private site.

## Open access

`OPEN_ACCESS=true` allows anonymous backend reads of published work. It does not allow anonymous painting reports or administration.

Keep tokens out of Git, screenshots, and logs. Report a suspected leak through the [security policy](https://github.com/mia-cx/Caelestis/security/policy).
