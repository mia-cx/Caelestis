---
'@caelestis/backend': patch
---

Write derived mismatch masks after the live reply through a bounded background writer that drains on shutdown, so slow object storage no longer delays tile acknowledgements.
