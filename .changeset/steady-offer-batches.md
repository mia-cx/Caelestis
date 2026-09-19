---
'@caelestis/backend': patch
---

Answer multi-tile offer batches sooner by processing their tiles concurrently, and fold a tile's history on its first observation and then at most every 30 seconds instead of on every reply.
