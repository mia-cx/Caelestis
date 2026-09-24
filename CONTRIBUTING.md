# Contributing to Caelestis

Thank you for helping improve Caelestis. By participating, you agree to follow the
[Code of Conduct](CODE_OF_CONDUCT.md). Report vulnerabilities through the
[security process](SECURITY.md), not a public issue.

## Before you start

Search the issue tracker before opening a report. For a larger change, open an issue first so its
behavior and scope are clear. Keep each issue and pull request focused on one coherent change.

## Local setup

Caelestis requires Node.js 22.13 or newer. Corepack installs the pnpm version pinned in
`package.json`.

```sh
corepack enable
pnpm install
pnpm dev
```

`pnpm dev` starts the backend, frontend, and userscript tasks. Cloudflare credentials are optional
for local development. Use a package filter when you only need one app:

```sh
pnpm --filter @caelestis/frontend dev
```

## Checks

TypeScript packages use the native TypeScript 7 compiler. The Svelte packages also install
TypeScript 6 because `svelte-package` and Svelte transforms require its JavaScript compiler API.
Their `svelte-check --tsgo` commands use the TypeScript 7 alias `@typescript/native` for diagnostics.
Keep this [upstream-supported setup](https://github.com/sveltejs/language-tools/tree/master/packages/svelte-check#typescript-7-supports)
until Svelte declaration generation supports the native compiler API.

The root test command runs one package at a time. Each Vitest process already parallelizes its
files; competing worker pools distort the rasterization timing assertions.

Run focused tests while you work. Before opening a pull request, run every full check affected by
the change:

```sh
pnpm lint
pnpm check
pnpm test
pnpm build
```

## Release notes

Run `pnpm changeset` for each atomic, user-visible change. Target every affected deployable app:
userscript, frontend, or backend. Do not target shared, ui, or wire-schema directly. Documentation,
tests, and internal maintenance do not need a Changeset.

## Pull requests

- Link the issue the pull request completes with `Closes #N`.
- Use a conventional title such as `fix(userscript): preserve template placement`.
- Rebase on the latest `main` and keep unrelated changes out of the branch.
- Describe the problem, the outcome, and the checks you ran.
- Include before and after evidence for visual changes.
- Allow maintainer edits on pull requests from forks.
