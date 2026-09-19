---
'@caelestis/backend': patch
---

Let pooled PostgreSQL transactions on the tile tables take turns in one lane and the coordinator's callbacks in another while other transactions overlap, retry a serialization failure before answering a command as unavailable, verify the owner session from every fenced session, and report lane wait and retries in the ingest-timings snapshot.
