# App releases

The userscript, frontend, and backend share one Changesets release pull request. Each app keeps its
own version and changelog. Merging the generated pull request publishes the releases.

## Add a release note

Run `pnpm changeset` in a pull request with a user-visible change. Select every deployable app whose
users can see the change:

- `@caelestis/userscript` owns changes visible in the installed userscript or browser extension.
  Both builds share its version.
- `@caelestis/frontend` owns changes visible on the dashboard.
- `@caelestis/backend` owns user-visible API or server behavior changes.

The internal `shared`, `ui`, and `wire-schema` packages stay unversioned. Never select them in a
Changeset. Record their user-visible changes against every affected app instead. For example, a UI
component change bundled into both the userscript and frontend targets both deployable apps.

Choose each app's SemVer bump and write one short sentence for users. One Changeset can target
multiple deployable apps. Pull-request CI rejects a Changeset that mixes an ignored internal
package with a versioned app.

Changes that only affect tests, CI, or internal code do not need a changeset.

The docs site in `apps/docs` is unversioned too. Docs changes need no changeset; each release
deploys the docs from its merge commit, so they describe the deployed apps.

## Publish

After a Changeset reaches `main`, the App release workflow opens or updates one release pull
request. That pull request consumes pending Changesets and updates each affected app's package and
changelog independently. Ordinary merges to `main` do not deploy or publish. The release PR stays
open until a maintainer chooses to merge it.

Merging the release pull request publishes `userscript-vX.Y.Z` after the userscript's own build,
typecheck, and tests pass. It remains the repository's latest release and includes both installers,
`caelestis-extension.zip`, `caelestis-extension-source.zip`, and their checksums. The userscript
runs without Caelestis servers, so it does not wait for deployment.

The extension zip is one MV3 package for Chrome, Edge, and Firefox. The source archive is the
release commit plus `apps/userscript/build-revision.json` and `BUILD-EXTENSION.md`, so
addons.mozilla.org rebuilds the same files from it without Git. Every Userscript CI run builds both
zips as an artifact.

A new userscript release then submits the extension to each store with credentials in the
`extension-stores` environment and skips the rest:

- Chrome Web Store: `CHROME_SERVICE_ACCOUNT_KEY`, `CHROME_PUBLISHER_ID`, `CHROME_ITEM_ID`. A
  submission still in review is cancelled in favour of the new one.
- Microsoft Edge Add-ons: `EDGE_PRODUCT_ID`, `EDGE_CLIENT_ID`, `EDGE_API_KEY`. The API key expires;
  the job warns when Edge rejects it. A store still reviewing the previous version is skipped.
- addons.mozilla.org: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`. Skipped until the listing exists.

Each store publishes the version once its review approves it. The first Chrome and Edge listings
are made by hand, which is where `CHROME_ITEM_ID` and `EDGE_PRODUCT_ID` come from.

The same merge runs the production checks and deploys its exact merge commit. Only after deployment
succeeds does the workflow publish the server app tags:

- `frontend-vX.Y.Z` tags the deployed commit and posts to `DISCORD_RELEASE_WEBHOOK_URL`.
- `backend-vX.Y.Z` tags the deployed commit and does not post to Discord.

Semantic app versions describe releases. Production deployments still use the exact deployment
commit from `github.sha` as their operational build identity.

## Repository setting

GitHub Actions must be allowed to create pull requests. Enable this once under repository Settings,
Actions, General, Workflow permissions. Configure `DISCORD_RELEASE_WEBHOOK_URL` for both userscript
and frontend announcements.
