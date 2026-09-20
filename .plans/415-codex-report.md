# #415 backend implementation report

Implemented configurable public branding in `apps/backend` and documented it in `docs/self-hosting.md`.
No commits, stashes, checkouts, deployments, or live database changes were made.
The other engineer's frontend, UI, userscript, and Changeset files were not edited.
This requested report is the only edited file outside the backend and self-hosting guide.

## Result

- Settings persist Discord invites, home copy, logo text, and logo/preview asset records. Partial writes preserve omitted fields; null clears optional fields.
- Admin PATCH validates and normalizes the new fields. Admin PUT/DELETE manage content-addressed branding blobs and publish manifest changes.
- Public GET/HEAD serves assets with sniffed content types, ETags, conditional 304 responses, and version-dependent caching.
- Both server and manifest responses include branding and decode with the shared wire schema. The manifest assembler previously dropped the new fields; its deterministic serializer now includes them.
- Branding uses a separate blob namespace. R2, memory, and portable object adapters already prefix namespaces. Tile GC only scans/deletes `tiles`; the added GC test proves branding survives a sweep.

## Files changed

### Storage and migrations

- `apps/backend/src/db/schema.ts`
- `apps/backend/src/ports/sql-store.ts`
- `apps/backend/src/ports/blob-store.ts`
- `apps/backend/src/ports/index.ts`
- `apps/backend/src/adapters/relational-sql-store.ts`
- `apps/backend/src/adapters/memory/memory-sql-store.ts`
- `apps/backend/migrations/0027_server_branding.sql`
- `apps/backend/migrations/meta/0027_snapshot.json`
- `apps/backend/migrations/meta/_journal.json`
- `apps/backend/migrations-postgres/0027_server_branding.sql`
- `apps/backend/migrations-mariadb/0004_server_branding.sql`

Drizzle generated the SQLite migration and snapshot. I renamed `0027_lucky_reaper.sql` and its journal tag to `0027_server_branding`.
The PostgreSQL directory already ends at `0026_reservation_expiry_index.sql`, so its new migration is `0027`.
MariaDB ends at `0003_reservation_expiry_index.sql`, so its new migration is `0004`.

### Routes, public metadata, and tests

- `apps/backend/src/routes/server.ts`
- `apps/backend/src/server-info.ts`
- `apps/backend/src/manifest/assemble.ts`
- `apps/backend/src/routes/server.test.ts`
- `apps/backend/src/adapters/sql-store-portable.test.ts`
- `apps/backend/src/telemetry/tile-blobs.test.ts`

### Documentation and existing lint diagnostics

- `docs/self-hosting.md`
- `apps/backend/src/adapters/cloudflare/d1-sql-store.ts`
- `apps/backend/src/work/d1-store.ts`
- `apps/backend/src/work/relational-region-store.ts`
- `.plans/415-codex-report.md`

The lint-only edits remove one unused import and explain two intentional constructors that narrow the database type to D1.
The constructors remain intact. These edits make the requested backend-wide Biome check clean.

## Validation commands and results

Commands ran from the repository root unless their pnpm filter selected the backend.
The installed pnpm is **11.25.0**; the repository requests **12.3.4**.
The default version switch failed because registry fetches were unavailable.
The successful commands below use the installed pnpm and disable automatic dependency installation.
Repository package-manager configuration and dependency files were not changed.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false --filter @caelestis/backend db:generate
```

Passed. Generated seven nullable text columns, the SQLite migration, and Drizzle metadata.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false --filter @caelestis/backend check
```

Passed on the final code. Both the backend and Bun type checks exited 0.
The first run caught an overly narrow `Uint8Array` type in the new upload test helper; that was corrected.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false --filter @caelestis/backend exec vitest run src/routes/server.test.ts src/adapters/sql-store-portable.test.ts src/db/schema.drift.test.ts src/telemetry/tile-blobs.test.ts
```

Passed on the final code. **4 files, 60 tests passed**, including **22 new route cases**.
The settings contract ran against memory, D1-on-SQLite, and portable SQLite.
Route coverage includes every requested validation, null clearing, admin authorization, content sniffing,
both size limits, unknown containers, replacement/deletion, identical uploads, public GET/HEAD,
weak/list/wildcard validators, immutable caching, and wire decoding after setting/clearing all branding.
Public asset reads also pass when open access is disabled.
Failure injection verifies that blob or SQL write failures preserve the previous asset.

The first focused run exposed a test expectation mismatch: the existing metadata publisher uses
`affectsTileCoverage=true`. The assertion now preserves that existing behavior.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false --filter @caelestis/backend test
```

**Did not pass.** Result: **889 passed, 2 failed, 12 skipped** across 67 files.
Both failures are existing tests in `src/node/server.test.ts`:

- `sqlite serves authenticated HTTP and real v2 WebSockets across a restart`
- `reports per-pod users, slots, and admission outcomes on /metrics`

Both fail with `Error: listen EPERM: operation not permitted 127.0.0.1`.
The sandbox denies opening their local HTTP listeners. No tests were disabled or changed to hide this.
All branding tests pass in the full run. Subsequent edits only cleaned lint and strengthened the focused public-access test.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false exec biome check apps/backend docs/self-hosting.md
```

Passed on the final code. **189 files checked, no diagnostics.**
The initial run reported one existing unused-import warning and two constructor notices, addressed as listed above.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false --filter @caelestis/backend build
```

Passed on the final code. Both TypeScript build targets exited 0.

```sh
git diff --check -- apps/backend docs/self-hosting.md
```

Passed. Reviewed the scoped diff, new routes/tests, generated migration, and portable migrations.
Used `git diff --text` to inspect the memory store because an existing NUL byte makes Git classify it as binary.

## Earlier tooling commands

```sh
pnpm --filter @caelestis/backend db:generate
npm_config_manage_package_manager_versions=false pnpm --version
```

Both failed during the attempted pnpm 12.3.4 version switch with a registry signature verification error caused by failed fetches.

```sh
pnpm --pm-on-fail=ignore --version
pnpm --pm-on-fail=ignore --filter @caelestis/backend db:generate
```

The version command returned `11.25.0`. The generation command attempted an automatic `pnpm install`,
whose version switch failed before generation. Later commands disable that automatic install.

```sh
pnpm --pm-on-fail=ignore --verify-deps-before-run=false --filter @caelestis/backend db:generate
pnpm --pm-on-fail=ignore --verify-deps-before-run=false --filter @caelestis/backend check
```

Both rejected the option syntax. The accepted option is `--config.verify-deps-before-run=false`.

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false --filter @caelestis/backend test -- src/routes/server.test.ts src/adapters/sql-store-portable.test.ts src/db/schema.drift.test.ts src/telemetry/tile-blobs.test.ts
```

This invocation ran the whole suite rather than filtering it. It found the manifest serializer omission,
which was fixed, and the same two sandbox listener failures. Result then: 888 passed, 3 failed, 12 skipped.
Focused invocations thereafter use `exec vitest run` as shown above.

Formatting commands:

```sh
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false exec biome check --write apps/backend/src/ports/sql-store.ts apps/backend/src/ports/index.ts apps/backend/src/ports/blob-store.ts apps/backend/src/adapters/memory/memory-sql-store.ts apps/backend/src/adapters/relational-sql-store.ts apps/backend/src/adapters/sql-store-portable.test.ts apps/backend/src/db/schema.ts apps/backend/src/server-info.ts apps/backend/src/routes/server.ts apps/backend/src/routes/server.test.ts apps/backend/src/telemetry/tile-blobs.test.ts docs/self-hosting.md
pnpm --pm-on-fail=ignore --config.verify-deps-before-run=false exec biome check --write apps/backend/src/manifest/assemble.ts
```

Both passed and formatted only owned files.

## Remaining verification

- The complete backend suite needs a run where local HTTP listeners are allowed.
- PostgreSQL and MariaDB round-trip assertions are included in the existing conditional adapter matrix,
  but were not executed. `CAELESTIS_TEST_POSTGRES_URL` and `CAELESTIS_TEST_MARIADB_URL` are unset.
  Their migrations have not been applied to real PostgreSQL or MariaDB instances in this session.
- Validation used installed pnpm 11.25.0, not the repository-requested pnpm 12.3.4.
- No frontend or userscript integration was exercised here; those files belong to the other engineer.
