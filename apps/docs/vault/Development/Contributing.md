---
title: Contributing
---

Report a bug, propose a feature or test a change in your own checkout. Include steps to reproduce a bug. For a larger feature, agree on the scope in an issue first.

[Choose an issue type](https://github.com/mia-cx/Caelestis/issues/new/choose).

![The repository's issue forms.](images/contributing/issue-forms.png)

## Local development

Clone your fork. Use Node.js 22.19 or later and the pnpm version in `package.json`.

~~~sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
~~~

To run only the dashboard, select the frontend package.

~~~sh
pnpm --filter @caelestis/frontend dev
~~~

See [the contribution guide](https://github.com/mia-cx/Caelestis/blob/main/CONTRIBUTING.md) for current development setup and [Self-hosting](Self-hosting) for the portable server.

## Checks

Run the focused tests for your change first. Before opening a pull request, run the checks affected by your change.

~~~sh
pnpm lint
pnpm check
pnpm test
pnpm build
~~~

For userscript UI changes, test the built script on Wplace. Include screenshots or a recording of the changed behaviour.

## Release notes

Run `pnpm changeset` once for each user-visible change.

~~~sh
pnpm changeset
~~~

Target each affected deployable app. The userscript package also covers the extension. The frontend and backend have their own versions. Do not target shared, UI, or wire-schema packages.

Documentation-only changes do not need a Changeset.

## Pull requests

Keep the change focused. Explain the problem, the change, and the checks you ran. Use `Ships #N` when the pull request adds a Changeset. The release pull request closes the issue. For a completed change without a Changeset, use `Closes #N`.

Use a conventional title, such as `fix(userscript): preserve template placement`. Rebase on `main`. Allow maintainer edits for a fork and state the PR's [0rwx level](https://0rwx.com).

Follow the [Code of Conduct](https://github.com/mia-cx/Caelestis/blob/main/CODE_OF_CONDUCT.md). Report security problems through the [security policy](https://github.com/mia-cx/Caelestis/security/policy), not a public issue.
