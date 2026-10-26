---
title: Authentication and tokens
---

A token grants access to one Caelestis server. The server owner decides who receives one.

## Token scopes

| Scope | Allows |
| --- | --- |
| **Read** | Published templates, progress, and other read-only server data. |
| **Report** | Read access, painting and tile reports, presence, favourites, and the painter's own claims. |
| **Admin** | Report access, template administration, unpublished data, and token management. |

Use **Report** for painters. Use **Read** for the dashboard's backend connection. Use **Admin** only for people who manage the server.

## Create a token

Connect the userscript with an administrator token, then open **Settings** and expand the server. Its **Access tokens** controls appear below the connection.

Enter a label that identifies the person or service. Choose a scope and click **Create**. This example creates a read token for a dashboard.

![Dashboard entered as the token label, with Read selected and Create visible.](images/settings/create-read-token.png)

Copy the new token and give it to its intended recipient through a private channel. The server does not show this value again.

![The newly created token and its Copy control. The value is concealed in this screenshot.](images/settings/copy-new-token.png)

The recipient enters it in their server connection. See [Connect to a server](Connect-to-a-server).

## Revoke a token

In **Access tokens**, find the token by its label. Click the **×** beside it, then confirm **Delete**. The token stops granting access. Existing historical reports remain part of the server's records.

![The delete control beside a token, outlined in orange.](images/settings/revoke-token.png)

If you lose a token's value, revoke it and create a replacement.

## Bootstrap administrator token

`ADMIN_TOKEN` is set in the backend environment or Worker secrets. It lets the owner administer a new server before other tokens exist.

This token is managed through the deployment, not the token list. Change or remove it in the environment when you need to rotate it.

## Dashboard read token

`CAELESTIS_READ_TOKEN` is the frontend's private backend credential. It stays on the server; it is not a dashboard visitor login.

In Docker, the backend registers the configured read token on first startup. For Cloudflare, create a **Read** token and store it in the frontend Worker.

Use a different value from `ADMIN_TOKEN`. A revoked token remains revoked; replace it with an active read token.

Anyone who can reach the dashboard can view what it serves. Protect the frontend separately if you want a private site.

## Open access

`OPEN_ACCESS=true` allows anonymous backend reads of published work. It does not allow anonymous painting reports or administration.

Keep tokens out of Git, screenshots, and logs. Report a suspected leak through the [security policy](https://github.com/mia-cx/Caelestis/security/policy).
