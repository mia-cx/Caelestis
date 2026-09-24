---
'@caelestis/userscript': patch
---

Stop Wplace's map from redrawing every frame while it sits still, cutting idle CPU and GPU use.

- Pause Wplace's event-marker animations while the marker is hidden.
- Switch any Wplace patch off from the console with `__caelestis.wplacePatches.disable(name)`.
