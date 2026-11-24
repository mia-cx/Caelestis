---
"@caelestis/backend": patch
---

On MariaDB 11.6 and later, a write that collides with another server request's just-committed change is retried instead of failing with "Record has changed since last read".
