---
title: Telemetry
description: Analytics pings the client sends on its own.
order: 15
---

Fire-and-forget analytics. A mod has no reason to send these.

- [[Record-visit|Record a visit]]: Analytics ping the client sends on each page load, with a visitor id.
- [[Record-onboarding-event|Record an onboarding event]]: Analytics ping for the onboarding experiment the visitor is in.
- [[Record-notice-dismissal|Record a dismissed notice]]: Analytics ping when a player closes a site notice.
- [[Record-store-event|Record a store event]]: Analytics ping for store views and clicks.
- [[Record-frontend-telemetry|Record client telemetry]]: Client telemetry event, refused with 401 for anonymous visitors.
- [[Report-frontend-errors|Report client errors]]: The client's error reporter, which sends batches of page errors and unhandled rejections to Wplace.
