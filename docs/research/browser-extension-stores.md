# #686 Browser extension store rules and publishing APIs

Research date: 2026-10-31

This note records what the Chrome Web Store, Firefox Add-ons (AMO), and Microsoft Edge Add-ons
require of a Manifest V3 Caelestis extension, and how far each store's publishing step can run from
CI. The planned extension has a `"world": "MAIN"` content script at `document_start` on
`https://wplace.live/*`, an isolated-world content script that bridges to `chrome.storage.local`,
and page-world `fetch` calls to user-chosen servers. Every fact below cites the store's or browser
vendor's own documentation. Sections headed "Strong inferences" and "Remaining unknowns" are
labelled as such.

## Short answer

All three stores accept the planned design. Minified and bundled code is allowed everywhere, as
long as it is not obfuscated. All code must ship in the package, including the Ditherette WASM and
worker sources. AMO also needs a source archive whose build reproduces the submitted files byte for
byte. `world: "MAIN"` in a manifest content script needs Chrome and Edge 111 and Firefox 128.
Firefox's built-in data-consent manifest key raises the practical floor to Firefox 140 on desktop
and 142 on Android. Each store requires a privacy policy, because the extension sends user data off
the device. No store bans extensions that modify a third-party site.

CI can publish updates to all three stores. Chrome and Edge cannot create a new item through their
APIs, so the first listing is made by hand in their dashboards. `web-ext sign` can create the AMO
listing from CI when the run supplies listing metadata.

## Primary sources

Chrome Web Store and Chrome extensions:

- [MV3 additional requirements (remote code)][cws-mv3]
- [Code readability requirements][cws-readability]
- [Program policies][cws-policies]
- [User data FAQ][cws-userdata]
- [Fill out the privacy fields][cws-privacy]
- [Chrome Web Store review process][cws-review]
- [Publish in the Chrome Web Store][cws-publish]
- [Use the Chrome Web Store API][cws-api-use]
- [Chrome Web Store API overview][cws-api]
- [Chrome Web Store API v2 REST reference][cws-api-rest]
- [Use a service account with the Chrome Web Store API][cws-sa]
- [Introducing a new Chrome Web Store API (blog, 2025-10-15)][cws-v2-blog]
- [Manifest `content_scripts` reference][cr-cs-manifest]
- [Content scripts][cr-cs-concept]
- [`chrome.extensionTypes` reference][cr-exectypes]
- [`chrome.scripting` reference][cr-scripting]
- [Cross-origin network requests][cr-network]

Firefox and AMO:

- [Add-on Policies][amo-policies] (source:
  [extension-workshop `add-on-policies.md`][amo-policies-src]), and the
  [preview effective 2026-12-01][amo-policies-preview]
- [Source code submission][amo-source]
- [Third-party library usage][amo-thirdparty]
- [Firefox built-in data collection consent][ff-consent]
- [Manifest V3 migration guide][ff-mv3]
- [Developing extensions for Firefox for Android][ff-android]
- [Submitting an add-on][amo-submit]
- [Signing and distribution overview][amo-signing]
- [web-ext command reference, `web-ext sign`][webext-sign]
- MDN: [`content_scripts`][mdn-cs], [Content scripts][mdn-content-scripts],
  [`background`][mdn-background], [`browser_specific_settings`][mdn-bss],
  [`host_permissions`][mdn-host]
- [MDN browser-compat-data, `content_scripts.json`][bcd-cs]

Microsoft Edge Add-ons:

- [Developer policies for the Microsoft Edge Add-ons website][edge-policies]
- [Publish a Microsoft Edge extension][edge-publish]
- [Use the REST API to update an extension][edge-api]

## Confirmed facts

### 1. Remote code, minified code, and source submission

**Chrome.** In MV3, "the full functionality of an extension must be easily discernible from its
submitted code" and its logic "should be self contained". The examples of violations are a
`<script>` tag pointing outside the package, `eval()` of a fetched string, and an interpreter for
remotely fetched commands ([MV3 requirements][cws-mv3]). Syncing account data with a remote server
and fetching non-logic resources such as images remain allowed ([MV3 requirements][cws-mv3]).
"Developers must not obfuscate code". Minification is allowed, including whitespace removal,
shortened names, and "Collapsing files together" ([code readability][cws-readability]). The Privacy
tab asks whether the extension uses remote code. An extension that uses remote code without
declaring and justifying it there is rejected ([privacy fields][cws-privacy]). Chrome has no
source-upload step.

**Firefox.** "Add-ons must be self-contained and not load remote code for execution" (policy §4.2).
Add-ons "may contain transpiled, minified or otherwise machine-generated code, but Mozilla needs to
review a copy of the source code" (§3.1). Dependencies must be in the source package or "downloaded
only through the respective official package managers during the build process". Unmaintained build
tools are not accepted (§3.1) ([policies][amo-policies-src]). The [source code
submission][amo-source] page adds these requirements:

- Source is required for minifiers, for tools that "generate a single file from other files", and
  for any custom pre-processing. It must be attached to every version.
- The reviewer rebuilds and "uses a diff tool to compare the generated sources to those in the
  extension. There must be no differences."
- The README must give OS and environment requirements, tool versions with install steps, and "a
  list of all the commands to generate an identical copy". A build script is preferred.
- Include the lockfile. Build tools must be open source and must not be web-based.
- The default reviewer environment is Ubuntu 24.04.4 LTS on ARM64, with Node 24.14.0 and npm
  11.9.0. Any difference must be stated in the README.
- The source archive can be at most 200 MB.

Third-party libraries must be release versions, and "Modifications to these libraries/frameworks
are not permitted" (§4.8). Private or non-public packages must ship their `node_modules`
subdirectories in the source archive ([third-party libraries][amo-thirdparty]).

**Edge.** "Extensions with obfuscated code aren't allowed". This also covers "any external code or
resource fetched from the web" (§1.1.7, [Edge policies][edge-policies]). "In Manifest V3, loading
and executing remotely hosted code is not permitted". Partner Center's Privacy page has an "Are you
using remote code?" declaration ([Edge publish][edge-publish]). The Edge docs mention no
minification rule and no source-upload step.

### 2. `world: "MAIN"` support, minimum versions, and Firefox MV3 differences

| Browser | Manifest `content_scripts[].world` | Source |
| --- | --- | --- |
| Chrome | 111 (`ExecutionWorld` is "Chrome 111+") | [extensionTypes][cr-exectypes], [BCD][bcd-cs] |
| Edge | Mirrors Chrome, so 111 | [BCD][bcd-cs]. Not documented on learn.microsoft.com |
| Firefox desktop | 128 | [BCD][bcd-cs] |
| Firefox for Android | Mirrors desktop, so 128 | [BCD][bcd-cs] |

The Chrome manifest reference says "MAIN" means sharing "the execution environment with the host
page's JavaScript" and warns that "The host page can access and interfere with the injected script"
([manifest content scripts][cr-cs-manifest]). In the main world, "the CSP of the page applies"
([content scripts][cr-cs-concept]). The older `scripting` paths have different floors:
`executeScript` with `world` needs Chrome 95, and `registerContentScripts` with `world` needs Chrome
102 ([scripting][cr-scripting]). MDN says scripts in the `MAIN` world "don't have any access to the
APIs that are only available to content scripts" ([MDN `content_scripts`][mdn-cs]).
`document_start` is supported in all three browsers ([BCD][bcd-cs]).

Firefox MV3 differences that matter:

- **Background.** Firefox does not support `background.service_worker`. It runs `background.scripts`
  as an event page. A manifest that lists both keys works in Chrome 121+ and Firefox 121+
  ([MDN `background`][mdn-background]).
- **Add-on ID.** `browser_specific_settings.gecko.id` is "required for signing Manifest V3
  extensions; AMO does not assign an ID" ([MDN `browser_specific_settings`][mdn-bss]). Firefox for
  Android gets the extension only if `gecko_android` is present, even as `{}`. Signatures are only
  recognised from Firefox 128, or 115 ESR ([MDN `browser_specific_settings`][mdn-bss]).
- **Host permission grants.** "From Firefox 127, host permissions listed in `host_permissions` and
  `content_scripts` are displayed in the install prompt and granted on installation." New host
  permissions added in an update are not shown to the user. Users can revoke any host permission at
  any time, so the extension should check and request what it needs
  ([MV3 migration guide][ff-mv3], [MDN `host_permissions`][mdn-host]).
- **Android.** Firefox for Android shows no indicator for a pending `host_permissions` grant, and
  users cannot edit grants in its Add-ons Manager. Mozilla therefore recommends Manifest V2 for
  extensions that target Android ([Firefox for Android][ff-android]).

### 3. Host permissions and user-chosen servers

**Chrome.** Policy: "Request access to the narrowest permissions necessary"
([policies][cws-policies]). The Privacy tab has a justification field for each permission
([privacy fields][cws-privacy]). Broad host patterns such as `<all_urls>` can make review take
longer ([review process][cws-review]). A manifest content script on `https://wplace.live/*` is a
narrow match.

**Firefox.** "Add-ons must only request those permissions that are necessary" (§4.1,
[policies][amo-policies-src]). Content-script match patterns appear in the install prompt from
Firefox 127 ([MV3 migration guide][ff-mv3]).

**Edge.** Request "only those permissions that are necessary" (§1.6, [Edge policies][edge-policies]).
Partner Center asks for a justification of each permission ([Edge publish][edge-publish]).

**User-chosen servers from the page world.** Content scripts "are also subject to the same origin
policy", and "Cross-origin requests are always treated as such in content scripts, even if the
extension has host permissions" ([Chrome network requests][cr-network]). MDN says the same for
Firefox MV3: content scripts may make cross-origin requests "when the destination server opts in
using CORS", but "host permissions don't work in content scripts"
([MDN content scripts][mdn-content-scripts]). A `fetch` from the page world to a user-chosen
server therefore needs no manifest permission. The server must answer with CORS headers, as it does
for the userscript today. The Edge docs do not cover this separately.

### 4. Privacy policy and data disclosure

**Chrome.** "If your Product handles any user data, then you must post an accurate and up to date
privacy policy" covering collection, use, sharing, and "All parties the user data will be shared
with" ([policies][cws-policies]). User data includes usernames, "Authentication information",
"Website content and resources", and web history ([user data FAQ][cws-userdata]). The extension
must transmit user data "over a secure connection (e.g. HTTPS, WSS)". Prominent disclosure and
consent "must occur within the Product's user interface"; text in the store listing does not count
([user data FAQ][cws-userdata]). The Privacy tab collects the single purpose, the data-type
checkboxes, the limited-use certification, and the policy URL ([privacy fields][cws-privacy]). The
FAQ exempts traffic to a "user-specified server" only for clients of internet protocols such as FTP
or IRC ([user data FAQ][cws-userdata]).

**Firefox.** Add-ons must limit transmission to what their function needs. Transmission means
"any data that is collected, used, transferred, shared, or handled outside of the add-on or the
local browser" (§6, [policies][amo-policies-src]). "From November 3, 2025, all new extensions must
adopt the Firefox built-in data collection consent system" through
`browser_specific_settings.gecko.data_collection_permissions`. That system works in Firefox 140+ on
desktop and 142+ on Android ([built-in consent][ff-consent]). The `required` list holds `none` or
data types such as `authenticationInfo`, `personallyIdentifyingInfo`, `websiteContent`, and
`websiteActivity` ([MDN `browser_specific_settings`][mdn-bss]). An add-on that supports Firefox 139
or earlier must build its own unmissable consent page (§6.2.2, [policies][amo-policies-src]).
Transport must be encrypted (§4.5). At submission, "if any data is being transmitted from the
user's device, a privacy policy explaining what is being sent and how it's used is required"
([submitting an add-on][amo-submit]).

**Edge.** Personal information may be transmitted "only if required by and only for use in a
prominently disclosed, user-facing feature". A "clear and comprehensive privacy policy" is required
(§1.5.1–1.5.2). Data must be sent with "modern and secure cryptography" (§1.5.5). §1.5.3 allows
sharing user data with a third party only after opt-in consent in the extension UI. It limits that
sharing to "your third-party service providers solely for user-facing product improvement and
product analytics" ([Edge policies][edge-policies]). Partner Center requires a privacy policy URL
"if the extension collects any privacy information" ([Edge publish][edge-publish]).

### 5. Modifying a third-party site, and review times

**Third-party site policy.** None of the three stores bans extensions that change how another site
looks or behaves.

- Chrome forbids content that "harms or interferes with the operation of the networks, servers, or
  other infrastructure of Google or any third-parties". It also says "Do not facilitate
  unauthorized access to content on websites" ([policies][cws-policies]).
- Firefox counts "unexpected changes to web content" as an unexpected feature only when the change
  is unrelated to the primary function and not clear from the name or description. Such features
  must be disclosed and opt-in (§1.1, [policies][amo-policies-src]).
- Edge excludes any extension "that performs automated actions to manipulate a platform's
  features". It also forbids providing "unauthorized access to website content" (Building
  quality products, §2.8, [Edge policies][edge-policies]).

**Review times.**

| Store | Documented time | Source |
| --- | --- | --- |
| Chrome | "within a few days, but it can take up to a few weeks"; contact support after three weeks. New developers, new extensions, and broad host permissions take longer. Deferred publishing gives 30 days to publish after approval, then the submission reverts to a draft. | [review process][cws-review], [publish][cws-publish] |
| Firefox | Automated validation, then "up to 24 hours for your submission to be signed and published, or longer if your submission is selected for manual review". Any version can be manually reviewed later. | [signing overview][amo-signing] |
| Edge | "up to seven business days" | [Edge publish][edge-publish] |

### 6. Publishing APIs for CI

**Chrome Web Store API v2.**

- v2 has been current since October 2025. Google planned to support v1 "until 15th October 2026",
  which has passed ([v2 blog][cws-v2-blog], [API overview][cws-api]).
- Endpoints under `https://chromewebstore.googleapis.com`: `upload`, `publish`, `fetchStatus`,
  `cancelSubmission`, `setPublishedDeployPercentage`, and `rollback`
  ([REST reference][cws-api-rest]).
- "The new API does not support creating new items", and it cannot change visibility
  ([v2 blog][cws-v2-blog]). `publishType: STAGED_PUBLISH` holds an approved item for a manual
  release ([v2 blog][cws-v2-blog]).
- Credentials: a Google Cloud project with the API enabled, the publisher ID, and the OAuth scope
  `https://www.googleapis.com/auth/chromewebstore`. Authenticate with either an OAuth client ID,
  secret, and refresh token, or a service account. A publisher can link only one service account
  ([using the API][cws-api-use], [service accounts][cws-sa]).
- By hand first: 2-step verification on the Google account, the first upload through "Add new
  item", and the Store listing and Privacy tabs. After any visibility change in the dashboard, one
  manual publish is needed before the API can publish again
  ([using the API][cws-api-use], [publish][cws-publish]). New publishers are limited to two
  published extensions ([publish][cws-publish]).

**AMO via `web-ext sign` (add-on API v5).**

- `web-ext sign --channel listed` creates the AMO listing if it does not exist yet, and adds a
  version otherwise ([web-ext sign][webext-sign]).
- Credentials: a JWT issuer and secret from the AMO API key page, passed as `--api-key` and
  `--api-secret` or `WEB_EXT_API_KEY` and `WEB_EXT_API_SECRET` ([web-ext sign][webext-sign]).
- The first listed version needs `--amo-metadata` with at least `summary`, `categories`, and
  `version.license`. Updates may add `approval_notes` ([web-ext sign][webext-sign]).
- `--upload-source-code` attaches the source archive. `--approval-timeout` defaults to 15 minutes;
  `0` disables the wait ([web-ext sign][webext-sign]).
- The Add-on Create and Version Create APIs are the direct alternative
  ([signing overview][amo-signing]).

**Edge Add-ons API v1.1.**

- Root `https://api.addons.microsoftedge.microsoft.com`. Endpoints: upload a package to the draft
  (`POST /v1/products/{productID}/submissions/draft/package`), check the upload operation, publish
  (`POST /v1/products/{productID}/submissions` with certification notes), and check the publish
  operation ([Edge API][edge-api]).
- Credentials: a Client ID and an API key, sent as `Authorization: ApiKey …` and `X-ClientID`.
  Both are created on Partner Center's Publish API page, and each key shows an expiry date. v1,
  which used client secrets, ended on 2024-12-31 ([Edge API][edge-api]).
- There are no endpoints for "Creating a new product" or "Updating a product's metadata". "To
  initially publish a new extension, you use Partner Center" ([Edge API][edge-api]).

## Strong inferences for Caelestis

### Build target

- One MV3 manifest can serve all three browsers. The design needs no background context: the
  isolated-world bridge can call `chrome.storage.local` directly. Leaving `background` out avoids
  the Chrome service worker versus Firefox event page split ([MDN `background`][mdn-background]).
- Set `gecko.strict_min_version` to `140.0` and `gecko_android.strict_min_version` to `142.0`. These
  floors cover `world: "MAIN"` (128) and let the extension use Firefox's built-in consent instead
  of a custom consent page ([built-in consent][ff-consent], [policies §6.2][amo-policies-src]).
  Chrome and Edge need 111 as `minimum_chrome_version` ([BCD][bcd-cs]).
- Request only the `storage` permission and a content-script match on `https://wplace.live/*`.
  User-chosen servers need no permission, because page-world requests run under CORS
  ([Chrome network requests][cr-network]).

### AMO reproducible build

- `apps/userscript/build.mjs` embeds `git rev-parse HEAD` and a dirty flag in
  `__CAELESTIS_BUILD__`. When `.git` is missing, both stay `null`. A reviewer who builds from a
  source archive would get output that differs from the CI build, which fails AMO's "no
  differences" check ([source submission][amo-source]). The revision should come from an input the
  archive carries, such as an environment variable or a generated file.
- The repo pins `pnpm@12.3.4` and Node `>=22.19`. The reviewer default is npm with Node 24.14, so
  the README must name pnpm, its version, the Node version, and one build command
  ([source submission][amo-source]).
- `apps/userscript/ditherette-plugin.mjs` rewrites an import in Ditherette's GPU glue at build time.
  AMO forbids modified third-party libraries (§4.8, [policies][amo-policies-src]). Mia maintains
  `ditherette` on npm, so the cleanest fix is a static import upstream.
- The Ditherette WASM and the blob-URL workers are built from bundled source, so they are packaged
  code, not remote code. Reviewers will still want the readable source of the WASM. A link to the
  tagged Ditherette release is the documented route for third-party code
  ([third-party libraries][amo-thirdparty]).

### Data disclosure

- Caelestis sends Wplace account identity and map state to servers the user chooses. Chrome's user
  data policy covers usernames and website content ([user data FAQ][cws-userdata]). Firefox needs
  matching `data_collection_permissions` types, probably `personallyIdentifyingInfo` and
  `websiteContent`, plus `authenticationInfo` if any token leaves the browser
  ([built-in consent][ff-consent]). Chrome also requires in-product consent before collection
  ([user data FAQ][cws-userdata]).
- All three stores require encrypted transport. The extension should refuse plain `http://`
  servers, or limit them to localhost for development
  ([user data FAQ][cws-userdata], [policies §4.5][amo-policies-src], [Edge §1.5.5][edge-policies]).

### Release flow

- One-time manual work: a Chrome developer account with 2-step verification, then the first upload,
  listing, and Privacy tab, then a linked service account. An Edge Partner Center account, then the
  first product, its Privacy page, and Publish API credentials. An AMO API key.
- CI per release: upload to Chrome with v2 `upload` then `publish`. Run `web-ext sign --channel
  listed` with the source archive. Upload to Edge with the v1.1 draft package call, then submit.
  Chrome rejects an upload unless the manifest version increases ([using the API][cws-api-use]).

## Remaining unknowns

- Edge §1.5.3 restricts sharing user data with third parties to the publisher's own service
  providers for analytics. The policy does not say whether a server the user chooses counts as a
  "third party" under that rule. Ask Edge support, or describe the flow plainly in the
  certification notes.
- Wplace's own terms of service were out of scope. None of the store policies above defer to a
  site's terms, but a takedown request from Wplace would go through each store's complaint process.
- Whether AMO accepts MV3 for Android in practice, given Mozilla's recommendation to use MV2 there
  ([Firefox for Android][ff-android]). Shipping desktop and Android from one MV3 package needs a
  manual test of the host-permission grant on Android.
- Whether `web-ext sign` or the AMO v5 API can set the privacy policy text. The `web-ext` docs list
  only `summary`, `categories`, and `license` as required. Check the addons-server Create schema
  before the first CI run.
- Edge's minimum version for `world: "MAIN"` comes from MDN's compatibility data, which mirrors
  Chrome. Microsoft does not document it.

[cws-mv3]: https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements
[cws-readability]: https://developer.chrome.com/docs/webstore/program-policies/code-readability
[cws-policies]: https://developer.chrome.com/docs/webstore/program-policies/policies
[cws-userdata]: https://developer.chrome.com/docs/webstore/program-policies/user-data-faq
[cws-privacy]: https://developer.chrome.com/docs/webstore/cws-dashboard-privacy
[cws-review]: https://developer.chrome.com/docs/webstore/review-process
[cws-publish]: https://developer.chrome.com/docs/webstore/publish
[cws-api-use]: https://developer.chrome.com/docs/webstore/using-api
[cws-api]: https://developer.chrome.com/docs/webstore/api
[cws-api-rest]: https://developer.chrome.com/docs/webstore/api/reference/rest
[cws-sa]: https://developer.chrome.com/docs/webstore/service-accounts
[cws-v2-blog]: https://developer.chrome.com/blog/cws-api-v2
[cr-cs-manifest]: https://developer.chrome.com/docs/extensions/reference/manifest/content-scripts
[cr-cs-concept]: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
[cr-exectypes]: https://developer.chrome.com/docs/extensions/reference/api/extensionTypes
[cr-scripting]: https://developer.chrome.com/docs/extensions/reference/api/scripting
[cr-network]: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
[amo-policies]: https://extensionworkshop.com/documentation/publish/add-on-policies/
[amo-policies-src]: https://github.com/mozilla/extension-workshop/blob/master/src/content/documentation/publish/add-on-policies.md
[amo-policies-preview]: https://extensionworkshop.com/documentation/publish/add-on-policies-preview-2026-12/
[amo-source]: https://extensionworkshop.com/documentation/publish/source-code-submission/
[amo-thirdparty]: https://extensionworkshop.com/documentation/publish/third-party-library-usage/
[amo-submit]: https://extensionworkshop.com/documentation/publish/submitting-an-add-on/
[amo-signing]: https://extensionworkshop.com/documentation/publish/signing-and-distribution-overview/
[ff-consent]: https://extensionworkshop.com/documentation/develop/firefox-builtin-data-consent/
[ff-mv3]: https://extensionworkshop.com/documentation/develop/manifest-v3-migration-guide/
[ff-android]: https://extensionworkshop.com/documentation/develop/developing-extensions-for-firefox-for-android/
[webext-sign]: https://extensionworkshop.com/documentation/develop/web-ext-command-reference/#web-ext-sign
[mdn-cs]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/content_scripts
[mdn-content-scripts]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Content_scripts
[mdn-background]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/background
[mdn-bss]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/browser_specific_settings
[mdn-host]: https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/manifest.json/host_permissions
[bcd-cs]: https://github.com/mdn/browser-compat-data/blob/main/webextensions/manifest/content_scripts.json
[edge-policies]: https://learn.microsoft.com/en-us/legal/microsoft-edge/extensions/developer-policies
[edge-publish]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension
[edge-api]: https://learn.microsoft.com/en-us/microsoft-edge/extensions/update/api/using-addons-api
