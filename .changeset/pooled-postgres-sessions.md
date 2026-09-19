---
'@caelestis/backend': patch
---

Run PostgreSQL and CNPG application queries on the connection pool instead of one owned session, fenced by advisory locks so there is still exactly one writer at a time: a replacement owner cannot serve until every session of the previous owner has closed, and a lost owner session ends its pool at once. Transactions on the tile tables take turns in one lane so they never abort each other; other transactions overlap, and a serialization failure is retried before a command is answered as unavailable.
