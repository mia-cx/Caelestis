---
'@caelestis/backend': patch
---

Broadcast alarm and status changes to live subscribers with one database read and one encoding per scope, and stop cloning each socket's attachment on every read in the Node live host.
