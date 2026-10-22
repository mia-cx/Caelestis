// Stands in for `cloudflare:workers` in Node builds, which have no Worker bindings.
// node/server.mjs passes the frontend's config to SvelteKit through `platform.req` instead.
export const env = {}
