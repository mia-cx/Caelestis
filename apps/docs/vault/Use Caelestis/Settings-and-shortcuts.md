---
title: Settings and shortcuts
---

Click the gear in the Caelestis panel header to open **Settings**. The extension's moon in the browser toolbar also opens global settings. Changes there apply to open Wplace tabs.

![The Settings gear in the panel header.](images/settings/connection-open-settings.png)

## Servers

Each server has an address and can have its own access token. Expand its entry to see the backend version. Its status tells you whether it is connected, needs a token, or cannot be reached.

![Two connected servers listed under the address field, each with its backend version.](images/settings/server-connection.png)

[Connect to a server](Connect-to-a-server) walks through adding an address and token. **Disconnect** removes this browser's connection.

An administrator connection also shows [access-token management](Authentication-and-tokens#create-a-token). For details on what each connection sends, read the [privacy policy](Privacy).

## Painting

**Middle-click colour order** chooses whether colour navigation visits unpainted or mismatched pixels first. It uses the template under the viewport centre, or the nearest template when the centre is empty.

Hold Shift with Space to paint unfinished pixels of the selected colour. The brush waits at a skipped pixel until the path from there is clear.

## Notifications

These switches control toast messages inside Wplace.

| Setting | Messages |
| --- | --- |
| Template regressions | A template loses progress. |
| Sustained griefing | Damage continues over time. |
| Userscript updates | The userscript found an update on GitHub. The extension receives updates through its store. |
| Action feedback | Routine progress and success messages. Errors and action warnings still appear. |

## Sharing and painters

| Setting | Effect |
| --- | --- |
| Report my activity | Sends paint reports to servers with templates on the painted tile. Reports can include pixels outside the artwork. |
| Share tiles | Sends the whole fetched tile to servers with templates on it. |
| Share where I am | Shares your viewport and paint drafts while this tab is open. |
| Show other painters | Shows or hides painters and claims on your map. |
| Show painters' viewports | Shows where painters are looking and what they have drafted. |
| Show region claims | Shows saved claim regions. Your own claim fill steps aside under the pointer. |
| Claims only while painting | Shows claims only while Wplace's paint drawer is open. |

![The separate contribution, presence, viewport, and claim switches.](images/settings/sharing.png)

Turning off **Show other painters** changes what you see. Turn off **Share where I am** to stop sharing your own viewport and drafts.

## Keyboard shortcuts

Press `Shift+/` to open the keyboard reference. It lists the bindings currently assigned, including any you changed.

![The current keyboard bindings in the reference window.](images/settings/shortcut-reference.png)

To rebind an action, open **Settings → Keyboard shortcuts** and click its key control. Press the key or combination you want. Press Escape to cancel.

Assigning a key already in use removes its previous assignment. **Reset** restores the default bindings.

![Shortcut rows with their key controls, with the previous and next unfinished colour bindings greyed out.](images/settings/rebinding.png)

## Wplace appearance and performance

In Wplace's accessibility settings, **FalseType font** changes the font and **Caelestis cursors** changes the pointer artwork. Both switches also appear in the extension popup.

Under **Wplace performance**, **Stop idle redraws** and **Settle event outlines** reduce map redraws. **Download changed tiles only** checks visible tiles for changes between full refreshes. **Reload drafted tiles only** refreshes tiles affected by draft edits. **Skip identical tile reads** avoids reading the same pixels twice. **Pause hidden marker animations** pauses the event marker animation while it is hidden.

![The six Wplace performance switches, all on.](images/settings/wplace-performance.png)

## Diagnostics

**Debug logging** adds console detail for investigating a problem. Enable it before reproducing a bug, then turn it off afterward.

![The Debug logging switch under Diagnostics.](images/settings/diagnostics.png)

**Performance profiling** records Caelestis CPU, GPU, and buffer measurements. While enabled, it adds measurement overhead. Its controls let you reset or copy the profile.

Before sharing logs or profiles, remove tokens and private information. See [Troubleshooting](Troubleshooting#report-a-bug).

## Dangerous settings

On the world map, each switch enables an action that sends simulated input to Wplace. All seven switches start off. Wplace records the listed Pawtect flags with paint submissions.

| Switch | What it does | Wplace flags |
| --- | --- | --- |
| **Picker reads templates** | The picker clicks the palette swatch for the template colour, falling back to the placed colour. | `UntrustedPalette` |
| **Middle-click picks template colours** | Middle-click on the map picks the template colour. | `UntrustedPalette` |
| **Keep picking while dragging** | Holding the middle button picks each template colour it passes, so Space paints the template as you drag. Needs the middle-click switch. | `UntrustedPalette`, `UntrustedPointer` |
| **Update cursor after flying** | When a flight, jump or pan ends under a still mouse, Wplace's hover square and Space target move to where the mouse points. | `UntrustedPointer` |
| **Paint past skipped pixels** | Shift+Space keeps painting beyond pixels it skips. | `UntrustedPaintHold`, `UntrustedPointer` |
| **Cycle unfinished colours** | The previous- and next-colour keys select a colour. | `UntrustedPalette` |
| **Paint key commits drafts** | The paint key commits an open draft. | `UntrustedPaintSubmit` |

Each description shows your assigned keys. With the switches off, Wplace's own picker can still read a world template colour. The colour cycling bindings appear grey under **Keyboard shortcuts**. The paint key opens the drawer. Use Wplace's paint button to submit the draft.

![The seven Dangerous settings switches, all off, each with its Pawtect flags.](images/settings/dangerous-settings.png)

On an alliance HQ, avatar or banner, these controls work inside the editor regardless of the world-map switches. If Wplace's world paint drawer is open underneath, **Paint past skipped pixels** still needs its world-map switch.
