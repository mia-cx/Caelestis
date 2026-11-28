# Capture lobby card

One small floating card for capture lobbies in a Wplace territory event. Painters join a lobby. A runner locks in a planned wall, the wall is cut into legs, and the countdown takes each painter with a leg to their own slot. Runners are event runners and administrators, called `admin` in the model. One card serves both roles; the runner's controls appear inside it.

## Placement

The element positions itself: `position: fixed` at the top left, beside Wplace's column of map buttons, at `--caelestis-capture-run-top` (default `0.5rem`) and `--caelestis-capture-run-left` (default `3.5rem`). There it clears the bottom-centre Paint button and drawer and Caelestis's right-hand rail and panel. A host moves it with those properties, or by setting `inset` and `z-index` on the element. In a window 1080px wide or less, Wplace's event scoreboard reaches the card's corner, so the card drops below it to `--caelestis-capture-run-top-narrow` (default `10.5rem`) and stops 6.5rem above the bottom, clear of the Paint controls; on a phone it also moves to the left edge and leaves room for Wplace's right-hand buttons. It sits at z-index 31 like the claim editor: above the docked panel, below its popovers. The card is 17rem wide and scrolls within the viewport instead of growing past it.

The host decides visibility: a painter in no lobby only gets the element while the team has a lobby to join; a runner always does. It enters with a short rise on its own and exits through `closeSurface`'s `data-state="closing"`.

## States

- **list**: the team's lobbies whose countdown has not started, one row each with its owner's name, its painter count, and Join. Runners also get New lobby. "No open lobbies" when there are none.
- **gathering**: runners see steppers for Painters (1 to `maxPainters`) and Anchor guards (0 to `maxGuards`, half the lobby), the Legs choice (Even or Reserve), and the Stagger stepper (100 to 2,000 ms in 50 ms steps) at the top. Even gives every painter a leg; Reserve cuts the fewest legs that fit, and the painters past them read "Reserve" on their row and get no leg, slot or steps. Below the settings is the paint order as numbered rows: colour swatch, name, drafted/length with a check once ready, and a button to fly to your own leg. The runner who opened the lobby reads "Closes wall" on their row: they keep the closing leg's place, so their row has no move buttons and the rows either side of it move past it. Runners get move up/down per row and Close lobby. Before a lock-in they see the live proposals (where the wall goes, territory gained, pixels painted, Lock in); Lock in is disabled, with "Needs N more painters", while a leg would exceed a painter's charges. After a lock-in they get Cancel proposed shape and Start countdown, which stays disabled until every row with a leg shows it drafted; guards and reserves don't hold it. Painters and guards see the steps for reaching their leg once a wall is locked in. Everyone gets Leave.
- **countdown**: the clock reads `mm:ss.mmm` in large tabular numerals, counting to this painter's slot (`mySlotAt`), or to the first painter (`startsAt`) for everyone else. It clamps at `00:00.000`; at a member's slot the lead reads "Paint now" and the clock turns primary.
- **done**: "Capture finished", the final order, and Leave.

Members see the "Paint at my slot" switch in gathering and countdown. It is the Dangerous settings row, with its "Trips: `UntrustedPaintSubmit`" line, so the flag reads the same in both places. `message` is the only status line; the card adds no notices of its own.

## Countdown

Deadlines are `performance.now()` times, so the card runs its own `requestAnimationFrame` loop while one is set and stops it when the countdown ends or the element is removed. The visible clock is hidden from screen readers. A polite live region, mounted for the card's lifetime, speaks the phase changes and the countdown at 10, 5, 3, 2 and 1 seconds and at zero; its text only changes on those marks, so it never speaks per frame. Audio cues belong to the userscript.
