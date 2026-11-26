---
title: Health
description: The backend health check body.
model:
  name: Health
  schema:
    type: object
    properties:
      up:
        type: boolean
        example: true
---

Returned by [[Get-health]].
