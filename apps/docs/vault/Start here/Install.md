---
title: Install Caelestis
order: 1
aliases:
  - start-here/install-the-userscript
---

Install Caelestis in the browser you use for Wplace. The extension and the userscript share the same interface at the same version.

[![Get it for Firefox (add-on)](images/install/banner-firefox.png)](https://addons.mozilla.org/en-US/firefox/addon/caelestis/) [![Get it for Chrome & Edge (userscript)](images/install/banner-chrome-edge.png)](https://github.com/mia-cx/Caelestis/releases/latest/download/caelestis.user.js)

## Install the extension

1. Select the Firefox banner above and add the extension.
2. Open or reload [Wplace](https://wplace.live). Click the Caelestis moon among the map controls.
3. Follow [Getting started](Getting-started) to place your first template.

![The Caelestis button in the Wplace map controls.](images/install/open-panel.png)

Browser stores approve updates separately. **Export .png**, template colours in Wplace's picker and the switches under **Dangerous settings** require Caelestis 1.1.0 or later.

The Chrome Web Store listing is in review. Edge has no store listing. Use the userscript below in either browser.

## Move from the userscript to the extension

1. Leave the userscript enabled. Install the extension in the same browser profile.
2. Reload Wplace. An extension without saved settings takes over the userscript's server connections, tokens and settings. The page reloads after the transfer.
3. Open **Settings** and check your connections. Your local templates already live in Wplace's site storage. Once you see your artwork and settings, you can disable the userscript.

If both copies already have settings, open **Settings** on Wplace with both enabled. In the extension, **Import from userscript** replaces the extension's settings and reloads the page. **Send to userscript** replaces the userscript's settings with the extension's. When the userscript runs the panel, the buttons read **Import from extension** and **Send to extension**. Confirm **Import** or **Send** after checking which copy will receive the settings.

## Install the userscript

1. Install a userscript manager for your browser, such as [Tampermonkey](https://www.tampermonkey.net/) or [Violentmonkey](https://violentmonkey.github.io/get-it/).
2. On Chromium browsers, open the manager's extension details. Enable **Allow user scripts** if your browser offers it. See [Tampermonkey's browser instructions](https://www.tampermonkey.net/faq.php#Q209).
3. Open the Chrome & Edge banner above. Confirm **Install** in your manager.
4. Open or reload Wplace and click the Caelestis moon.

![Allow user scripts in the browser's extension settings.](images/install/allow-user-scripts.png)

For shared artwork, [connect to your group's server](Connect-to-a-server).
