# Capture lobby card

One small floating card for capture lobbies in a Wplace territory event. Any painter who can write opens a lobby and hosts it; others join. The host locks in a planned wall, the wall is cut into legs, and the countdown takes each painter with a leg to their own slot. An administrator in a lobby can run it too; the model calls either `canRun`. One card serves every member; the controls for running the lobby appear inside it.

## Placement

The element positions itself: `position: fixed` at the top left, beside Wplace's column of map buttons, at `--caelestis-capture-run-top` (default `0.5rem`) and `--caelestis-capture-run-left` (default `3.5rem`). There it clears the bottom-centre Paint button and drawer and Caelestis's right-hand rail and panel. A host moves it with those properties, or by setting `inset` and `z-index` on the element. In a window 1080px wide or less, Wplace's event scoreboard reaches the card's corner, so the card drops below it to `--caelestis-capture-run-top-narrow` (default `10.5rem`) and stops 6.5rem above the bottom, clear of the Paint controls. On a phone (480px wide or less) it also moves to the left edge and leaves 5rem for Wplace's right-hand buttons. Heights use `dvh`, so a phone's browser toolbar never hides the card's end. A window under 560px tall has no room below the scoreboard, so there the card takes the top and the full height, over the scoreboard. It sits at z-index 31 like the claim editor: above the docked panel, below its popovers. The card is 17rem wide and scrolls within the viewport instead of growing past it.

The page decides visibility: a painter who can write always gets the element, and one who can't only while the team has a lobby to see. It enters with a short rise on its own and exits through `closeSurface`'s `data-state="closing"`.

## Collapsing

The header is a disclosure button over the whole bar: the card's title, a one-line summary under it, and a chevron. It toggles the rest of the card with `aria-expanded` and `aria-controls`, by pointer, Enter or Space. Collapsed, the card is the bar plus whatever has to be read at a glance:

- **list**: the summary counts the open lobbies, or reads "None open".
- **gathering**: the summary gives the lobby's size and, once a wall is locked in, how many legs are drafted ("5 painters · 2 of 4 ready"). Guards and reserves are left out of that count, as they are of Start countdown.
- **countdown**: the clock stays under the bar at full size with its lead and turn, so a painter can collapse the card and still paint on time.
- **guard watch** and **done**: the anchor's state, or "Capture finished", stays under the bar.

`message` also stays visible when collapsed. The card emits `set-collapsed` and renders `model.collapsed`; it holds no collapse state of its own. The userscript keeps the painter's choice per browser, so the card comes back the same after the arena leaves view. Until the painter chooses, the card starts collapsed on a phone, where an expanded card covers most of the map, and expanded on wider screens. Joining or opening a lobby means expanding the card first, so a phone painter in a lobby has already made their choice; the countdown needs no exception because the collapsed card shows the clock.

The host's settings fold the same way behind a "Settings" disclosure whose summary lists the current values ("5 painters · 1 guard · Even · 500 ms · 10 s"). Each value stays whole, so the rare summary too long for one line wraps between values rather than hiding one. The settings start folded each time the card mounts.

## Touch

On a coarse pointer every button in the card is 2.75rem (44px) square or tall: Join, Lock in, the steppers and their fields, the Legs choice, Show my line, Give closing leg, move up and down, the footer actions, and both disclosures. A row the host can order puts its readiness and buttons on a second line under the name, so a 17rem card at 390px never overflows. A fine pointer keeps the compact desktop rows.

## States

- **list**: the team's lobbies whose countdown has not started, largest first and, at one size, oldest first. Each row has its host's name, its painter count, and Join. Painters who can write get New lobby, the primary action only while there is no lobby to join. With none open, the bar's summary says so and New lobby is the card's only content.
- **gathering**: the host's Settings disclosure holds steppers for Painters (1 to `maxPainters`) and Anchor guards (0 to `maxGuards`, half the lobby), the Legs choice (Even or Reserve), the Stagger stepper (100 to 2,000 ms in 50 ms steps), and the Countdown stepper (3 to 30 s in 1 s steps, the time from Start countdown to the first painter's slot) at the top. Even gives every painter a leg; Reserve cuts the fewest legs that fit, and the painters past them read "Reserve" on their row and get no leg, slot or steps. Below the settings is the paint order as numbered rows: colour swatch, name, drafted/length with a check once ready, and a button to fly to your own leg. The host reads "Host" on their row. If they leave, the member who has been in the lobby longest hosts. The closer, at first the host who opened the lobby, reads "Closes wall" (so "Host · Closes wall" while they are one painter): they keep the closing leg's place, so their row has no move buttons and the rows either side of it move past it. The host gets Give closing leg and move up/down on every other row, and Close lobby; the member they give it to swaps places with the closer, who takes over their old role, and the host stays host. Before a lock-in the host sees the live proposals (where the wall goes, territory gained, pixels painted, Lock in); Lock in is disabled, with "Needs N more painters", while a leg would exceed a painter's charges. After a lock-in they get Cancel proposed shape and Start countdown, which stays disabled until every row with a leg shows it drafted; guards and reserves don't hold it. Only Lock in hands out legs: a painter who joins after it reads "Reserve", with no leg or slot, until the next lock-in. One who leaves after it keeps their row, undrafted, and Start countdown stays disabled, with a message saying why, until the host cancels the proposed shape and locks in again; joining again from the same browser takes the place back. Painters and guards see the steps for reaching their leg once a wall is locked in. Everyone gets Leave.
- **countdown**: the clock reads `mm:ss.mmm` in large tabular numerals, counting to this painter's slot (`mySlotAt`), or to the first painter (`startsAt`) for everyone else. It clamps at `00:00.000`; at a member's slot the lead reads "Paint now" and the clock turns primary.
- **done**: "Capture finished", the final order, and Leave. The host also gets Plan next shape, which takes the same lobby back to gathering: its settings and the members still in it stay, and planning starts again.

`message` is the only status line; the card adds no notices of its own.

## Countdown

Deadlines are `performance.now()` times, so the card runs its own `requestAnimationFrame` loop while one is set and stops it when the countdown ends or the element is removed. The visible clock is hidden from screen readers. A polite live region, mounted for the card's lifetime, speaks the phase changes and the countdown at 10, 5, 3, 2 and 1 seconds and at zero; its text only changes on those marks, so it never speaks per frame. Audio cues belong to the userscript.
