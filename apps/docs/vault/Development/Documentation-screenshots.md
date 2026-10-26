---
title: Documentation screenshots
---

Docs screenshots live in `apps/docs/vault/images/`. The source repository's README images live in `docs/assets/readme/`.

## What a screenshot should show

For a UI instruction, show the state where the reader takes the action. Keep the button, its label, and enough surrounding UI to locate it.

For a feature description, show the result. Pixel-style examples need enough zoom to see individual overlay pixels. Marker-size examples need the same marker at two zoom levels.

Use a different capture when the next step changes the UI. Repeating an overview under unrelated steps does not explain those steps.

## Cropping

Keep complete controls inside the crop, including buttons at the right edge. Check the actual screenshot dimensions; browser zoom can make DOM coordinates differ from screenshot coordinates.

Inspect the image at the width it will have in the docs. Avoid distant map views, huge empty areas, and menus without the effect being described.

A small outline can identify the control to click. It must not obscure its label or imply a different application state.

## Installation guides

Use copyable code blocks for terminal commands. Use screenshots for UI actions and visible results.

Capture a new server's empty dashboard for the first-run result. Do not substitute a populated production server.

Do not use screenshots of command-reference websites as evidence of running those commands.

## Sensitive content

Use an isolated demonstration server for token creation and administration screenshots. Conceal token values before capture. Keep account details, private URLs, and unrelated browser content out of the frame.

## Before publishing

Check every image against the instruction beside it. Confirm that links load, captions describe what is visible, and no step points to an unrelated capture.

Keep the README's hero video. Its three static images cover templates, painting, and the dashboard; they are overviews, not substitutes for guide screenshots.
