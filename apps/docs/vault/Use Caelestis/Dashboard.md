---
title: Dashboard
---

Browse shared artwork and watch its progress without opening Wplace. Visit your group's dashboard or [the official dashboard](https://caelest.is). Opening a saved link on caelestis.mia.cx carries your server, token and view settings to caelest.is. Anything you already saved on caelest.is takes precedence, and the server and token move only together. Open `/docs` on any dashboard to reach these guides.

## Find the artwork

1. Open a folder on the home page. Its page combines published artwork from that folder and its subfolders.
2. Select a template for its dimensions, position, progress and individual history. **View on wplace** opens its location when a world-map link is available.
3. Share the page address to link directly to the artwork. Discord previews can include a template timelapse or the server's preview image. Cloudflare servers refresh published templates' share GIFs daily.

![Folders and template cards on the dashboard home page.](images/dashboard/home.png)

![A template page with its map and progress bar.](images/dashboard/template.png)

## Compare a timelapse with the target

1. Open a template or folder. Zoom into the map and adjust **Template overlay** to compare the target with the recorded tiles.
2. Press play below the map. Choose a playback speed or drag the timeline to a date. Scrubbing the progress chart moves the map to the same point.
3. Return to the live end to see the latest observation. A frozen template's timeline ends at its freeze point.

![Playback speed, timeline and live indicator below the map.](images/dashboard/timelapse.png)

![A folder timelapse paused on 31 October, with the progress chart's playhead at the same point.](images/dashboard/timelapse-playhead.png)

## Read progress and pace

**Progress & pace** shows how many pixels match the target and how many have the wrong colour. Combined pace uses the change in matching pixels between observations. It includes work by painters who do not use Caelestis. A change to the target artwork can move the progress line without counting as painting.

| Control | What to look for |
| --- | --- |
| **pace** | Choose rolling windows. A short window shows bursts of work. A longer one smooths them out. Choose windows from **30m** to **30d**. The 30-minute line uses the last day's detailed history. |
| **who** | Select **All users** for combined pace or search for individual painters. Individual lines count reported placements and the painter's Wplace colour. |
| **range** | Choose how much history to show. Drag the handles below the graph to narrow the dates. Double-click the time window to show everything. |
| **based on** | Choose the history window for the completion estimate. The default is seven days. |

Hover the graph for counts and rates in pixels per hour. Scroll over a tall hover card to read all its rows. A rolling rate can reach zero between observations. A gap in archive coverage means the server lacks a measurement. Dashed sections use [imported snapshots](Progress-and-collaboration#backfill-a-template-or-folder).

![Progress and pace with its window selectors and timeline.](images/dashboard/pace.png)

![The who selector open, listing All users and each painter with their reported pixels.](images/dashboard/pace-who.png)

![The based on selector open, from last day to all.](images/dashboard/based-on.png)

![A hover card for an imported snapshot, with its date, source and correct and mismatched counts.](images/dashboard/hover-card.png)

## Find remaining colours and contributions

**Progress by colour** shows how many pixels match each colour. Use **Sort by** to find the largest remaining jobs.

![Colour progress with its sort control.](images/dashboard/colour-progress.png)

**Leaderboard** ranks recorded painter contributions. In **Contributions**, use **who** to view one painter or **All users**. Hover a day to see its activity.

![The daily contribution heatmap.](images/dashboard/contributions.png)

![Contributions filtered to one painter with the who selector.](images/dashboard/contributions-who.png)

## Connect the dashboard

A dashboard can use its owner's backend connection. If the footer offers **connect to a server**, enter the **Server URL** and any required **Access token**, then click **Connect**. On a dashboard with a fixed address, **access token** appears when the server requests one.

![Connect to a template server, with an example Server URL, an empty Access token field and Connect.](images/dashboard/connect-server.png)

For a connection error, see [Troubleshooting](Troubleshooting#the-dashboard-says-it-cannot-reach-the-server).
