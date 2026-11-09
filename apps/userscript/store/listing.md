# Store listing

The text for the Chrome Web Store, Microsoft Edge Add-ons, and addons.mozilla.org (AMO) listings.
Each store takes the description as plain text, so paste the block as it is.

## Name

Caelestis

## Summary

Chrome allows 132 characters, AMO 250.

```text
Image templates and painting tools for Wplace. Place your artwork on the map, find the pixels left to paint, and paint with a group.
```

## Description

```text
Caelestis adds image templates and painting tools to Wplace (wplace.live).

Place your artwork on the map, adjust how the overlay looks, and find the pixels that still need painting. Local templates work on their own, with no account and no server.

Templates
Import PNG images, Blue Marble exports, or native .wplace files. Organise them with folders, tags, search, and filters. Caelestis also reads your Wplace personal and alliance templates. Local artwork stays in your browser.

Painting
Choose full, corner, or small overlay pixels, then adjust their size, rounding, opacity, and outlines. These change how the overlay looks, not your artwork. Mark mismatches or the work left for the selected colour, and jump to unfinished pixels. Press Shift+/ for the keyboard shortcuts.

Paint with a group
Connect to your group's Caelestis server to use its shared templates and per-colour progress. Painters can share where they are and what they have drafted, and draw claims around areas they plan to paint. Activity reports, tile sharing, and presence each have their own setting. The web dashboard shows progress, painting pace, contributions, and timelapses.

Run your own server
The server's source is public. Run it with Docker or on Cloudflare: https://docs.caelest.is/run-a-server/

Already use the Caelestis userscript? Install the extension and reload Wplace. The userscript hands its settings and servers over and then steps aside.

Privacy: https://docs.caelest.is/privacy/
Source: https://github.com/mia-cx/Caelestis
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

- storage: `Keeps settings and server connections, including access tokens, in extension storage, where Wplace's page cannot read them.`
- Host permission for https://wplace.live/*: `Caelestis runs only on Wplace. It draws templates over the map and compares them with the tiles Wplace loads.`

Remote code: No. All code ships in the package.

Data usage, all sent only to servers the user connects to:

- Personally identifiable information: Wplace user ID and display name.
- Authentication information: server access tokens.
- User activity: painted pixels, viewport, and drafts.
- Website content: Wplace map tiles.

Certify all three: no sale to third parties, no use unrelated to the single purpose, no use for creditworthiness or lending.

## AMO

The manifest already declares `authenticationInfo`, `personallyIdentifyingInfo`, `websiteActivity`, and `websiteContent` under `data_collection_permissions`. License: MCX License (custom, paste `LICENSE`).
