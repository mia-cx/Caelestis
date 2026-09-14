# #389 Restructure README and add a project wiki

## Summary

Give first-time users a short installation path in the README. Put complete userscript,
dashboard, server, and contributor guidance in a navigable GitHub wiki.

## Acceptance criteria

- [x] A new user can understand Caelestis and install it from the README without opening the wiki.
- [x] The README highlights the main workflows with current screenshots or GIFs.
- [x] The README links to the wiki landing page and the dashboard, releases, Discord, and issue tracker.
- [x] The wiki has feature, operations, and troubleshooting sections.
- [x] Existing technical documentation is linked, consolidated, or marked as maintainer reference.
- [x] All screenshots, links, and setup commands are checked before closing the issue.

## TODOs

- [x] Write a concise README first-read path, navigation, and a precise screenshot brief.
- [x] Enable and seed the GitHub wiki with landing, installation, template, overlay, painting, progress, collaboration, and settings pages.
- [x] Add dashboard, self-hosting, authentication, deployment, storage, upgrade, backup, troubleshooting, and contributor pages.
- [x] Link the README and wiki to canonical project and maintainer references.
- [x] Capture and add focused visual highlights for every documented feature, plus step images for each guide flow.
- [x] Embed the current visual captures, then verify every link, command, and rendered page.

## Notes

- Started from clean branch `t3code/build-wiki` at `202fc171`.
- GitHub's wiki is enabled and published at https://github.com/mia-riezebos/Caelestis/wiki.
- Issue #387 owns the badge row. This work preserves that separate scope.
- The capture inventory covers the template tree and overlay, colour-work flow, dashboard progress, settings, collaboration, and contributor paths.
- Wiki commits `53df2ab` and `6c93570` add the user, operator, troubleshooting, contributor, and sidebar paths. All internal and external links, plus seven shell snippets, passed local checks before publishing.
- Wiki commit `cba8e2d` rewrites the README and wiki introductions and task headings to describe the userscript, server, and dashboard directly.
- Current visual captures came from the injected userscript. Each image frames one action and omits browser chrome, account details, and unrelated map space.
- Wiki commit `3b34797` adds 21 cropped product images and 37 guide placements. Commit `c66d6c8` records the three copies used by the source README under `docs/assets/readme/`.
- Checked 18 Markdown files, 40 image references, 86 page links, and 26 external links. GitHub rendered all 16 public wiki pages with all 37 placed images, and all 21 wiki image assets loaded as PNG files.
- Background Chromium checks confirmed the image-heavy overlay and dashboard guides, plus all three README image files on branch `t3code/build-wiki`. `pnpm lint` passed with two existing informational D1 constructor advisories.
