# Collaboration performance

Issue #372 measures the complete userscript on Wplace in one signed-in Chromium tab.
The tab loads the existing templates and claims. Controlled peer messages enter the real
presence socket's message handler, so parsing, state updates, the drawer, MapLibre rendering,
and hover labels all run through production code. The fixture never sends invented peers to a server.

## Reproduce

Build the userscript and start the debug Chromium with the normal browser command. Keep one
Wplace tab open. The runner uses that tab, reloads it with the supplied bundle, and keeps
Caelestis settings writes in memory. It requires an existing presence connection and claims.

```sh
pnpm --filter @caelestis/userscript... build
node apps/userscript/chromium.mjs
node scripts/benchmark-wplace-collaboration.mjs \
  apps/userscript/dist/wplace-template-server.user.js /tmp/collaboration.json 3
```

The fixed camera looks at the Box art claims. Adjust it for another installation. Browser zoom
was verified at 110% in Chromium's toolbar. Each scenario warms for 1.5 seconds, then samples
24 steps spaced 300 ms apart. Native paint interactions and CDP dispatch add to elapsed time.

| Scenario | Workload |
| --- | --- |
| Idle presence | One stationary peer; pointer over a real claim; userscript drawer open |
| Active painting | Native black draft clicks, one updating remote draft, and the open userscript drawer |
| Map movement | Repeated camera movement and remote viewport/draft messages |
| Simultaneous players | 64 incoming peers with viewport updates and 64-pixel draft masks |

Native drafts are cancelled. The runner never presses the paint submission button. Peer replay
tests client-side concurrency; it does not benchmark server fan-out or network latency. This
page-context injection follows the repository's development runner and does not test manager sandbox injection.

## Reading the measurements

`Performance.getMetrics` supplies whole-page main-thread task, script, layout, and heap measurements.
The exported profiler attributes Caelestis work and records frame intervals. Nested `detail` timings
stay outside aggregate CPU totals. Frame cadence does not establish input-to-display latency.

Presence and live paint byte counters measure UTF-8 application payloads, excluding transport framing
and compression. Divide totals by elapsed seconds to obtain rates. Known memory includes region masks,
component label arrays, and R8 GPU masks; object and driver overhead are excluded.

The discarded synthetic and multi-tab probes are not performance acceptance evidence.
Use matched single-tab runs and check their template, claim, peer, draft, and message counts.
