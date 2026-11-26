---
"@caelestis/backend": patch
"@caelestis/frontend": patch
---

Folder and artwork progress graphs load faster: the backend caches progress and archive history queries and avoids full tile-history scans, and the dashboard fetches templates and resolution tiers concurrently.
