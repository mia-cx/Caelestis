# #511 Preserve template source recipes and cache processed artwork

## Summary

Keep a template's original PNG and the exact processing recipe beside its processed palette
indices, locally and on servers. Normal loads use the processed artwork and never reprocess. A
versioned `.caelestis` container carries source, recipe, placement and artwork between clients.

## Design

- `TemplateRecipe` (shared): processor name and version, source SHA-256 and size, output size,
  colour metric, dithering, legacy decode, explicit palette indices. Account presets resolve to
  the indices actually used. `recipeIdentity` is the SHA-256 of its canonical JSON, so a change to
  source, any setting, palette or processor version is a different identity.
- Processing has one entry point, `processSource(source, recipe, placement)`. Import builds the
  recipe first and then processes, so recovery reruns the same function.
- Local: `authoring = { source: Blob, recipe, artwork }` sits on the template record. `artwork` is
  the SHA-256 of the indices that recipe produced. Authoring counts only while the current indices
  still hash to it, so edited pixels never travel with a stale recipe.
- Server: each immutable version may carry `source_hash` (blob in the new `sources` namespace) and
  `recipe_json`, written in the same batch as the version row and chunks. Clients generate
  artwork; servers store it. Chunks and source are uploaded before the version row, so a partial
  upload never becomes current.
- Missing or corrupt artwork is rebuilt from source and recipe. Without a usable processor the
  record is kept, never discarded and never shown with mismatched pixels.

## Acceptance criteria

- [ ] Export/import round trips preserve source bytes, recipe, placement, and processed pixels.
- [ ] Reloading a local template with a valid cache invokes no processing.
- [ ] A fresh client loading a server template receives the cached processed result and invokes no processing.
- [ ] Servers durably retain authoring inputs and the processed artifact; server export/restore preserves both.
- [ ] Source, resize, dither, quantisation, palette, or processor-version changes produce a new identity and version.
- [ ] Corrupt or missing artifacts recover without discarding the source or serving mismatched pixels.
- [ ] Format versioning, size limits, legacy compatibility, and deterministic fixtures cover local and server paths.

## TODOs

- [x] Shared recipe type, validation, canonical identity, and unit tests.
- [x] Backend: per-version source and recipe columns (SQLite, Postgres, MariaDB), `sources` blobs, create and replace parts, authoring read routes, contract tests.
- [ ] Userscript: recipe-driven processing for PNG and `.wplace` imports, authoring on local records, recovery on load.
- [ ] Userscript: `.caelestis` container export and import.
- [ ] Userscript: upload authoring with server templates and fetch it for server export.
- [ ] Changesets, docs, and affected checks.

## Notes

- Marble imports stay processed-only: their source is a set of pre-quantised tiles, not one image.
- Lane G (#350) owns full server export/restore. If it lands first, its archive must carry the
  `sources` namespace and the new version columns.
