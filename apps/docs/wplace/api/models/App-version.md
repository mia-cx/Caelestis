---
title: App version
description: The build version of the wplace.live web app, which the client polls to prompt a reload.
model:
  name: App-version
  schema:
    type: object
    properties:
      version:
        type: string
        example: "1795680000000"
      playerVersion:
        type: string
        example: 1.0.0
---

Returned by [[Get-app-version]].
