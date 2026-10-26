---
title: Troubleshooting
---

## The Caelestis button is missing

Check that your userscript manager lists Caelestis and that it is enabled. Reload [Wplace](https://wplace.live) after installing or updating.

On Chromium browsers, check whether your manager requires **Allow User Scripts** or extension developer mode. Follow the manager's browser-specific instructions in [Install the userscript](Install-the-userscript).

## A server will not connect

Check the address in **Settings → Servers**. A normal site address gets `/backend` added automatically. If the owner supplied a complete endpoint, use that.

A **token** status means the server needs a valid credential. Ask its owner for a token, paste it into the expanded connection, and click **Connect**.

![The token field and Connect button for a server requiring authentication.](images/settings/connection-enter-token.png)

Use **Report** or **Admin** for painting reports, presence, and claims. **Read** only grants read access.

For a remote server, use HTTPS. The proxy must forward WebSocket upgrades. If HTTP data loads but live updates fail, ask the owner to check that proxy configuration.

## The dashboard says it cannot reach the server

The owner should check the frontend's backend address or Worker binding and `CAELESTIS_READ_TOKEN`. A missing or revoked read token prevents backend reads.

Docker owners can check:

~~~sh
docker compose ps
docker compose logs --tail=100 backend frontend
curl --fail http://localhost:3000/health/ready
~~~

Use the stack's normal Compose files and configured host port.

## Progress looks stale

The server learns about canvas changes through tile observations and painting reports. A change can appear on Wplace before the server records it.

For shared work, check **Report my activity** and **Share tiles** in Settings. Also check that your token allows reporting.

A coverage gap means some pixels have not been observed. It is not evidence that the artwork is complete.

## Painters or claims are missing

On the sending tab, check **Share where I am**. On the receiving tab, check **Show other painters** and the separate viewport and claim switches.

The Painters drawer lists people near your viewport. Its online total can include people elsewhere on the same server.

Creating claims requires a Wplace login, a server with painter presence, and a report or administrator token. Claims expire after 30 days without renewal from an authenticated owner connection.

## A container fails to start

Read its logs before changing configuration.

| Error area | Check |
| --- | --- |
| Database ownership | Only one active backend uses this database. |
| PostgreSQL or MariaDB connection | The host is reachable and writable; credentials and TLS settings match. |
| PostgreSQL pooling | Use a direct connection or session pooling, not transaction pooling. |
| SQLite lock or permissions | Storage supports POSIX locks and is writable by UID/GID 1000. |
| Object storage | The bucket exists and credentials permit the required operations. |
| Migration checksum or incomplete migration | Preserve the error and backup. Do not edit migration files to bypass it. |

See the appropriate [stack guide](Docker-Compose-stacks) for its parameters.

## An upgrade failed

If migrations changed the database, an older image alone may not recover it. Follow the [rollback procedure](Deployment-and-upgrades#rollback) using matching database and object backups.

## Report a bug

[Open a bug report](https://github.com/mia-cx/Caelestis/issues/new/choose) with the version, browser, steps, expected result, and actual result.

For userscript problems, enable **Settings → Diagnostics → Debug logging**, reproduce the issue, and collect the relevant console output.

![The Debug logging switch.](images/settings/diagnostics.png)

Remove tokens and private data before posting. A focused screenshot or short recording helps when the problem is visual.
