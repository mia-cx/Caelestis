---
title: "Staff: map tools"
description: Staff-only routes for inspecting, clearing and rolling back map areas.
---

These routes serve Wplace's staff dashboard, which ships inside the public client. They are listed so mod authors can recognise them in the bundle. Players get `401` or `403`. Their notes describe what each route is for, and nothing more.

The area tool works in two steps. [[Staff-Inspect-an-area]] returns the painter id of every pixel, and [[Staff-Look-up-accounts-by-id]] turns those ids into accounts. The tool's actions then take the ids, or the selected pixels.

- [[Staff-Inspect-an-area|Inspect an area (staff)]]: Staff-only route that returns the painter id and colour of every pixel in a rectangle of one tile, as binary.
- [[Staff-Look-up-accounts-by-id|Look up accounts by id (staff)]]: Staff-only route that returns account info for a list of user ids.
- [[Staff-Suspend-accounts-from-an-area|Suspend accounts from an area (staff)]]: Staff-only route the area tool uses to suspend accounts.
- [[Staff-Suspend-accounts-from-a-pixel|Suspend accounts from a pixel (staff)]]: Staff-only route the pixel tool uses to suspend accounts.
- [[Staff-Require-verification-in-an-area|Require verification in an area (staff)]]: Staff-only route that requires phone verification from the accounts staff picked.
- [[Staff-Clear-an-area|Clear an area (staff)]]: Staff-only route that erases the selected pixels, one paint-style request per tile.
- [[Staff-Start-an-area-rollback|Start an area rollback (staff)]]: Staff-only route that starts a rollback session for an area.
- [[Staff-List-rollback-points|List rollback points (staff)]]: Staff-only route that lists the times an area can roll back to.
- [[Staff-Get-an-area-timelapse|Get an area timelapse (staff)]]: Staff-only route that renders a rollback session's paint history.
- [[Staff-Preview-an-area-rollback|Preview an area rollback (staff)]]: Staff-only route that previews an area at an earlier time.
- [[Staff-Apply-an-area-rollback|Apply an area rollback (staff)]]: Staff-only route that rolls an area back to an earlier time.
- [[Staff-List-paint-events-on-a-tile|List paint events on a tile (staff)]]: Staff-only route that pages through a tile's paint events up to a given time.
- [[Staff-Paint-as-an-administrator|Paint as an administrator (staff)]]: Staff-only route that paints an image onto the canvas for administrators.
