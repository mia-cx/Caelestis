# Template display modes

Favourites keep the original template icon with a fixed-size count badge over its corner. The badge occupies no layout space, including when the count changes or disappears. Clicking the icon opens a compact native popover with the people who keep it and the permitted actions. Opening, assigning, and dismissing never change tree layout. Progress totals and colour rows share the template icon column without an extra inset.

The favourites popover reads top to bottom: a header with the template name and count, the people list, then actions. People and the empty state share one row height. Actions are full-width menu rows below a hairline, in the same idiom as the template context menu, so switching Favourite and Unfavourite changes only the label and icon. The assignment form opens below the actions without moving them.

Popovers and menus use `--caelestis-popover-shadow`, a short shadow sized for small floating surfaces. The large `--caelestis-shadow` belongs to the panel and dialogs. Every popover hangs from its trigger through `anchorPopover` and follows it while open.

The grid helps people recognize artwork without knowing template names. Tree remains the default working view.

Use the existing panel typography, colors, progress meter, lifecycle markers, and actions. The sidebar stays in tree mode. Its header opens the same menu in a native modal, where a compact view switcher sits beside sorting. Closing or docking restores the sidebar; the saved grid preference applies only inside the modal.

Cards keep artwork above their name, dimensions, source, and progress. Compact corners do not inherit Wplace's large surface radius. An inset artwork area leaves the current-template border uninterrupted. A subtle tint and border identify the current template without the tree's left-hand rail. Checkerboard transparency follows the issue reference; pixelated drawing preserves the template artwork.

The same ordered entries render in both modes. Folder rows span the grid and retain expansion and visibility controls. Cards show their folder path so mixed folder/template custom order stays understandable. Use one column in narrow panels and additional columns when cards have sufficient space. Keep actions visible in grid mode for touch and keyboard access.

In tree mode, fly-to sits with the other hover actions rather than beside the name, and the context menu opens with Go to first. On devices without hover the tree shows only names and visibility switches: the inline meter and hover actions are hidden, press-and-hold on a row opens the context menu, and touch drags yield to that hold. Grid cards keep their visible actions.

Preview canvases have bounded backing dimensions and draw only near the scroll viewport. Switching mode changes no template data or viewport focus.

Grid progress opens from the card's progress bar into a separate details pane. Totals and per-colour progress appear together, with readable labels and an independently scrolling colour list. Cards never expand into long reports. At narrow widths, the pane covers the grid and temporarily makes the covered controls inert. Closing or Escape returns focus to the progress button. Tree mode retains its inline disclosures.

Both the inline disclosure and the pane list colours with `ColourProgress`, the same rows the website shows. Palette swatches identify colours. Progress bars keep the same complete, mismatched, and unpainted meanings throughout, including white and black artwork colours.

The popout uses 96% of viewport width and height, leaving a small backdrop margin even on wide displays. A native select beside Colours orders the pane's breakdown with `COLOUR_PROGRESS_SORTS`; palette order breaks ties. Switching templates within the open pane keeps the chosen order.

# Template filters

The filter button follows search and matches the existing 32px sort control. While filters apply it takes the DaisyUI soft primary button look and carries the selected count as a primary badge on its corner.

The nonmodal popover is a DaisyUI dropdown menu rebuilt on the tree's theme tokens, since the shadow root cannot reach wplace's stylesheet: a card-radius surface, a heading with a ghost Clear button, menu-title legends, and one menu row per choice with a small primary checkbox drawn the way DaisyUI draws it. SortMenu shares the same surface and item radii. Choices apply immediately. Escape returns focus to the trigger; Tab follows the controls and exits normally. Clear filters preserves the search text and returns focus to the first choice before its button becomes disabled.

Visibility means effective visibility, including ancestor switches. Active means not marked finished; timelapse freezing is independent. Local templates have no server lifecycle or alarm state. Server-only categories appear when the current canvas has server templates, including cached rows offline, or a saved choice needs clearing. No active alarm requires an authoritative telemetry snapshot; unknown telemetry matches no alarm choice.

The matcher selects templates before rendering and retains only their folder paths. Filters force those paths open without changing saved collapse or custom-order preferences.

Clicking the open menu's trigger closes it even when pointer focus returns to the trigger first. Alarm acknowledgement follows the displayed template rows, so search and filters cannot silently acknowledge excluded templates.
