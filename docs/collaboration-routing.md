# Collaboration across servers

Each browser tab opens a presence socket to every connected server that supports presence. Viewports and drafts keep their existing throttles. Servers still send only nearby peers.

The tab supplies the same random publisher ID to each server. Receivers deduplicate by painter and publisher ID, using the most recently received copy. Separate tabs remain separate sessions. If one server disconnects, copies from other servers remain visible. The Painters drawer counts unique nearby sessions, excluding this tab.

Publisher IDs are separate from credential-scoped client admission IDs. Older servers can still connect, but their unrelated server-generated session IDs cannot be deduplicated across servers. Upgrade the backend as well as the userscript for this behavior.

## Region claims

Claims keep one ID across server copies. The client compares actual claimed pixels with template bounds in the same season and drawing surface. Subtracted pixels and gaps between shapes do not count as overlap. World-wrapping bounds are split at the world edge.

If any templates overlap, only their servers receive the claim. Otherwise every compatible connected server in that season receives it. Claim recipients require a report or admin credential confirmed by the server snapshot; read-only and anonymous connections still receive presence. A catalog still loading delays reconciliation. Hidden and unloaded artwork in the admitted catalog still participates.

Snapshots identify claims owned by the connection's exact credential and painter. Only those claims can enter the local replication journal. A public painter ID alone never proves ownership. Older servers without ownership metadata remain readable but cannot supply claims for automatic adoption. When a socket cannot connect, HTTP snapshots refresh claims every 30 seconds. A ready socket cancels the fallback and discards any pending HTTP result.

Adding a server, changing a catalog, or editing a claim recalculates recipients. The client writes replacements before removing old copies. It persists intent and known destinations before sending, then retries failures. Browser tabs share that journal under a Web Lock so an older tab cannot replay stale saved intent. Deletion retains local intent until its copies can be removed or expire.

Removing a connection persists a retirement marker that every tab checks before writing, aborts local in-flight requests, and reads shared intent for cleanup. A PUT already dispatched by another tab removes its copy when it completes. Cleanup has a three-second deadline and runs before credentials are discarded. Unreachable copies remain subject to expiry. Explicitly reconnecting the server permits claim writes again.

## Expiry

Claims expire after 30 days without renewal. An authenticated presence connection renews unexpired claims owned by both its credential and painter ID. Valid heartbeats and updates keep the connection active; renewal writes are coalesced to once an hour. The renewing session receives a small acknowledgement with the renewed IDs and expiry. Anonymous connections do not renew claims. Administrator connections renew only their own credential/painter pair.

Expiry is checked before reads, inserts, and renewal. Durable presence alarms remove expired claims even after the last socket closes. Periodic maintenance also purges abandoned rows. Migration gives existing claims a fresh 30-day period. Rows inserted without expiry by an older binary during rollout receive 30 days from their creation timestamp.

Returning users first discard expired local intent. A connection cannot renew an expired server claim. A logical claim that remains active on another server can still be replayed under normal routing rules.
