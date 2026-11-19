---
"@caelestis/backend": patch
---

A self-hosted server started with `PORT=0` renders share images through the port it actually bound, instead of failing to reach port 0 when the job was already due at startup.
