# Testing

Read [TESTING.md](TESTING.md) when adding, changing, or reviewing tests, or choosing validation for a change.

# Browser development

Wplace does not work in the T3 Code browser. Use `Chromium.app` in debug mode for all Wplace
browser work. The `pnpm dev` command starts this browser, but the user likely already has one
running. Check for an existing debug Chromium browser before starting another one.

For background CDP profiles, hold a persistent session with
`Emulation.setFocusEmulationEnabled({ enabled: true })` so `requestAnimationFrame` stays active.
Chromium removes the override when that session closes.

# App release notes

Add one new Changeset file for each atomic, user-visible change. Target every affected deployable
app: userscript, frontend, or backend. Never target shared, ui, or wire-schema. Use one short summary
sentence. Add nested bullets only for closely related parts of the same change. Keep pending
Changeset files immutable so each released top-level bullet stays linked to its own commit.

<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->
