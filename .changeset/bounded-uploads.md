---
"@caelestis/backend": patch
---

Server asset uploads and archive restores without a `Content-Length` are refused once they pass the size limit instead of being read in full, and the restore limit message names 64 MiB.
