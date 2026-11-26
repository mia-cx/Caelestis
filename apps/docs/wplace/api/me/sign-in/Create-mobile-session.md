---
title: Finish an iOS app sign-in
description: The form the iOS app posts after a sign-in redirect, to exchange the one-time code for a session.
tags:
  - source/client
  - pawtect/none
operation:
  protocol: rest
  method: POST
  path: /auth/mobile-session
  client: browser
  auth: none
  requestBody:
    contentType: application/x-www-form-urlencoded
    example:
      code: <one-time code>
      device_token: <device token>
      device_key_id: <key id>
      device_assertion: <app attest assertion>
  responses:
    "200":
      description: The server's answer. Not observed.
---

**Pawtect:** No token and no flag: this is a form submission, not a `fetch`.

Called by the wplace.live client, but only inside the iOS app. Checked on 26 November 2026. **Unverified:** read from the client code; the guide makes no sign-in requests.

The iOS app starts sign-in with `mobile=1` and a random `app_state` on [[Sign-in]]. When the provider redirects back into the app with a `code` and the same state, the app builds a hidden form and posts it here. `device_token`, `device_key_id` and `device_assertion` come from Apple's device checks when available. **Unverified:** the response, since the page navigates away.

Related: [[Sign-in]].
