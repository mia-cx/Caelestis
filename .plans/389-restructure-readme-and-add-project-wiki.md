# #389 Restructure README and add a project wiki

## Summary

Give first-time users a short installation path in the README. Put complete userscript,
dashboard, server, and contributor guidance in a navigable GitHub wiki.

## Acceptance criteria

- [ ] A new user can understand Caelestis and install it from the README without opening the wiki.
- [ ] The README highlights the main workflows with current screenshots or GIFs.
- [ ] The README links to the wiki landing page and the dashboard, releases, Discord, and issue tracker.
- [ ] The wiki has feature, operations, and troubleshooting sections.
- [ ] Existing technical documentation is linked, consolidated, or marked as maintainer reference.
- [ ] All screenshots, links, and setup commands are checked before closing the issue.

## TODOs

- [x] Write a concise README first-read path, navigation, and a precise screenshot brief.
- [x] Enable and seed the GitHub wiki with landing, installation, template, overlay, painting, progress, collaboration, and settings pages.
- [x] Add dashboard, self-hosting, authentication, deployment, storage, upgrade, backup, troubleshooting, and contributor pages.
- [x] Link the README and wiki to canonical project and maintainer references.
- [ ] Embed the current visual captures, then verify every link, command, and rendered page.

## Notes

- Started from clean branch `t3code/build-wiki` at `202fc171`.
- GitHub's wiki is enabled and published at https://github.com/mia-riezebos/Caelestis/wiki.
- Issue #387 owns the badge row. This work preserves that separate scope.
- Mia will capture the current product visuals from an exact brief. The final README image slots remain pending until those assets arrive.
- The wiki now has a committed capture brief for the template tree and overlay, colour-work flow, and dashboard progress view.
- Wiki commits `53df2ab` and `6c93570` add the user, operator, troubleshooting, contributor, and sidebar paths. All internal and external links, plus seven shell snippets, passed local checks before publishing.
- Wiki commit `cba8e2d` rewrites the README and wiki introductions and task headings to describe the userscript, server, and dashboard directly.
