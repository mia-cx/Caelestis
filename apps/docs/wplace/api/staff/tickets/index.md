---
title: "Staff: reports"
description: Staff-only routes for the moderation report queue.
---

These routes serve Wplace's staff dashboard, which ships inside the public client. They are listed so mod authors can recognise them in the bundle. Players get `401` or `403`. Their notes describe what each route is for, and nothing more.

- [[Staff-Take-the-next-report|Take the next report (staff)]]: Staff-only route that hands a moderator the next open report.
- [[Staff-Count-open-reports|Count open reports (staff)]]: Staff-only route that counts reports waiting for a moderator.
- [[Staff-Count-reports-closed-today|Count reports closed today (staff)]]: Staff-only route that counts reports the moderator closed today.
- [[Staff-Assign-a-report|Assign a report (staff)]]: Staff-only route that assigns a report to a moderator.
- [[Staff-Resolve-a-report|Resolve a report (staff)]]: Staff-only route that sets a report's outcome.
- [[Staff-Re-resolve-a-report|Re-resolve a report (staff)]]: Staff-only route that changes the outcome of a closed report.
- [[Staff-Flag-a-bad-resolution|Flag a bad resolution (staff)]]: Staff-only route that marks a report as wrongly resolved.
- [[Staff-Reset-a-reported-name|Reset a reported name (staff)]]: Staff-only route that resets the name named in a report.
- [[Staff-Remove-a-reported-picture|Remove a reported picture (staff)]]: Staff-only route that removes the picture named in a report.
- [[Staff-Get-reporter-history|Get reporter history (staff)]]: Staff-only route that shows past reports by the same reporter.
- [[Staff-List-report-reversals|List report reversals (staff)]]: Staff-only route that lists requests to reverse a report outcome.
- [[Staff-Request-a-reversal|Request a reversal (staff)]]: Staff-only route that asks for a report outcome to be reversed.
- [[Staff-Get-a-reversal|Get a reversal (staff)]]: Staff-only route that shows one reversal request.
- [[Staff-Review-a-reversal|Review a reversal (staff)]]: Staff-only route that approves or rejects a reversal request.
- [[Staff-Get-reversal-ticket-info|Get reversal ticket info (staff)]]: Staff-only route that shows the report behind a reversal.
- [[Staff-Get-the-last-reversal|Get the last reversal (staff)]]: Staff-only route that shows the most recently resolved reversal.
- [[Staff-List-every-report|List every report (staff)]]: Staff-only route that lists reports across all moderators.
- [[Staff-Review-a-moderator-report|Review a moderator's report (staff)]]: Staff-only route that reviews another moderator's resolution.
- [[Staff-Get-overturn-info|Get overturn info (staff)]]: Staff-only route that shows why a report outcome was overturned.
- [[Staff-Count-tickets|Count tickets (staff)]]: Staff-only route that counts tickets for the staff summary.
- [[Staff-Count-reports|Count reports (staff)]]: Staff-only route that counts reports for the staff summary.
- [[Staff-Count-tickets-per-moderator|Count tickets per moderator (staff)]]: Staff-only route that counts tickets each moderator closed in a range.
- [[Staff-Count-reports-per-moderator|Count reports per moderator (staff)]]: Staff-only route that counts reports each moderator closed in a range.
- [[Staff-Translate-report-text|Translate report text (staff)]]: Staff-only route that machine-translates text in a report or appeal.
