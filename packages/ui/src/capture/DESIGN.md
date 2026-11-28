# Capture run card

One small floating card for a capture run in a Wplace territory event: painters join, an administrator orders them and publishes a plan, and on Go each painter counts down to their own slot. One card serves both roles; the administrator's controls appear inside it.

## Placement

The element positions itself: `position: fixed` at the top left, beside Wplace's column of map buttons, at `--caelestis-capture-run-top` (default `0.5rem`) and `--caelestis-capture-run-left` (default `3.5rem`). There it clears the bottom-centre Paint button and drawer and Caelestis's right-hand rail and panel. A host moves it with those properties, or by setting `inset` and `z-index` on the element. In a window 1080px wide or less, Wplace's event scoreboard reaches the card's corner, so the card drops below it to `--caelestis-capture-run-top-narrow` (default `10.5rem`) and stops 6.5rem above the bottom, clear of the Paint controls; on a phone it also moves to the left edge and leaves room for Wplace's right-hand buttons. It sits at z-index 31 like the claim editor: above the docked panel, below its popovers. The card is 17rem wide and scrolls within the viewport instead of growing past it.

The host decides visibility: non-administrators only get the element while a run exists. It enters with a short rise on its own and exits through `closeSurface`'s `data-state="closing"`.

## States

- **none** (administrator): steppers for painters (1 to `maxPainters`), anchor guards, and the stagger between steps (100 to 2,000 ms in 50 ms steps), and Open run.
- **gathering**: the paint order as numbered rows: colour swatch, name, drafted/length with a check once ready, and a button to fly to your own line. The administrator who opened the run reads "Closes wall" on their row: they keep the last painter's place, so their row has no move buttons and the rows either side of it move past it. The administrator gets move up/down per row, Propose plans with the plan list (where it goes, territory gained, pixels painted, Publish or Published), Close run and Go. Go stays disabled until every painter's row shows their line drafted; guards don't hold it. Painters get Join run or Leave run.
- **countdown**: the clock reads `mm:ss.mmm` in large tabular numerals, counting to this painter's slot (`mySlotAt`), or to the first painter (`startsAt`) for everyone else. It clamps at `00:00.000`; at a member's slot the lead reads "Paint now" and the clock turns primary.
- **done**: "Run finished" and the final order.

Members see the "Paint at my slot" switch in gathering and countdown. It is the Dangerous settings row, with its "Trips: `UntrustedPaintSubmit`" line, so the flag reads the same in both places. `message` is the only status line; the card adds no notices of its own.

## Countdown

Deadlines are `performance.now()` times, so the card runs its own `requestAnimationFrame` loop while one is set and stops it when the countdown ends or the element is removed. The visible clock is hidden from screen readers. A polite live region, mounted for the card's lifetime, speaks the phase changes and the countdown at 10, 5, 3, 2 and 1 seconds and at zero; its text only changes on those marks, so it never speaks per frame. Audio cues belong to the userscript.
