---
"@caelestis/backend": patch
---

A paint report larger than the live transport's 8 MiB limit is refused with a 400 before the server reads all of it, as tile offers and uploads already were.
