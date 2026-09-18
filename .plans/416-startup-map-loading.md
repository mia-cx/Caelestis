# #416 Prevent startup from blocking Wplace map loading

## Summary

Wplace sometimes never builds its map when Caelestis is injected at document-start. Find the startup work that breaks Wplace and defer it until Wplace's map is ready, without moving the early capture hooks.

## Acceptance criteria

- [ ] Wplace's map loads with the built userscript injected before page scripts, across repeated loads.
- [ ] Early capture hooks (map handle, Wplace state, tile fetch) still run at document-start.
- [ ] Native personal templates still connect after the map is ready.
- [ ] Overlays, navigation, and claim projection work after startup.
- [ ] The userscript release notes include the fix.

## TODOs

- [ ] Add a Wplace map readiness helper that resolves once Wplace's MapLibre canvas exists, with unit coverage.
- [ ] Gate native template module evaluation on that readiness instead of `DOMContentLoaded`.
- [ ] Add the userscript Changeset.
- [ ] Verify against real Wplace over CDP: repeated injected loads, a late-map load, and a failed map load.
- [ ] Run userscript tests, typecheck, lint, build, and release check.

## Notes

- Reproduced over CDP with `Page.addScriptToEvaluateOnNewDocument`: `#map` stays empty, `readyState` is `complete`.
- The blocking exception is Wplace's own `The message catalog was used before initializeLocale() completed`, thrown at the top level of `chunks/Dckshkh0.js`.
- Bisecting startup steps by editing the built bundle was misleading: the failure is a race and passed or failed run to run regardless of which step was removed.
- Network-logged repeated runs showed the real cause. `connectNativeTemplates` in `templates/native-store.ts` dynamically `import()`s Wplace chunks at `DOMContentLoaded` to find the template store. When that import evaluates a chunk before Wplace's `init` hook has awaited the locale catalog import, the chunk's top-level catalog read throws. ES module evaluation errors are permanent, so Wplace's own import of that chunk then fails and the map never builds. Our own log line at that moment: `native personal templates unavailable; retaining local records Error: The message catalog was used before initializeLocale() completed`.
- Wplace's map canvas only exists after its page nodes render, which happens after `init` resolved, so the canvas is a safe readiness signal. `DOMContentLoaded` fires before any of that.
- No timeout on readiness: if Wplace never boots, evaluating its modules ourselves would cause the same failure, and `restoreLocalTemplates` has already run.
