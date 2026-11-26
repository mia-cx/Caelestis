---
title: Sign in
description: Start signing in with Google, Apple or Twitch, which sets the `j` cookie.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /auth/{provider}
  client: browser
  auth: none
  parameters:
    - name: provider
      in: path
      required: true
      type: string
      example: google
      description: "Seen: `google`, `apple`, `twitch`."
  responses:
    "302":
      description: On to the provider's sign-in page.
      empty: true
---

**Pawtect:** No token and no flag: the client doesn't read this response through its API client. Any absolute URL fetched through the page's `window.fetch` goes into the next token's URL log.

Called by the wplace.live client. Checked on 26 November 2026. **Unverified:** not called live.

The sign-in buttons submit a form to this URL, so the browser leaves wplace.live. After the provider returns, the backend sets the `j` session cookie on `.wplace.live`. Twitch sign-in is offered only to migrate older accounts. **Unverified:** the redirect; it was not followed.

Counts toward the API [[Rate-limits|rate limit]].

Related: [[Sign-out]].
