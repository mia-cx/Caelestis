# Backend brief for #415: configurable public server branding

You are implementing the backend half of GitHub issue #415 in this pnpm monorepo (`apps/backend`). Another engineer is doing the frontend, `packages/ui` and `apps/userscript` in the same worktree at the same time. Do not touch files outside `apps/backend` and `docs/self-hosting.md`. Do not commit. Do not run `git stash`, `git checkout` or anything that changes the working tree outside your files.

The shared contract is already committed and built. Read these first:

- `packages/shared/src/server-branding.ts` (types, limits, `parseHomeCopy`, `parseDiscordInviteUrl`, `logoText`, `sniffServerAssetContentType`, `SERVER_ASSET_MAX_BYTES`, `ServerAsset`, `ServerAssetKind`)
- `packages/shared/src/manifest.ts` (`ServerInfo` grew `discordInviteUrl`, `homeCopy`, `logoText`, `logoImage`, `previewImage`, all optional)
- `packages/wire-schema/src/index.ts` (`ServerInfo` schema, the wire contract every response must satisfy)
- `apps/backend/src/routes/server.ts`, `apps/backend/src/server-info.ts`, `apps/backend/src/ports/sql-store.ts` (`ServerSettings`), `apps/backend/src/adapters/relational-sql-store.ts` (`readServerSettings`, `writeServerSettings`), `apps/backend/src/ports/blob-store.ts`, `apps/backend/src/db/schema.ts`, `apps/backend/src/app.ts`.

## What to build

### 1. Storage

Extend the single-row `server_settings` table with nullable columns:
`discord_invite_url`, `home_copy`, `logo_text`, `logo_blob_key`, `logo_content_type`, `preview_blob_key`, `preview_content_type` (all text).

- Update `apps/backend/src/db/schema.ts`.
- Generate the sqlite migration with `pnpm --filter @caelestis/backend db:generate` (drizzle-kit, writes `apps/backend/migrations/00xx_*.sql` plus `meta/`). Rename the generated file to something descriptive like `0027_server_branding.sql` and fix the journal entry to match if drizzle used a random name.
- Hand-write matching migrations in `apps/backend/migrations-postgres/` and `apps/backend/migrations-mariadb/`, following the numbering each directory already uses (look at how commit `d272b1df` added `0026_reservation_expiry_index.sql` to sqlite and `0003_reservation_expiry_index.sql` to postgres and mariadb). Existing tests in `apps/backend/src/db/schema.drift.test.ts` and the adapter tests must keep passing.

Extend `ServerSettings` in the port:

```ts
export interface ServerSettings {
  readonly name: string | null
  readonly description: string | null
  readonly discordInviteUrl: string | null
  readonly homeCopy: string | null
  readonly logoText: string | null
  readonly logo: ServerAssetRecord | null
  readonly preview: ServerAssetRecord | null
}
export interface ServerAssetRecord { readonly blobKey: string; readonly contentType: ServerAssetContentType }
```

`writeServerSettings(patch)` accepts any subset of `name?: string`, `description?: string | null`, `discordInviteUrl?: string | null`, `homeCopy?: string | null`, `logoText?: string | null`, `logo?: ServerAssetRecord | null`, `preview?: ServerAssetRecord | null`. Undefined leaves a field alone, null clears it. Implement in `RelationalSqlStore` (D1, sqlite, postgres, mariadb all go through it) and in the memory store if it has its own implementation.

Add `'branding'` to `BlobNamespace` in `apps/backend/src/ports/blob-store.ts`. Check every adapter and test fixture that enumerates namespaces (R2, memory, object blob store, GC scans) and make sure `'branding'` is never swept by tile or chunk garbage collection.

### 2. Server info

`mergeServerInfo(base, settings)` in `apps/backend/src/server-info.ts` adds the optional public fields when set:
`discordInviteUrl`, `homeCopy`, `logoText`, `logoImage: { etag, contentType }`, `previewImage: { etag, contentType }`. The `etag` is the SHA-256 hex digest that is also the blob key's last path segment (see below). Every `/v1/server` and `/v1/manifest` response must still decode with the wire-schema `ServerInfo`.

### 3. Admin routes (admin scope, under `/v1/admin/server`, in `apps/backend/src/routes/server.ts`)

`PATCH /` keeps `name` and `description` and adds:
- `discordInviteUrl?: string | null`: validate with `parseDiscordInviteUrl`; store the canonical form. 400 with `{ error: 'discordInviteUrl must be a Discord invite link, or null' }` otherwise.
- `homeCopy?: string | null`: normalise with `normaliseHomeCopy`, an empty string becomes null; validate with `parseHomeCopy`; on failure answer 400 with `{ error: result.message }`.
- `logoText?: string | null`: validate with `logoText`; 400 `{ error: 'logoText must be 1..64 characters, or null' }`.
- A patch that sets nothing is 400 as today. Keep the existing publish-manifest-change behaviour after a successful write.

`PUT /assets/:kind` where `kind` is `logo` or `preview` (anything else 404):
- Reads the raw request body (not multipart). Reject when `content-length` or the read body exceeds `SERVER_ASSET_MAX_BYTES[kind]` with 413 `{ error: 'logo must be at most 512 KiB' }` / `'preview must be at most 2 MiB'`. Reject an empty body with 400.
- Sniff the container with `sniffServerAssetContentType`; 415 `{ error: 'upload a PNG, JPEG, WebP or GIF image' }` when unknown. The sniffed type wins over the header.
- Compute `sha256Hex(bytes)` (from `@caelestis/shared`), write blob `branding/<kind>/<sha256>` through `BlobStoreService`, then update settings (`logo` or `preview` record). If the previous record had a different blob key, delete the previous blob after the settings write succeeds. Same key: no delete.
- Answer 200 `{ etag, contentType }`. Publish the manifest change like PATCH does.

`DELETE /assets/:kind`: clear the record, delete the blob, 200 `{ ok: true }`, publish. 200 also when nothing was set.

### 4. Public route (no auth, in `createServerRoutes`)

`GET` and `HEAD /v1/server/assets/:kind`:
- 404 when unset or kind unknown.
- Serve the bytes with `content-type`, `content-length`, `etag: "<sha256>"`, `x-content-type-options: nosniff`, `content-disposition: inline`.
- `cache-control: public, max-age=31536000, immutable` when the `v` query equals the current etag, otherwise `public, no-cache`.
- Honour `if-none-match` with a 304 the way `apps/frontend/src/routes/social/template/[id].gif/+server.ts` does.

Follow the conventions of the existing routes: `runBackendHttp`, Effect services from `runtime/backend-runtime.ts`, `BackendStorageError` and `SqlStoreReadError` for failures, and the same JSON error shape.

### 5. Docs

Add a short section to `docs/self-hosting.md` describing the new admin fields, the two asset routes, and the limits (types, sizes, home copy format from the `parseHomeCopy` doc comment).

## Acceptance criteria (verify each yourself before reporting)

1. `pnpm --filter @caelestis/backend check` passes.
2. `pnpm --filter @caelestis/backend test` passes, including new tests in `apps/backend/src/routes/server.test.ts` (create it if absent, following `routes/tags.test.ts` or `routes/nodes.test.ts` for how routes are tested with the memory runtime) covering:
   - PATCH validation for each new field, null clearing, and that an admin scope is required (401/403 for a reader token and for no token).
   - Asset upload: sniffing beats the header, oversized body 413, unknown container 415, replace deletes the old blob, delete clears and removes the blob, uploading identical bytes twice keeps one blob.
   - Public asset route: 404 when unset, correct headers, 304 on matching `if-none-match`, `immutable` only when `v` matches.
   - `/v1/server` reflects every field after writes and omits them all when nothing is set.
3. Adapter tests for sqlite, and for postgres and mariadb where the test helpers already run them, prove `readServerSettings` round-trips every column.
4. `pnpm exec biome check apps/backend docs/self-hosting.md` is clean.
5. `pnpm --filter @caelestis/backend build` passes.

## Report

When done, write `.plans/415-codex-report.md` with: files changed, the exact commands you ran and their results, and anything you could not finish or verify. Be plain about failures. Do not commit.
