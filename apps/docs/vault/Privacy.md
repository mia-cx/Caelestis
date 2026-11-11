---
title: Privacy policy
---

This policy covers the Caelestis browser extension and the Caelestis userscript. They run the same code. Where they differ, this page says so.

Last updated 11 November 2026.

Caelestis runs only on [Wplace](https://wplace.live). It has no ads.

## Who receives data

Caelestis sends data only to the services this page names:

- **Wplace**, which Caelestis reads from and talks to as you paint.
- **Servers you connect to**, described below.
- **Image addresses you paste into the template studio.** Caelestis loads those images without your cookies.
- **GitHub, from the userscript only.** When **Userscript updates** is on, the userscript asks GitHub for the latest Caelestis release. GitHub sees your IP address and browser details. The extension gets updates from its browser store and never contacts GitHub.

If the Caelestis project starts a service of its own, this page will name it and say what it receives before Caelestis sends it anything.

## What Caelestis reads from Wplace

Caelestis asks Wplace for your account's user ID, display name, owned colors, pixel charges, and charge refill time. It reads your personal and alliance templates, your alliance ID, and the map tiles your browser loads. When you paint, it reads the pixel positions and colors in your paint request.

Caelestis never reads your Wplace session cookie. Reports to servers carry only the painting details listed below, never your captcha tokens or the other fields of your Wplace requests.

## What a connected server receives

Groups usually run Caelestis servers, and whoever runs one is its owner. The owner decides who can see your data, how long the server keeps it, and how you can see or delete it. Ask the owner for their privacy policy.

Every connection sends:

- **Your access token**, if you entered one, so the server knows what you may do.
- **The Caelestis version and connection details**, such as how Caelestis connects and why it refreshed. Owners use these to measure how their server performs.
- **Your Wplace user ID and display name**, when Caelestis opens a live connection for painters. This happens even with **Share where I am** off.
- **Random identifiers** for your browser and for each tab, so the server can tell connections apart.
- **Your alliance ID and the editing area**, when Caelestis loads that server's alliance templates.
- **Your IP address and browser details**, such as its name and version, like any website receives.

These settings control the rest. All three are on by default, and you can turn each off in the Caelestis settings:

- **Report my activity.** After Wplace accepts a paint, Caelestis sends the positions and colors you submitted, the time, your Wplace user ID, and your display name. It includes how many pixels Wplace accepted when it can tell.
- **Share tiles.** Caelestis sends the images of Wplace map tiles your browser loads, with your Wplace user ID and display name.
- **Share where I am.** Other painters on the server see the area you are viewing and the pixels you have drafted, while your tab is open. The standard Caelestis server holds this only while you are connected.

Reports and tiles go only to servers that have a template on that map tile. A map tile is larger than most templates, so they can include pixels outside the templates.

A server also receives what you send it on purpose:

- **Claims** you draw around areas you plan to paint, with your Wplace user ID and display name.
- **Templates you publish**, with their artwork, names, positions, source images, and editing settings.
- **Server management changes**, such as folders, server text and images, and access token settings.

Servers use reports and tiles to show template progress, contributions, and timelapses. Live connections and claims show painters where others are working.

## What stays in your browser

- **Templates.** Your local templates, their folders and images, and copies of server templates stay in your browser's storage for wplace.live. So do the browser identifiers above.
- **Settings.** Your settings, server connections, access tokens, and saved claims stay in extension storage, which the Wplace page cannot read. The userscript keeps them in your userscript manager.

None of this leaves your browser unless you export it or a section above says it goes to a server.

## Stop sharing and remove data

- Turn off **Report my activity**, **Share tiles**, or **Share where I am** to stop sending that data.
- Click **Disconnect** in a server's settings to stop all sending to that server.
- Ask a server's owner to show or delete what their server holds about you.
- Removing the extension deletes its extension storage. If you moved from the userscript, the userscript still has its own copy of your settings and tokens. Remove that in your userscript manager.
- Clear Wplace's site data in your browser to remove templates and browser identifiers.

## Contact

Open a [GitHub issue](https://github.com/mia-cx/Caelestis/issues) or ask on [Discord](https://discord.gg/thequilt).
