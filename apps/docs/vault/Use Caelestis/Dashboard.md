---
title: Dashboard
---

The dashboard shows a server's published templates and their recorded progress. It does not show templates stored only in your browser.

Open the URL your server owner gives you, or visit [the official dashboard](https://caelest.is).

## Browse templates

The home page groups artwork by folder. Click a folder to browse its contents, or a template to open its page.

![The dashboard home page with folders and template cards.](images/dashboard/home.png)

A template page shows its artwork, dimensions, position, and completion. **View on wplace** opens its location on the map.

![A template page with its progress bar, map, and View on wplace link.](images/dashboard/template.png)

## Compare the artwork with the canvas

Use **Template overlay** below the map to blend the target image with the observed canvas. Zoom or use the fit control to inspect the artwork.

The canvas view reflects tiles the server has observed. It may lag behind a recent change on Wplace.

## Play a timelapse

Click the play button below the map. Use the timeline to choose a point in the recorded history, and the speed control to change playback speed.

The **live** indicator identifies the current end of the timeline. A frozen template's recording ends at its saved freeze point.

![The play button outlined in orange, followed by playback speed, timeline, and live indicator.](images/dashboard/timelapse.png)

## Read progress and pace

**Progress & pace** combines the correct-pixel and mismatch history with painting-rate lines.

Use **pace** to choose averaging windows, **who** to choose painters, and **range** to change the time shown. The completion estimate has its own history-window selector.

![The complete Progress & pace chart, including its legend, selectors, range buttons, and timeline.](images/dashboard/pace.png)

An estimate depends on the observed activity in that window. It changes when the painting rate changes.

## Contributions

The leaderboard lists recorded painter contributions. The contribution heatmap groups activity by day; hover a day to inspect it.

![The contribution heatmap with months, weekdays, and intensity legend.](images/dashboard/contributions.png)

## Progress by colour

The colour list shows completed pixels against each colour's total. Use **Sort by** to find the colours with the most work left, compare completion, or group free and premium colours.

![The Progress by colour heading, sort control, and colour rows.](images/dashboard/colour-progress.png)

## If the page does not load

The dashboard's backend connection is configured by its owner. Visitors do not enter the server's read token into this page.

If you see **Could not reach the template server**, ask the owner to check the backend connection and frontend read token. See [Troubleshooting](Troubleshooting#the-dashboard-says-it-cannot-reach-the-server).
