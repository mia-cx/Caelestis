---
"@caelestis/backend": patch
---

On MariaDB, counter and server-state transactions that lose a deadlock or time out on a lock now run again, as they already did on PostgreSQL, instead of failing on the first try.
