# #415 feat(server): configure public metadata and branding

## Summary
An admin edits the server's public presentation from the userscript: name, description, Discord invite, home page copy, header logo (text or image), and a default link preview image. The frontend renders them; crawlers get the configured name, description, and preview on non-template routes. Nothing changes for deployments that never set them.

## Acceptance criteria
- [ ] Admin API and wire schema carry every field, and `null` clears an override back to the deployment default.
- [ ] Cloudflare (D1 sqlite), Postgres and MariaDB persist the settings across restarts and migrations.
- [ ] Logo and preview uploads go through the backend `BlobStore` with documented type and size limits; replacing or clearing deletes the previous blob.
- [ ] Frontend renders home copy, Discord action, and header logo with accessible text and responsive sizing.
- [ ] Non-template routes use the configured name, description and preview; folder and template titles, descriptions and GIF previews still win.
- [ ] Invalid URLs, unsafe copy and bad uploads fail with useful userscript feedback; the frontend never renders unsanitized admin content.
- [ ] Existing deployments need no new settings; current copy and image stay the fallback.
- [ ] Tests cover storage, authorization, fallbacks, metadata precedence, and editing.

## Contract (decided)
`ServerInfo` grows optional public presentation fields:
- `discordInviteUrl?: string` (normalised `https://discord.gg/<code>`)
- `homeCopy?: string` (raw, max 4000 chars, only what `parseHomeCopy` accepts)
- `logoText?: string` (max 64 chars; the header text when no logo image is set; defaults to `name`)
- `logoImage?: ServerAsset`, `previewImage?: ServerAsset` where `ServerAsset = { etag: sha256 hex, contentType }`

Home copy is a bounded markdown subset parsed by `@caelestis/shared` `parseHomeCopy`: paragraphs, `## heading`, `- ` bullets, `**bold**`, `*italic*`, `[label](https://...)`. Anything else is plain text. The backend rejects copy the parser refuses; the frontend renders parser blocks, never HTML.

Admin routes (admin scope):
- `PATCH /v1/admin/server` accepts `name`, `description|null`, `discordInviteUrl|null`, `homeCopy|null`, `logoText|null`.
- `PUT /v1/admin/server/assets/:kind` (`logo` | `preview`), raw image body, `content-type` in `image/png`, `image/jpeg`, `image/webp`, `image/gif`, verified by magic bytes. Logo max 512 KiB, preview max 2 MiB. Answers `{ etag, contentType }`.
- `DELETE /v1/admin/server/assets/:kind`.

Public: `GET|HEAD /v1/server/assets/:kind?v=<etag>` serves the bytes with `etag`, `x-content-type-options: nosniff`, immutable caching when `v` matches, 404 when unset. The frontend addresses assets through its read proxy as `/api/v1/server/assets/<kind>?v=<etag>`.

Storage: new `BlobNamespace` `'branding'`, key `<kind>/<sha256>`. `server_settings` gains `discord_invite_url`, `home_copy`, `logo_text`, `logo_blob_key`, `logo_content_type`, `preview_blob_key`, `preview_content_type`.

## TODOs
- [x] Shared contract: `parseHomeCopy`, `parseDiscordInviteUrl`, `ServerInfo` fields in shared and wire-schema, tests.
- [~] Backend (Codex): schema, migrations for sqlite/postgres/mariadb, `ServerSettings` port and adapters, `'branding'` blob namespace, admin patch and asset routes, public asset route, `mergeServerInfo`, tests.
- [x] Userscript: `Edit server details` action beside rename on the server root row; a `caelestis-server-details` UI element with fields, uploads, clear buttons, and feedback; `state.ts` mutations for patch, upload and delete.
- [x] Frontend: header logo (image with text fallback), home copy blocks and Discord join action on the home page, social metadata precedence, tests.
- [~] Changesets for backend, frontend, userscript; docs note in `docs/self-hosting.md`.
- [ ] Full validation: lint, check, test.

## Notes
- Backend seam goes to Codex `gpt-6-astra`; Claude keeps the UI. Brief in `.plans/415-codex-backend.md`.
- The userscript has its own `ServerInfo` parser in `server-manifest.ts`; it now keeps valid presentation fields and drops invalid ones instead of rejecting the server.
- Frontend assets are addressed through the read proxy as `/api/v1/server/assets/<kind>?v=<etag>` for SSR and the configured server, and through the chosen server's origin otherwise.
- Validation so far: shared 21 tests, wire-schema 204 tests, frontend social 6 tests, userscript server-manifest, tree, state and server-details suites all pass; `check` passes for shared, wire-schema, ui, frontend and userscript.
- Codex's sandbox cannot fetch pnpm 12.3.4 through corepack. It worked around it with `pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false`.
