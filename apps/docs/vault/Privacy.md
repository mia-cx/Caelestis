---
title: Privacy policy
---

This policy covers the Caelestis browser extension and the Caelestis userscript. Both run the same code and handle data the same way. Last updated 9 November 2026.

Caelestis runs only on [Wplace](https://wplace.live). The Caelestis project runs no server that receives your data, and Caelestis has no analytics or ads.

## What stays in your browser

- **Templates.** Your local templates, folders, and their images stay in this browser's storage for wplace.live. Uninstalling Caelestis does not delete them. Clear Wplace's site data to remove them.
- **Settings and server connections.** These include the access tokens servers give you. The extension keeps them in its own extension storage, which Wplace's page cannot read. The userscript keeps them in your userscript manager. Uninstalling removes them.

None of this leaves your browser unless you export it or connect to a server.

## What Caelestis reads from Wplace

Caelestis asks Wplace for your account's user ID, display name, and owned colours, and reads the map tiles your browser loads. It never reads or sends your Wplace session cookie, captcha tokens, or the requests you send to Wplace.

## What a server receives

Without a server connection, Caelestis talks only to Wplace and to any image address you paste into the template studio. It loads that image without your cookies.

When you connect to a server, Caelestis sends data to that server only. Groups and their members run these servers, not the Caelestis project. The server's owner decides who can see the data and how long the server keeps it. Ask them for their own policy.

A connected server receives:

- **Your access token**, if you entered one, with every request, so the server knows what you may do.
- **Activity reports**, when **Report my activity** is on. After Wplace accepts a paint, Caelestis sends the pixels you painted, how many Wplace accepted, the time, your Wplace user ID, and your display name.
- **Map tiles**, when **Share tiles** is on. Caelestis sends images of the Wplace tiles your browser loaded, with your Wplace user ID and display name.
- **Where you are**, when **Share where I am** is on. Other painters on the server see the area you are looking at and the pixels you have drafted, while your tab is open. The server does not store this.
- **Claims** you draw around areas you plan to paint, with your Wplace user ID and display name.

Activity reports and map tiles go only to the servers whose templates cover the area, and only for that area. All three settings are on by default. Turn them off in the Caelestis settings, under the same names.

Like any website, a server also sees your IP address and your browser's user agent.

## Stop sharing

Turn off a setting above to stop sending that data. **Disconnect** in the server's settings stops all sending to that server. To remove data a server already has, ask its owner.

## Contact

Open an issue on [GitHub](https://github.com/mia-cx/Caelestis/issues) or ask on [Discord](https://discord.gg/thequilt).
