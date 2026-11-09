# Store listing

Copy for the Chrome Web Store, Microsoft Edge Add-ons, and addons.mozilla.org (AMO).
Paste each text block directly into its store field.

## Name

Caelestis

## Summary

Chrome allows 132 characters, AMO 250.

```text
Image templates and painting tools for Wplace. Place artwork on the map, find unfinished pixels, and paint with a group.
```

## Description

```text
Caelestis adds image templates and painting tools to Wplace (wplace.live).

Place your artwork on the map and find the pixels that still need painting. Adjust the overlay's appearance. Local templates work without an account or server.

Templates
Import PNG images, Blue Marble exports, or native .wplace files. Organize templates with folders, tags, search, and filters. Caelestis also reads your Wplace personal and alliance templates. Local artwork stays in your browser.

Painting
Choose full, corner, or small overlay pixels. Adjust their size, rounding, opacity, and outlines without changing your artwork. Mark mismatches or work left for the selected color, and jump to unfinished pixels. Press Shift+/ to see the keyboard shortcuts.

Paint with a group
Connect to your group's Caelestis server for shared templates and per-color progress. Share the area you're viewing and the pixels you've drafted. Draw claims around areas you plan to paint. Activity reports, tile sharing, and presence each have a separate setting. The web dashboard shows progress, painting pace, contributions, and timelapses.

Run your own server
The server's source is public. Run it with Docker or on Cloudflare.
https://docs.caelest.is/run-a-server/

If you use the Caelestis userscript, install the extension and reload Wplace. The userscript transfers its settings and server connections to the extension, then steps aside.

Privacy policy
https://docs.caelest.is/privacy/

Source code
https://github.com/mia-cx/Caelestis
```

## Links

- Homepage: https://github.com/mia-cx/Caelestis
- Support: https://github.com/mia-cx/Caelestis/issues
- Privacy policy: https://docs.caelest.is/privacy/

## Categories

- Chrome: Art & Design
- Edge: Entertainment
- AMO: Games & Entertainment

## Chrome privacy practices

Single purpose:

```text
Adds image templates and painting tools to Wplace (wplace.live).
```

Permission justifications:

- storage: `Stores settings and server connections, including access tokens, in extension storage. The Wplace page cannot read this storage.`
- Host permission for https://wplace.live/*: `Caelestis runs only on Wplace. It draws templates over the map and compares them with tiles Wplace loads.`

Remote code: No. All code ships in the package.

Data usage

All data listed below goes only to servers the user connects to.

- Personally identifiable information: Wplace user ID and display name.
- Authentication information: server access tokens.
- User activity: painted pixels, viewport, and drafts.
- Website content: Wplace map tiles.

Certify that data is never sold to third parties or used outside the extension's single purpose.
Also certify that data is never used for creditworthiness or lending.

## AMO

The manifest declares `authenticationInfo`, `personallyIdentifyingInfo`, `websiteActivity`, and `websiteContent` under `data_collection_permissions`.
The license is MCX License. Paste the custom license from `LICENSE`.
