# Store listing

The listing fields for the Chrome Web Store, Microsoft Edge Add-ons, and addons.mozilla.org (AMO), with one shared copy block for each field.
Paste each block into the store field it names.
The stores show the listing in US English, so the copy uses American spelling.

Field names and limits come from each store's documentation, checked on 17 November 2026:

- Chrome: [Store listing](https://developer.chrome.com/docs/webstore/cws-dashboard-listing), [Privacy practices](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy), [Images](https://developer.chrome.com/docs/webstore/images), [Best listing practices](https://developer.chrome.com/docs/webstore/best-listing)
- Edge: [Publish a Microsoft Edge extension](https://learn.microsoft.com/en-us/microsoft-edge/extensions/publish/publish-extension)
- AMO: [Create an appealing listing](https://extensionworkshop.com/documentation/develop/create-an-appealing-listing/) and the limits in the [addons-server source](https://github.com/mozilla/addons-server/blob/master/src/olympia/addons/models.py)

## Text

### Name

| Store | Field | Limit | Source |
| --- | --- | --- | --- |
| Chrome | Title | Not stated | Manifest `name` |
| Edge | Extension name | Not stated | Manifest `name`, read-only in Partner Center |
| AMO | Name | 50 characters | Manifest `name`, editable on AMO |

```text
Caelestis
```

### Summary

| Store | Field | Limit | Source |
| --- | --- | --- | --- |
| Chrome | Summary | 132 characters, plain text | Manifest `description` |
| Edge | Short description | Not stated | Manifest `description`, read-only in Partner Center |
| AMO | Summary | 250 characters, no links | Manifest `description`, editable on AMO |

Chrome shows the summary in search results and on category pages.
The 122-character copy below is the manifest `description` in `apps/userscript/build.mjs`.

```text
Template overlay for Wplace. Place your pixel art on the map, find the pixels left to paint, and paint with your alliance.
```

### Description

| Store | Field | Limit |
| --- | --- | --- |
| Chrome | Detailed description | Not stated. Plain text, shown under the screenshots |
| Edge | Description | 250 to 10,000 characters |
| AMO | Description | 15,000 characters. Renders limited Markdown, so the `-` lines become a list |

```text
Caelestis puts your pixel art on the Wplace map as a template, so you can see which pixels still need painting and which color goes where. It works on its own, with no account or server. Connect to your alliance's Caelestis server to share templates and track progress together.

Templates
- Import PNG images, Blue Marble exports, or .wplace files.
- Turn any image into Wplace colors in the template studio. Crop and scale it, adjust levels and curves, pick a dithering pattern, and limit it to the colors you own.
- Organize templates with folders, tags, search, and filters.
- Caelestis also reads your Wplace personal and alliance templates.
- Your local artwork stays in your browser.

Painting
- Choose full, corner, or small overlay pixels, and adjust their size, rounding, opacity, and outlines.
- Mark mismatched pixels and the work left for the color you have selected.
- Jump to the next unfinished pixel.
- Press Shift+/ to see your keyboard shortcuts.

Paint with your alliance
- Share templates and see the progress of each color.
- See where other painters are working and what they have drafted.
- Draw claims around the areas you plan to paint.
- Turn activity reports, tile sharing, and presence on or off separately.
- The web dashboard shows progress, painting pace, contributions, and timelapses.

Run your own server
The server's source is public. Run it with Docker or on Cloudflare:
https://docs.caelest.is/run-a-server/

Moving from the userscript
Install the extension and reload Wplace. The userscript hands its settings and server connections to the extension, then steps aside.

Caelestis is a community project. Wplace does not make or endorse it.

Privacy policy: https://docs.caelest.is/privacy/
Source code: https://github.com/mia-cx/Caelestis
```

### Screenshot captions

AMO shows a caption under each screenshot. Chrome and Edge show none.
Upload the screenshots in this order:

1. `Place your pixel art on the map and see which pixels still need painting.`
2. `See how many pixels each color still needs.`
3. `Turn any image into Wplace colors in the template studio.`
4. `See where your alliance is painting, and claim the area you'll take.`
5. `Follow progress and timelapses on your server's dashboard.`

### Search terms

Only Edge has this field. It allows 7 terms of up to 30 characters each, 21 words in total, and never shows them to users.

```text
wplace
wplace template
wplace overlay
pixel art template
pixel art overlay
wplace alliance
wplace.live
```

AMO tags come from a fixed list of 42, and none of them describe Caelestis, so leave them empty. Chrome has no search terms field.

## Store details

### Category

| Store | Field | Value |
| --- | --- | --- |
| Chrome | Category | Art & Design |
| Edge | Category | Entertainment |
| AMO | Categories, up to 3 | Games & Entertainment |

### Language

English (United States) on every store.

### Links

| Link | Chrome | Edge | AMO | Value |
| --- | --- | --- | --- | --- |
| Homepage | Homepage URL | Website | Homepage | https://docs.caelest.is/ |
| Support | Support URL | Support contact detail | Support site | https://github.com/mia-cx/Caelestis/issues |
| Privacy policy | Privacy policy, on the Privacy tab | Privacy Policy URL | Privacy policy text | https://docs.caelest.is/privacy/ |

- AMO also has an optional Support email, of up to 100 characters. Leave it empty.
- AMO asks for the privacy policy as text, not as a link. Paste the text of `apps/docs/vault/Privacy.md` without its front matter.
- Chrome's Official URL shows a verified badge for a domain you have verified in Google Search Console. Choose `caelest.is` once it is verified, or leave it empty.

### Mature content

No, on Chrome and Edge.

### Visibility and markets

- Chrome: Public, in all regions.
- Edge: Public, in all markets.
- AMO: Listed. Leave "experimental" and "requires payment" off. Turn off Android until Wplace site access is tested on Firefox for Android.

### License

AMO only. Choose a custom license, named `MCX License`, and paste the text of `LICENSE`.

## Privacy

Chrome and Edge ask the same questions on their Privacy tabs.

### Single purpose

```text
Adds image templates and painting tools to Wplace (wplace.live).
```

### Permission justifications

storage:

```text
Stores settings and server connections, including access tokens, in extension storage. The Wplace page cannot read this storage.
```

Host permission for `https://wplace.live/*`:

```text
Caelestis runs only on Wplace. It draws templates over the map and compares them with the tiles Wplace loads.
```

### Remote code

No. All code ships in the package.

### Data usage

Check these data types. All of them go only to servers the user connects to:

- Personally identifiable information: Wplace user ID and display name.
- Authentication information: server access tokens.
- User activity: painted pixels, viewport, and drafts.
- Website content: Wplace map tiles.

Check every certification: the data is not sold to third parties, is not used for purposes unrelated to the single purpose, and is not used to determine creditworthiness or for lending.

On AMO, the manifest declares the same data under `data_collection_permissions`: `authenticationInfo`, `personallyIdentifyingInfo`, `websiteActivity`, and `websiteContent`.

## Notes for reviewers

Edge calls this field Notes for certification. AMO calls it Notes to reviewers, and only Mozilla sees it.

```text
Caelestis runs only on https://wplace.live. You can test it without an account or server:

1. Open https://wplace.live.
2. Click the Caelestis button on the map to open the template panel.
3. Import any PNG image as a template and place it on the map.

Painting on Wplace needs a Wplace account. Shared templates and progress need a Caelestis server, which anyone can run from the public source.

The source package includes BUILD-EXTENSION.md with the exact build command. The build is reproducible: the same commit builds identical files.
```

## Images

| Asset | Chrome | Edge | AMO | File |
| --- | --- | --- | --- | --- |
| Icon | 128×128 PNG, from the package | Extension logo: 1:1, at least 128×128, 300×300 recommended | From the package, or upload a square PNG | Package icon for Chrome and AMO, `brand/logo/caelestis-512.png` for Edge |
| Screenshots | 1 to 5, 1280×800 or 640×400 | Up to 6, 1280×800 or 640×480 | Any number, 1280×800 recommended | Needed: 5 at 1280×800 |
| Small promo tile | 440×280, optional | 440×280, optional | None | Needed |
| Marquee / large promo tile | 1400×560, optional | 1400×560, optional | None | Optional |
| YouTube video | Optional | Optional | None | Optional |

- Chrome wants square icon artwork at 96×96 inside the 128×128 canvas. It allows the full canvas for shapes that are mostly empty space, and the crescent moon is one of those.
- Chrome lists items without a small promo tile after items that have one.
- Promo tiles should show the brand without text, work at half size, and avoid large areas of white or light gray, because Chrome shows them on a light gray background.
- Screenshots fill the whole frame, with square corners and no padding. Chrome shrinks all of them to 640×400 on the listing.
