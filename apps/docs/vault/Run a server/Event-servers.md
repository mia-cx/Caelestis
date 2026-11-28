---
title: Event servers
---

> [!WARNING] Temporary
> Event servers are only for Wplace's Territory Weekend. This support will be removed after the event ends on Monday, 30 November 2026 at 16:00 UTC.

## Enable event mode

Set `EVENT_SERVER=true` on the backend, or set `server.eventServer: true` in your [Helm values](Kubernetes-with-Helm). Leave it off for a regular server. An event server advertises `capture: 1` for capture lobbies.

Presence follows the Wplace team each session reports. Painters see only their team's painters; administrators see painters from every team. [Capture lobbies](Territory-event-capture-lobbies) stay within a team, even for administrators. Region claims are off.

## Invite painters

[Create a **Report** token](Authentication-and-tokens#create-a-token) in **Settings → Access tokens** under the event server and share it with your painters. You can share one report token across teams; no token is bound to a team.

Anyone with a report token can open a lobby and host it. The host runs their lobby: its settings, order, wall and countdown. If the host leaves, the member who has been in the lobby longest takes over. Administrators can run any lobby they join.

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

## Read painters' latency to Wplace

Every painter's browser reports its latency to Wplace without a capture: once just after its first paint, then every five minutes while it has something new.

```sh
kubectl -n caelestis-event logs -l app.kubernetes.io/name=caelestis,app.kubernetes.io/component=server \
  -c backend --since=6h --tail=-1 | grep '"event":"wplace-latency"' | jq -c .
```

`wplaceRttMs` is the median of the browser's last `rttSamples` round trips to Wplace. `paints` lists each Paint click since the previous report, with `clickToSendMs`, `sendToResponseMs` and `status` as in slot lines.
