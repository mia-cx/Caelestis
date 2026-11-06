---
'@caelestis/backend': patch
---

`/telemetry/status` sends an `ETag` and answers a matching `If-None-Match` with 304.
