# Template status

Finished and frozen are passive states. Mia chose emoji indicators so they fit beside the template name without adding a text row.

- Show one indicator. Finished templates are automatically frozen, so ✅ takes precedence over 🧊.
- Place a 10px ✅ or 🧊 over the lower trailing corner of the existing 16px template icon.
- Where there is no template icon, show the selected emoji at 16px.
- Name the icons “Finished” and “Timelapse frozen” in tooltips and accessible labels.
- Show grief as an inline ⚠️. Put the alarm description and exact pixel count in its tooltip and accessible live status.
- Use the server's regression episode, not the current mismatch count, for grief warnings. New incorrect paint alone does not create an episode.

Keep the existing panel, controls, theme tokens, and focus indication. Both states occupy the same space without widening the row.
