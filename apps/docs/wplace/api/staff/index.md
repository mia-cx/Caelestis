---
title: Staff routes
description: Staff-only routes found in the client bundle, listed so mod authors recognise them.
order: 30
---

These routes serve Wplace's staff dashboard, which ships inside the public client. They are listed so mod authors can recognise them in the bundle. Players get `401` or `403`. Their notes describe what each route is for, and nothing more.

Request bodies and query fields on these pages are what the dashboard sends, read from the client code. Which of them the server requires is unverified, since the guide makes no staff requests. Where the dashboard serialises a whole form object, the page says its fields are unknown.

- [Staff: players](users/): Staff-only routes for player accounts, punishments and grants.
- [Staff: alliances](alliances/): Staff-only routes for alliance records, moderation and headquarters.
- [Staff: anti-cheat](anticheat/): Staff-only routes for anti-cheat signals, scoring and bans.
- [Staff: reports](tickets/): Staff-only routes for the moderation report queue.
- [Staff: appeals](appeals/): Staff-only routes for the ban appeal queue.
- [Staff: support](support/): Staff-only routes for the support ticket queue and its routing.
- [Staff: commerce](commerce/): Staff-only routes for store products, promotions and purchases.
- [Staff: store manager](store-manager/): Staff-only routes for cosmetics, badges, frames and store images.
- [Staff: map tools](tools/): Staff-only routes for inspecting, clearing and rolling back map areas.
- [Staff: metrics and logs](reports/): Staff-only routes for metrics, audit logs and business accounts.
