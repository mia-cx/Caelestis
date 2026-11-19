---
"@caelestis/backend": patch
---

Presence rooms check the state stored on live connections that outlast a deploy, as live sync already did, and refuse a malformed one instead of acting on it.
