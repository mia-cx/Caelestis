# Notification settings

Keep notification choices in one section between Painting and Contribution. Reuse the existing
section header, setting rows, and native checkbox toggles at the panel's current density.
Each category has an independent switch. The section states that delivery stays inside Wplace;
the action-feedback hint explains that errors and warnings remain visible.

The colour-order select uses DaisyUI select geometry and a themed native picker. Its label and
control wrap onto separate lines in narrow panels, so both full option labels remain readable.
Use the shared menu styling described in ../foundations/MENUS.md.

# Keyboard shortcuts

One section between Contribution and Diagnostics lists every rebindable action under Painting and
Overlay headings, in the order the shortcut reference uses. Each row is the action name, a key
control showing the current chord as `kbd` (or "Not set"), and a clear button that keeps its space
while hidden. Selecting the key control starts recording: it shows "Press a key…", carries the
shared key-capture attribute so the userscript fires no shortcut, and Escape cancels. A bare
modifier waits for the rest of the chord. The section header holds one Reset action, enabled only
while any binding differs from its default. One status line under the list names the action that
lost a key when a chord moved.

A Simulated clicks switch sits above the list. Colour cycling and committing a paint draft press
Wplace's own swatches and Paint button, which Wplace flags on the account, so they wait for it.
While it is off, those rows carry a note naming the switch, and the shortcut reference says the same.

# Global settings

`GlobalSettings.svelte` holds the sections that apply to every Wplace tab: Notifications,
Contribution, Painters, Wplace performance, Diagnostics, and Accessibility. The Settings view places
each between its own sections; the extension's toolbar popup (`caelestis-extension-settings`) shows
them in that order under a version line, with the same rows and copy. Accessibility appears only in
the popup, because on the page those switches live in Wplace's own Accessibility settings. The
Userscript updates row is absent wherever the model leaves `notifyUpdates` out, as the extension does.
