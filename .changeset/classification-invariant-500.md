---
"@caelestis/backend": patch
---

A tile upload that fails because a template's stored artwork disagrees with its own bounds is answered as a server error, as a tile offer already was, instead of blaming the reporter with a 400.
