# Frontend, UI, and tooling behavior map

First map derived from production code before reading inherited assertions. Rows describe planned coverage, not passing evidence.
Paths are relative to the repository root. Integration includes DOM interactions; real layout/canvas work needs Chromium.

## Planned suites

- Frontend history/tree/image contracts and API/session/SSR integration with real internal modules.
- UI composed interactions: tree navigation/rename/menu/drop, appearance ownership/preview/commit, work/claims, settings, notifications and panel lifecycle.
- Tooling release artifacts/identity/notes and resource ownership, plus real raster recount/social output.
- Extended checks for portable runtimes, database/storage services, browser layout/GPU, and stack/load behavior.

## Replacement evidence

The fresh frontend suite has 24 cases across four contract files. It exercises the real client against
the backend package, stale credentials and late responses, history/progress calculations, and server
proxy/SSR/storage routes. Raster cases decode actual GIF output with Sharp and compare visible frames
and playback duration. The shared PNG codec supplies real saved artwork to the rendering pipeline.

The UI suite mounts real Svelte components and its registered custom element. Its ten cases cover
tree keyboard/rename/menu intents, appearance ownership, claims/work pending and refusal states,
settings resets, notifications, and panel resizing. See [UI evidence](ui-evidence.md).

The inventory below records the initial candidates. Thin presentation wrappers use composed component
tests and Svelte checks. Layout, native browser input synthesis, and GPU behavior belong to the
separate [Chromium boundary checks](browser-evidence.md); there are no CSS-class or icon snapshots.

## Module inventory

| Module | Boundary | Contract or exclusion reason |
| --- | --- | --- |
| `.github/scripts/check-userscript-release-notes.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/post-release.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/prepare-app-release.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/prepare-portable-release.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/prepare-userscript-release.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/pullfrog-project.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/release-merge.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/release-notes.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `.github/scripts/userscript-metric-versions.mjs` | Integration | Release artifact bytes/notes/digests, immutable pending notes, exact release identity; triage preserves existing fields and verifies writes against strict API responses. |
| `apps/frontend/node/main.mjs` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/node/server.mjs` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/app.d.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `packages/social/src/gifenc.d.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `apps/frontend/src/hooks.server.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/lib/api/client-metrics.ts` | Integration | HTTP credential boundary, configured/selected server isolation, version fallback, retry refusal, blob lifetime, live protocol negotiation. |
| `apps/frontend/src/lib/api/client.ts` | Integration | HTTP credential boundary, configured/selected server isolation, version fallback, retry refusal, blob lifetime, live protocol negotiation. |
| `apps/frontend/src/lib/components/stats/archive-history.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `apps/frontend/src/lib/components/stats/completion-pace.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `apps/frontend/src/lib/components/ColourProgress.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/ConnectDialog.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/FolderSection.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/Leaderboard.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/SocialMetadata.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/StatsPanel.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/TemplateCanvas.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/TemplateCard.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/TemplateViewer.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/ContributionHeatmap.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/PacePicker.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/PainterPicker.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/ProgressPaceChart.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/stats/progress-pace.ts` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/lib/components/ui/select/index.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `apps/frontend/src/lib/components/ui/select/select-content.svelte` | Declarative | Vendored presentation wrappers; check/build and consuming component interactions. Do not retest the upstream library. |
| `apps/frontend/src/lib/components/ui/select/select-item.svelte` | Declarative | Vendored presentation wrappers; check/build and consuming component interactions. Do not retest the upstream library. |
| `apps/frontend/src/lib/components/ui/select/select-trigger.svelte` | Declarative | Vendored presentation wrappers; check/build and consuming component interactions. Do not retest the upstream library. |
| `packages/social/src/osm-geometry.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `apps/frontend/src/lib/persisted.svelte.ts` | Integration | Real API client and reactive state: bootstrap, latest load wins, auth refusal, socket reconciliation/reconnect/stop, persisted preference recovery. |
| `apps/frontend/src/lib/components/stats/progress-history.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `apps/frontend/src/lib/render.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `apps/frontend/src/lib/server/backend.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/lib/server/social-images.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/lib/server/social.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `packages/social/src/attribution.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `packages/social/src/basemap.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `packages/social/src/gif.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `packages/social/src/image.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `packages/social/src/render.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `packages/social/src/playback.ts` | Unit | Production-derived history/pace/tree/render contracts; real raster encode/decode for image boundaries, no algorithm-mirroring assertions. |
| `packages/social/src/refresh.ts` | Integration | Shared refresh loop; exercised through the Cloudflare Queue consumer and the Node worker thread. |
| `apps/frontend/src/lib/state/app.svelte.ts` | Integration | Real API client and reactive state: bootstrap, latest load wins, auth refusal, socket reconciliation/reconnect/stop, persisted preference recovery. |
| `apps/frontend/src/routes/+layout.server.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/routes/+layout.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/routes/+layout.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/routes/+page.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/routes/api/[...path]/+server.ts` | Integration | HTTP credential boundary, configured/selected server isolation, version fallback, retry refusal, blob lifetime, live protocol negotiation. |
| `apps/frontend/src/routes/folder/[id]/+page.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `apps/frontend/src/routes/social/template/[id].gif/+server.ts` | Integration | SSR/proxy/storage boundary: public metadata, publication checks, conditional reads, credential stripping, partial recovery and portable environment wiring. |
| `apps/frontend/src/routes/artwork/[id]/+page.svelte` | Integration | Mounted page/component interactions and displayed state; actual canvas/layout/timelapse behavior belongs to separate browser validation. |
| `packages/ui/src/appearance/AppearanceEditor.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/appearance/ColourInput.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/backfill/Backfill.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/backfill/model.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `packages/ui/src/claim/ClaimMode.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/elements/Backfill.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/ClaimMode.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/Notifications.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/OverlayControls.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/PaletteProgress.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/Panel.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/RailControl.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/ShortcutHelp.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/TagManager.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/TemplateAdmin.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/TemplateState.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/Work.element.svelte` | Integration | Custom element model properties and composed intent events through the real mounted element. |
| `packages/ui/src/elements/index.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `packages/ui/src/foundations/Button.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/Checkbox.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/Icon.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/MenuStyles.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/SectionHeader.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/SettingRow.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/SliderRow.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/Toggle.svelte` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/foundations/icons.ts` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/index.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `packages/ui/src/notifications/Notifications.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/overlay/OverlayControls.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/panel/Panel.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/progress/ColourProgress.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/progress/PaletteProgress.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/progress/ProgressMeter.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/rail/RailControl.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/settings/SettingsPanel.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/shortcut-help/ShortcutHelp.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/shortcut-help/actions.ts` | Integration | Labels and control semantics exercised through composed UI interactions; icons/styles require no standalone assertions. |
| `packages/ui/src/tags/TagManager.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/template-admin/TemplateAdmin.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/template-state/TemplateLifecycle.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/template-state/TemplateState.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/theme.ts` | Integration | Theme application exposes the selected mode and updates host styling. |
| `packages/ui/src/tree/FilterMenu.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/ProgressDetails.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/SortMenu.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/TagFilter.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/TemplateClaims.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/TemplatePreview.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/TemplateTree.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/tree/preview-pixels.ts` | Unit | Bounded preview preserves palette colours, transparency and nearest source pixels. |
| `packages/ui/src/types.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `packages/ui/src/work/WorkBoard.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/work/WorkSummary.svelte` | Integration | Mounted component emits public intents and exposes accessible controls for its model; pending/refusal and cleanup where applicable. |
| `packages/ui/src/work/model.ts` | Declarative | Type declarations and export wiring; package check/build resolves consumers. No standalone execution assertions. |
| `scripts/benchmark-social-gifs.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/benchmark-wplace-collaboration.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/dev-tunnel.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/enable-stack-ci-gate.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/osm-tiles.mjs` | Integration | Real binary/template input through recount or GIF output; external HTTP/storage controlled at boundary. |
| `scripts/recount-progress.mjs` | Integration | Real binary/template input through recount or GIF output; external HTTP/storage controlled at boundary. |
| `scripts/runtime-benchmark/kubernetes.mjs` | Integration | Resource accounting and cleanup only affect owned resources; injected CLI boundary cannot delete replaced references. |
| `scripts/runtime-benchmark/miniflare-server.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/runtime-benchmark/run.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/runtime-benchmark/server.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/runtime-benchmark/traffic.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/set-frontend-read-token.sh` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/setup-stack-ci.sh` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/social-images.mjs` | Integration | Real binary/template input through recount or GIF output; external HTTP/storage controlled at boundary. |
| `scripts/stack-tests/acceptance.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/stack-tests/cloudflare-config.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/stack-tests/image-references.mjs` | Integration | Resource accounting and cleanup only affect owned resources; injected CLI boundary cannot delete replaced references. |
| `scripts/stack-tests/k3s-images.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/stack-tests/kubernetes-run.mjs` | Integration | Resource accounting and cleanup only affect owned resources; injected CLI boundary cannot delete replaced references. |
| `scripts/stack-tests/prepare-baseline.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/stack-tests/process.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/stack-tests/wplace.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/sync-capacity.mjs` | Unit | Published capacity accounting arithmetic separates required telemetry traffic and avoidable reads. |
| `scripts/test-cloudflare-remote.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/test-cloudflare-stack.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/test-helm-stack.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/test-portable-compose.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
| `scripts/test-portable-image.mjs` | Integration (extended) | Explicit development/deployment/benchmark command; verified with isolated runtime/stack acceptance when relevant. No source-text assertions or live infrastructure in default suite. |
