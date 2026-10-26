---
title: Contributing
---

For bugs, include steps that reproduce the problem. For a larger feature, open an issue before implementing it so its scope can be discussed.

[Choose an issue type](https://github.com/mia-cx/Caelestis/issues/new/choose).

![The repository's issue forms.](images/contributing/issue-forms.png)

## Local development

Clone your fork and install the repository's pinned pnpm version. The package declares Node.js 22.19 or newer; portable builds use the version pinned in the Dockerfile.

~~~sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
~~~

The development tasks start the applications and userscript tooling. For one app:

~~~sh
pnpm --filter @caelestis/frontend dev
~~~

See [the source README](https://github.com/mia-cx/Caelestis#development) for current development setup and [Self-hosting](Self-hosting) for the portable server.

## Checks

Run the focused tests for your change first. Before opening a pull request, run the applicable repository checks:

~~~sh
pnpm lint
pnpm check
pnpm test
pnpm build
~~~

For userscript UI changes, test the built script on Wplace. Include screenshots or a recording of the changed behaviour.

## Release notes

Add one Changeset for each user-visible change:

~~~sh
pnpm changeset
~~~

Target the affected deployable apps: userscript, frontend, or backend. Do not target shared, UI, or wire-schema packages.

Documentation-only changes do not need a Changeset.

## Pull requests

Keep the change focused. Explain the problem, the change, and the checks you ran. Link the issue with `Closes #N` when the pull request completes it.

Use a conventional title, such as `fix(userscript): preserve template placement`. Rebase on current main and allow maintainer edits for a fork.

Follow the [Code of Conduct](https://github.com/mia-cx/Caelestis/blob/main/CODE_OF_CONDUCT.md). Report security problems through the [security policy](https://github.com/mia-cx/Caelestis/security/policy), not a public issue.
