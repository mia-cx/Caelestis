---
"@caelestis/backend": patch
---

A write that lands as an archive or restore begins now gets the same 503 with `retry-after` as every other request during the operation, instead of a 500.
