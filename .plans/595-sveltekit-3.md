# #595 Frontend loses its Cloudflare config under SvelteKit 3's adapter

## Summary

Upgrade the frontend to SvelteKit 3 with `adapter-cloudflare` 8 and `adapter-node` 6. Cloudflare no
longer passes `platform.env`, so read Worker bindings from `cloudflare:workers` and keep the Node
server's `platform.req` path, both resolved once in the server hook.

## Acceptance criteria

- [x] Cloudflare builds read `CAELESTIS_READ_TOKEN`, `CAELESTIS_BACKEND`, `CAELESTIS_SERVER` and `SOCIAL_IMAGES` from `cloudflare:workers`.
- [x] Node builds keep reading the custom server's environment and object storage from `platform.req`.
- [x] Kit 3 build changes land: `$app/tsconfig`, `@sveltejs/kit/hooks`, `$app/env`, `#lib` imports.
- [x] `adapter-node` 6 and `@sveltejs/package` 3 move with Kit; the `@sveltejs/package@2.5.8` `packageExtensions` entry is gone.
- [x] Check, lint, tests, and both Cloudflare and Node builds pass.

## TODOs

- [x] Bump Kit, adapters and package; apply the Kit 3 migration (tsconfig, hooks, `$app/env`, `#lib`).
- [x] Resolve host config once in the server hook from `cloudflare:workers` or `platform.req`.
- [x] Test that the hook fills locals from Worker bindings.
- [x] Keep the self-hosted ORIGIN setting under adapter-node 6.
- [x] Build both targets and smoke them under `wrangler dev` and `node node/main.mjs`.
- [-] Add a frontend Changeset. Skipped: deployed behaviour is unchanged, so there is nothing user-visible to note.

## Notes

- `sv migrate sveltekit-3 --tasks all` did the import rewrites (85 files). Its `#lib` bare entry pointed at an empty placeholder `src/lib/index.ts`; both removed.
- `svelte-check --tsgo` types `.svelte` files reached through package.json `imports` as `any` (sveltejs/language-tools#3142), giving false implicit-any errors. A `#lib/*` tsconfig `paths` entry works around it.
- Node builds and Vitest alias `cloudflare:workers` to `node/cloudflare-workers.js` (empty `env`). Without it rolldown fails on the Node build, and in Vitest the adapter's virtual module throws because no platform proxy runs.
- adapter-node 6 removed the runtime `ORIGIN` variable (`paths.origin` is build-time only). The Docker image is built once, so `node/server.mjs` now rewrites host and protocol from `ORIGIN`.
- Cloudflare smoke under `wrangler dev`: stub `CAELESTIS_SERVER` received `Bearer smoke-token`. A local `caelestis-backend` Worker received the service-binding call. A GIF put into local R2 was served from `/social/template/smoke.gif`.
- Node smoke: with `ORIGIN=http://example.test:8080`, `og:url` is `http://example.test:8080/`. Without it, origin falls back to `https://<host>` as before. The stub backend saw `Bearer node-token`, and a filesystem-stored GIF was served.
- The new hook test fails on the previous hook (503 instead of 200).
