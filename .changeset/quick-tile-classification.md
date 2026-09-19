---
'@caelestis/backend': patch
---

Reply to tile uploads and paint reports faster at high user counts by sharing one classification per canvas and template chunk across reporters, classifying with typed-array kernels, and storing each canvas hash's bytes once even when many reporters upload it at the same time.
