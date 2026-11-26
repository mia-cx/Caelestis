---
title: Reorder favourite places
description: Save the order and folders of the signed-in player's favourites.
tags:
  - source/client
  - pawtect/flag
operation:
  protocol: rest
  method: POST
  path: /favorite-location/organize
  auth:
    scheme: session cookie
    description: The `j` cookie of a signed-in player.
  parameters:
    - name: j
      in: cookie
      required: true
      type: string
      example: <session-cookie>
      description: Wplace session cookie, set when the player signs in.
  requestBody:
    example:
      action: order
      ids: [3, 1, 2]
  responses:
    "200":
      description: Saved.
    "401":
      description: No session, or an expired one.
      schema:
        $ref: Error
---

**Pawtect:** No token. The client reads this response through its API client, so patching its `json` or `text` sets "Tampered response" ([[Anti-cheat]]). Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** read from the client code, since the guide makes no signed-in requests.

The body is one action, named by `action`:

- `order` or `folder-order`: the new order as `ids`, with `id` and `folderId` when a favourite moves into a folder.
- `folder`: create or update a folder, with its `id`, `name`, `hidden`, `collapsed` and `position`. `id: 0` creates one, and `locationId` puts a favourite in it.
- `delete-folder`: the folder's `id`.
- `pins`: `hidden`, to show or hide favourite pins on the map.

**Unverified:** which fields the server requires.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Error]].
