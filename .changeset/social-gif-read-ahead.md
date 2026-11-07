---
'@caelestis/backend': patch
'@caelestis/frontend': patch
---

Template share GIFs render about three times faster: tile, history and map reads now overlap decoding instead of waiting one at a time.
