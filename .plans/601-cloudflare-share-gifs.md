# #601 Cloudflare servers render their own share GIFs

## Summary
Cloudflare deployments refresh share GIFs from a GitHub Actions workflow that reads a hardcoded
site. Move the refresh into the backend Worker (daily cron enqueues, Queue consumer renders one
template per message), share one renderer package between both backends, and delete the workflow.

## Acceptance criteria
- [x] A Cloudflare deployment refreshes every published template's GIF daily with no GitHub Actions involvement.
- [~] The largest current template renders within Worker limits. Measured in Node and exercised in
  local workerd; the production render needs a deploy (see Notes).
- [x] Docker and Helm servers use the same shared renderer and behave as before.

## TODOs
- [x] Move the renderer into `packages/social` (`@caelestis/social`); frontend, CLI and benchmark import it.
      Folded in: the per-template loop and object-storage OSM cache; the Node worker thread uses the package.
- [x] Stream frames into the GIF encoder so a render holds O(1) frames, not 301.
- [x] Cloudflare backend: daily cron enqueues published templates; Queue consumer renders in-process and writes `BLOBS`.
- [x] Remove `.github/workflows/social-images.yml`; update `scripts/social-images.md`, `docs/self-hosting.md`, CI paths, Dockerfile; changeset.
- [ ] Final validation: lint, check, tests, local Cloudflare stack.

## Notes
- Measured before changes (`.scratch/601/measure.mjs`, Node 26, synthetic 1-tile template with 300
  history frames): peak 326–356 MB, 46 s. Frames alone are 301 × 640×360×4 B ≈ 277 MB.
- After streaming: same output bytes, 84 MB peak (includes uncollected garbage), 33 s. A six-tile-wide
  synthetic template: 99 MB peak, 111 s CPU, 2,430 tile decodes. Hence `limits.cpu_ms = 300000`.
- An oversized pass now stops at 4.5 MB and re-renders the surviving frames, so retries re-read tiles.
- In-process reads: `IN_PROCESS_READ` symbol in Hono's per-request env grants `read` only.
- Local workerd check (`.scratch/601/cf-e2e.mjs`): `/__scheduled?cron=37 7 * * *` → queue → consumer
  → `social/v2/0/<id>.gif` in local R2 (640×360, 2 frames, 15 s).
- `wrangler.toml` adds the queue, consumer (batch 1, concurrency 1, 3 retries) and `cpu_ms`. `deploy.yml`
  creates the queue if missing; the deploy token needs Queues edit permission.
