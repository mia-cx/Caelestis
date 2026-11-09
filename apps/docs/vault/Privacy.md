---
title: Privacy policy
---

This policy covers the Caelestis browser extension and userscript. Both run the same code and handle data the same way.

Last updated 9 November 2026.

Caelestis runs only on [Wplace](https://wplace.live). The Caelestis project runs no server that receives your data. Caelestis has no analytics or ads.

## What stays in your browser

- **Templates.** Local templates, folders, and their images stay in your browser's storage for wplace.live. They stay there after you uninstall Caelestis. Clear Wplace's site data to remove them.
- **Settings and server connections.** These include your server access tokens. The extension keeps them in extension storage, which the Wplace page cannot read. The userscript keeps them in your userscript manager. Uninstalling Caelestis removes them.

This data stays in your browser unless you export it or connect to a server.

## What Caelestis reads from Wplace

Caelestis asks Wplace for your account's user ID, display name, and owned colors. It also reads the map tiles your browser loads. When you paint, it reads the pixels and colors in your paint request to Wplace.

Caelestis never reads your Wplace session cookie. It never sends your captcha tokens or your raw requests to Wplace anywhere.

## What a server receives

Without a server connection, Caelestis contacts only Wplace and image addresses you paste into the template studio. It fetches those images without cookies.

When you connect to a server, Caelestis sends data only to that server. Groups and their members run these servers. The owner decides who can see the data and how long the server keeps it. Ask the owner for their privacy policy.

A connected server receives the following data.

- **Your access token.** If you entered one, Caelestis sends it with every request so the server knows what you may do.
- **Activity reports.** When **Report my activity** is on, Caelestis sends a report after Wplace accepts a paint. It includes the painted pixels, accepted pixel count, time, your Wplace user ID, and display name.
- **Map tiles.** When **Share tiles** is on, Caelestis sends images of the Wplace tiles your browser loads. It includes your Wplace user ID and display name.
- **Your viewport and drafts.** When **Share where I am** is on, Caelestis shares the area you're viewing and your drafted pixels. Other painters on the server see them while your tab is open. The server does not store them.
- **Claims.** Caelestis sends claims you draw around areas you plan to paint, with your Wplace user ID and display name.

Activity reports and map tiles go only to servers whose templates cover that area. They include only that area. All three sharing settings are on by default. You can turn them off in Caelestis settings under the names shown above.

The server also sees your IP address and your browser's user agent.

## Stop sharing

Turn off a sharing setting to stop sending that data. Click **Disconnect** in the server's settings to stop all sending to that server. Ask the owner to delete data the server already holds.

## Contact

Contact the project through [GitHub issues](https://github.com/mia-cx/Caelestis/issues) or [Discord](https://discord.gg/thequilt).
