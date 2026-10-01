The pace picker shares the painter picker's searchable, multi-select popover and menu styling. Keep the legend compact, with solid green and red swatches for correct and mismatched pixels. Painter lines show placements.

Each painter wears the colour Wplace shows beside their `#ID`: Tailwind's `500` shade at `palette[id % 14]`, the same in both themes. Lines, picker swatches, and tooltip dots share it. Painters whose ids collide share a colour; never reassign by chart order.

The contribution heatmap's "who" picker shows everyone or one painter, chosen by Wplace id. It uses the pace picker's popover and search, lists painters from the heatmap's own history, and shows `#ID` so namesakes stay apart. One painter's view leaves out imported archive estimates, which have no painter.

Short pace windows use darker magenta; longer windows become lighter blue, never cyan. Interpolate the theme's `--pace-short` and `--pace-long` endpoints in OKLCH along the shorter hue arc. The light theme uses a lower lightness range to retain contrast. Use the same colours for lines, picker swatches, and tooltip dots.

Imported daily and longer pace segments are dashed and connect to solid reported segments at a shared endpoint. Saved native observations supply the progress handoff; current totals never reconstruct past values. Keep coverage gaps explicit. Imported progress keeps dashed green and red boundaries. The chart has no separate snapshot table.

Wait for the initial imported, native, and pace reads before mounting the chart. All series share the existing startup wipe; subsequent refreshes preserve the mounted chart. Reduced motion keeps the existing instant reveal.

The time-range overview uses the full chart's saved progress, including backfill and coverage gaps. Use cumulative placements only when no progress observations exist.
