---
title: "Staff: anti-cheat"
description: Staff-only routes for anti-cheat signals, scoring and bans.
---

These routes serve Wplace's staff dashboard, which ships inside the public client. They are listed so mod authors can recognise them in the bundle. Players get `401` or `403`. Their notes describe what each route is for, and nothing more.

- [[Staff-Watch-live-anti-cheat|Get current anti-cheat signals (staff)]]: Staff-only route that returns a JSON snapshot of the players anti-cheat is currently flagging.
- [[Staff-Get-anti-cheat-stats|Get anti-cheat stats (staff)]]: Staff-only route that counts anti-cheat signals and bans over a time range.
- [[Staff-List-anti-cheat-signals|List anti-cheat signals (staff)]]: Staff-only route that lists signal types over a time range.
- [[Staff-Get-one-anti-cheat-signal|Get one anti-cheat signal (staff)]]: Staff-only route that shows the accounts that raised one signal.
- [[Staff-Get-shadow-scoring|Get shadow scoring (staff)]]: Staff-only route that compares a trial scoring model with the live one.
- [[Staff-Get-a-player-signals|Get a player's signals (staff)]]: Staff-only route that lists one player's anti-cheat signals over time.
- [[Staff-Get-an-anti-cheat-view|Get an anti-cheat view (staff)]]: Staff-only route that loads one of the anti-cheat dashboard views.
- [[Staff-Ban-from-anti-cheat|Ban from anti-cheat (staff)]]: Staff-only route that bans an account from the anti-cheat dashboard.
- [[Staff-Unban-from-anti-cheat|Unban from anti-cheat (staff)]]: Staff-only route that lifts an anti-cheat ban.
- [[Staff-Tune-anti-cheat|Tune anti-cheat (staff)]]: Staff-only route that changes anti-cheat thresholds.
- [[Staff-Analyse-punishments|Analyse punishments (staff)]]: Staff-only route that runs an analysis over past punishments.
- [[Staff-List-protections|List protections (staff)]]: Staff-only route that lists protected areas and accounts.
- [[Staff-Get-a-protection|Get a protection (staff)]]: Staff-only route that returns one protected map area, with its tiles, schedule and bypass list.
- [[Staff-Create-a-protection|Create a protection (staff)]]: Staff-only route that protects a set of map tiles from painting for a scheduled time.
- [[Staff-Edit-a-protection|Edit a protection (staff)]]: Staff-only route that changes a protected map area's name, schedule, message, pause state or bypass list.
- [[Staff-Delete-a-protection|Delete a protection (staff)]]: Staff-only route that removes a protected map area, at the revision staff last saw.
