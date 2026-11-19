---
title: Progress and collaboration
---

Check which pixels still need paint, find nearby painters and mark your work area. A connected server shares those observations with other painters.

## Read a template's progress

In the template panel, expand a row's progress. Open **Show colour progress** for the per-colour breakdown.

The counts separate correct, mismatched, and unpainted pixels. You can inspect a template, folder, or server.

![Expanded userscript progress with its counts and colour breakdown.](images/progress/template-progress.png)

Server progress measures observed canvas pixels. Paint reports identify contributors. A coverage gap means some of the canvas has not been observed yet.

The [dashboard](Dashboard) shows shared progress and history outside Wplace.

## Finished, frozen, and warnings

Server administrators can open a template's actions menu and choose **Mark as…**.

| State | Meaning |
| --- | --- |
| Finished | Marks the template as finished and stops ordinary work reporting for it. |
| Frozen | Keeps its timelapse at the chosen endpoint instead of continuing the recording. |
| Regression or grief warning | Reports a loss of correct pixels. Sustained-grief alerts track continuing damage. |

![The server template's Mark as menu with Finished and Frozen options.](images/templates/lifecycle.png)

Marking a template **Finished** also freezes its timelapse. To resume recording, clear **Finished**, then clear **Frozen**. Reopening alone does not thaw it.

An administrator can use **Dismiss grief alert** when an alert has been dealt with.

## Backfill a template or folder

Import older world-map history from the Eralyon archive on a season 0 server you administer.

1. Right-click a server template or folder and choose **Backfill history**. For a folder job, both your client and server must support folder backfill. It includes templates in subfolders. With a template-only version, run the action on each template.
2. Choose a UTC snapshot under **Backfill from**. Check the template, snapshot and tile counts and any gaps in coverage.

   ![The Backfill history form for one template, with its earliest snapshot, snapshot count and archive gaps.](images/progress/backfill-template.png)

   ![The folder form, counting five templates and five tiles per snapshot.](images/progress/backfill-folder.png)

3. Click **Backfill**. You can close the form or tab and reopen it to check progress. **Cancel** stops remaining work and keeps imported observations. Use **Retry backfill** after a cancellation or failure.

   ![A running backfill at 174 of 421 tile observations, with imported, skipped and failed counts and Cancel.](images/progress/backfill-running.png)

The server compares snapshots with the current artwork at its current position. Existing observations take precedence. Archive pace measures net progress between snapshots. The archive cannot identify who painted those pixels.

## Favourites

Use **Favourite** in a template's actions menu to save it in your work list. Use **Unfavourite** to remove it.

Open **Favourites** to return to saved work. Administrators can select **Show everyone's favourites** on the servers they manage.

## Nearby painters

Enable **Share where I am** in Settings to share your viewport and draft pixels while the tab is open. Enable **Show other painters** to see other people's shared activity.

The Painters drawer lists people near your viewport. Its online total can include people elsewhere on the server. Use the flight button beside a painter's name to visit their shared viewport. In the claims list, **Clear claim** removes one of your saved regions.

[Sharing settings](Settings-and-shortcuts#sharing-and-painters) let you control viewports and claims separately.

## Claim an area for this painting session

With presence sharing active, open Wplace's paint drawer. Hold Ctrl and drag a rectangle on the map. Ctrl-click your rectangle to remove it. Closing the paint drawer or the tab clears your temporary claims.

## Draw a region claim

Sign in to Wplace and connect with a report or administrator token. The server must support painter presence. Choose **Claim a region** in the Painters drawer, or press its shortcut, `M` by default.

Choose a drawing tool, then draw the area you intend to paint. The editor has shape, pen, pencil, brush, selection, lasso, eraser, and hand tools. Hold or right-click a grouped tool to open its alternatives.

![The claim editor before drawing, with its tools on the left and Save claims at the top.](images/collaboration/claim-editor.png)

Click **Save claims** to save the current regions. **Cancel** discards the edits.

Use the selection tool to move, resize or rotate a shape. Use direct selection to edit its anchors. Saved claims can cross template boundaries. They expire after 30 days without renewal from an authenticated owner connection.
