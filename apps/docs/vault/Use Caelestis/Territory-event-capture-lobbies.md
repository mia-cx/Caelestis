---
title: Territory event capture lobbies
---

> [!WARNING] Temporary
> This support is only for Wplace's Territory Weekend. It will be removed after the event ends on Monday, 30 November 2026 at 16:00 UTC.

A capture lobby helps your team paint a wall in one timed sequence. Each painter drafts a section of the wall (a *leg*) and waits for their slot to submit it.

## Join a lobby

1. Join a team in Wplace. [Connect to your group's event server](Connect-to-a-server) with a **Report** token, in the browser where you plan to play.
2. Move the map over the event arena. The lobby card appears near the top left only while the event is live and the arena is in view.
3. Lobbies are listed largest first, by their host's name and painter count. Choose **Join** before a lobby's countdown starts. You can be in one lobby at a time.

You see your own team's lobbies and painters. Administrators see painters from every team, but still see only their team's lobbies. **Nearby painters** shows each painter's team. Dark diagonal stripes distinguish other painters' drafts from territory that's already painted.

## Host a lobby and plan a wall

Choose **New lobby**. You host it, and your row says **Host**. Only the host runs the lobby; administrators can also run any lobby they join. If you leave, the member who has been in the lobby longest becomes host.

Centre the map just outside your team's border where you want the wall. Proposals update as you move. Each shows how much territory you'd gain and how many pixels you'd paint.

| Setting | What to choose |
| --- | --- |
| **Painters** | Size the proposed wall for 1–16 painters. This isn't a limit on who can join. |
| **Anchor guards** | Assign up to half the lobby, rounded down, to protect the wall ends. One guard covers both ends; additional guards alternate ends and have separate zones. |
| **Legs** | **Even** divides the wall among all non-guards. **Reserve** uses the fewest painters who can cover it; the rest stand by without a leg or slot. |
| **Stagger** | Leave 100–2,000 ms between paint steps. Painters working from opposite ends can share a step. |
| **Countdown** | Allow 3–30 seconds from **Start countdown** to the first slot. |

Your browser remembers these settings for your next lobby. Choose **Lock in** beside a proposal to assign one leg per wall painter, at most 60 pixels each. **Needs N more painters** means the wall is too long for the current group. Wait for more painters or choose a shorter wall.

The host starts with the closing leg. Before the countdown, use **Give closing leg** on someone else's row to swap roles. Their row now says **Closes wall**, and you stay host. Use **Cancel proposed shape** to discard the wall and choose another without closing the lobby.

## Draft your line and paint at zero

1. Choose **Show my line** on your row. Open the event's **Paint** panel. If your leg doesn't touch your territory, follow the caterpillar guide: draft a short chain from your territory, adding at the front and removing at the back until you reach your line.
2. Draft the highlighted pixels, but don't submit yet. Your row counts pixels you've drafted **and** pixels your team already holds. Each end of the wall starts 3 pixels inside your territory, so if an enemy cuts the border there, the painter at that end drafts those pixels back first. When every wall leg is ready, the host can choose **Start countdown**. Guards and reserves don't hold up the start.
3. Listen for the opening beep, then the ticks at 5, 3, 2 and 1 seconds before **your** slot when time allows. Click **Paint** at the final tone, when your timer reaches zero. By default you submit by hand. **Paint at my capture slot** in [Dangerous settings](Settings-and-shortcuts#dangerous-settings) can click Paint for you; Wplace flags that click as `UntrustedPaintSubmit`.

If you're an anchor guard, draft your marked zone and paint at the first step. After the wall's last slot, watch for **Anchor cut** and the three-tone alarm. Repaint your line to restore the connection.

On the arena, `B` opens **Paint** and `Shift+B` opens **Swap shade**. Pressing the same shortcut again submits that panel only if **Paint key commits drafts** is on.

## Capture again or leave

After **Capture finished**, the host can choose **Plan next shape** to keep the same lobby, settings and remaining members for another wall. Choose **Leave** before the countdown or after it finishes. **Close lobby** ends the lobby for everyone.
