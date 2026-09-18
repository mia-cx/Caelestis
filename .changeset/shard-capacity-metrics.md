---
'@caelestis/backend': minor
---

Expose per-pod capacity on `/metrics`: connected users counted once across channels and tabs, occupied live-sync and presence slots, per-coordinator saturation, admission and rejection counters, pending live work, and event-loop lag. The Helm chart can opt into a `PodMonitor` that scrapes every pod directly.
