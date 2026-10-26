---
title: Install the userscript
order: 1
---

Install a userscript manager in your browser, then add Caelestis from GitHub. The example below uses Violentmonkey.

## 1. Install a userscript manager

Choose [Violentmonkey](https://violentmonkey.github.io/get-it/) or [Tampermonkey](https://www.tampermonkey.net/) and follow its link for your browser.

Use the extension store's install button and approve the browser's confirmation.

![Violentmonkey's extension-store page with Add to Chrome visible.](images/install/userscript-manager.png)

On Chromium browsers, open the manager's details in the browser's Extensions page and enable **Allow user scripts** if present. Older versions may require extension developer mode instead. [Tampermonkey documents the Chromium setting here](https://www.tampermonkey.net/faq.php#Q209).

![Allow user scripts enabled in the extension's browser settings.](images/install/allow-user-scripts.png)

Greasy Fork is a script directory, not a userscript manager. Caelestis releases are on GitHub.

## 2. Open the latest release

Open [the latest Caelestis release](https://github.com/mia-cx/Caelestis/releases/latest). Look for the userscript release marked **Latest**.

![A Caelestis userscript release with the Latest badge.](images/install/github-latest-release.png)

## 3. Open the script asset

Under **Assets**, click `caelestis.user.js`. Choose the script file, not **Source code**.

![The caelestis.user.js asset outlined in orange.](images/install/github-release-asset.png)

## 4. Confirm the installation

Your userscript manager opens an installation page. Check that the script is **Caelestis** and its matching site is `https://wplace.live/*`. Click **Install**.

![Violentmonkey's Caelestis installation page, with Install outlined in orange.](images/install/confirm-install.png)

## 5. Open Wplace

Open [Wplace](https://wplace.live), or reload it if it was already open. Click the Caelestis button among the map controls to open the panel.

![The Caelestis map button outlined in orange.](images/install/open-panel.png)

Follow [Getting started](Getting-started) to import and place your first template.

## Optional: connect to a server

Local templates work without a server. For a group's shared artwork, ask its owner for the server address and a token.

Open **Settings** in the panel header.

![The Settings gear outlined in orange.](images/settings/connection-open-settings.png)

Enter the owner's server address and click **Add**.

![An example address and the Add button.](images/settings/connection-add-address.png)

Expand the server if needed. Paste the token and click **Connect**. A connected server shows **Update** when changing its token.

![The access-token field beside Connect. The masked value is an example.](images/settings/connection-enter-token.png)

[Connect to a server](Connect-to-a-server) has the full connection instructions.
