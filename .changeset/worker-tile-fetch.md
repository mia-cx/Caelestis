---
"@caelestis/backend": patch
---

Servers on Cloudflare Workers take their own canvas snapshots and alarm follow-up checks again, instead of failing every Wplace tile request with "Illegal invocation".
