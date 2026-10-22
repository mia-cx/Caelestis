# #595 Frontend loses its Cloudflare config under SvelteKit 3's adapter

## Summary

Upgrade the frontend to SvelteKit 3 with `adapter-cloudflare` 8 and `adapter-node` 6. Cloudflare no
longer passes `platform.env`, so read Worker bindings from `cloudflare:workers` and keep the Node
server's `platform.req` path, both resolved once in the server hook.

## Acceptance criteria

- [ ] Cloudflare builds read `CAELESTIS_READ_TOKEN`, `CAELESTIS_BACKEND`, `CAELESTIS_SERVER` and `SOCIAL_IMAGES` from `cloudflare:workers`.
- [ ] Node builds keep reading the custom server's environment and object storage from `platform.req`.
- [ ] Kit 3 build changes land: `$app/tsconfig`, `@sveltejs/kit/hooks`, `$app/env`, `#lib` imports.
- [ ] `adapter-node` 6 and `@sveltejs/package` 3 move with Kit; the `@sveltejs/package@2.5.8` `packageExtensions` entry is gone.
- [ ] Check, lint, tests, and both Cloudflare and Node builds pass.

## TODOs

- [ ] Bump Kit, adapters and package; apply the Kit 3 migration (tsconfig, hooks, `$app/env`, `#lib`).
- [ ] Resolve host config once in the server hook from `cloudflare:workers` or `platform.req`.
- [ ] Test that the hook fills locals from both hosts.
- [ ] Build both targets and smoke the Cloudflare build under `wrangler dev`.
- [ ] Add a frontend Changeset.

## Notes
