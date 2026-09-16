# #420 Explain claims that rasterise to no pixels

## Summary

Reject claim documents that cannot produce pixels before routing them, and report the document problem instead of blaming the server connection.

## Acceptance criteria

- [x] Claims with no added shape explain that an added shape is required.
- [x] Claims whose added shapes span more than the raster limit explain how to recover.
- [x] Claims erased to zero pixels explain that they contain no pixels.
- [x] Only valid documents can reach server recipient selection.
- [x] The userscript release notes include the fix.

## TODOs

- [x] Validate claim documents before persistence and retry routing, with focused coverage for each invalid form.
- [~] Run the affected userscript tests, typecheck, lint, build, release check, and review the final diff.

## Notes

- The reported setup uses season 0 and bootstrap admin tokens. The screenshot shows `15 shapes · 0 px`; server compatibility is not the cause.
- Focused validation: `pnpm exec vitest run src/claim-routing.test.ts` passed 17 tests.
