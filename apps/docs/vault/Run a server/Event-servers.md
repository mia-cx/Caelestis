---
title: Event servers
---

> [!WARNING] Temporary
> Event servers are only for Wplace's Territory Weekend. This support will be removed after the event ends on Monday, 30 November 2026 at 16:00 UTC.

## Enable event mode

Set `EVENT_SERVER=true` on the backend, or set `server.eventServer: true` in your [Helm values](Kubernetes-with-Helm). Leave it off for a regular server. An event server advertises `capture: 1` for capture lobbies and `eventRunners: 1` for runner invites.

Presence follows the Wplace team each session reports. Painters and runners see only their team's painters; administrators see painters from every team. [Capture lobbies](Territory-event-capture-lobbies) stay within a team, even for administrators. Region claims are off.

## Invite painters and runners

[Create a token](Authentication-and-tokens#create-a-token) in **Settings → Access tokens** under the event server. Choose the scope for the person's role:

- **Report** lets painters join lobbies. You can share a report token across teams; no token is bound to a team.
- **Event runner** (`event_runner`) lets someone open and manage lobbies without giving them administrator access. Create one invite per runner and send it privately. Administrators can also run lobbies.

When the runner connects, their browser sends the invite as the bearer token to `POST /v1/auth/exchange`. The server consumes it and returns a fresh token with the same label and scope. The browser keeps the replacement. The original invite won't work a second time.

## Read the countdown and slot logs

For Kubernetes, substitute your namespace for `caelestis-event`:

```sh
kubectl -n caelestis-event logs -l app.kubernetes.io/name=caelestis,app.kubernetes.io/component=server \
  -c backend --since=6h --tail=-1 | grep -E '"event":"capture-(countdown|slot)"' | jq -c .
```

Match lines by `lobby` and `step`:

- `capture-countdown` gives the planned order. `startsAt` is the first slot on the server's clock. `staggerMs` separates successive steps. Members on the same step paint together; reserves have no step.
- `capture-slot` records one browser's automatic slot attempt, not every manual click. Compare `slotAt` with `firedLateMs` (how late the tab fired), `clickToSendMs` (click to Wplace request) and `sendToResponseMs` (request to response). `wplaceRttMs` measures the tab's recent round trip to Wplace; `clockRttMs` and `clockOffsetMs` describe its clock sync with your server.

`status` is Wplace's HTTP status if it replied. Otherwise look for `missed` (the tab woke too late), `nothing-drafted`, `unsubmitted` (Paint wasn't ready), `no-request`, `no-response` or `failed`. A null request timing means that part wasn't observed.
