---
id: report-publishing
title: Report publishing
keywords: report monthly publish published summary revision facts export pdf pptx company
---
The **monthly report** is one month of a scorecard at company scope. It shows short facts (metrics that turned to the worst status this month, a first best status after a run of months, metrics not reported), what needs attention, values by category, and a written summary.

- Admins write the summary. Saves are checked against the last version loaded, so two people cannot silently overwrite each other.
- An admin can ask SAM to **draft** the summary. SAM reads the live company report (its facts, what needs attention, and the values by category) with the admin's own Claude key and writes a few sentences from those numbers only. The draft is private to that admin, kept for 24 hours, and never saved as the summary until the admin reviews it and saves.
- An admin **publishes** a month. That freezes the report, with the summary saved at the time, as revision 1, then 2, and so on. Publishing does not lock the month's data (see live and locked periods).
- Opening a month shows its latest published revision, or the live report when none is published. Earlier revisions and the live report stay available. A published revision whose numbers no longer match the live data is marked as revised, with the changed cells listed.
- Each member sees the report filtered to their own access scope.
- The report can be downloaded as PDF or PowerPoint.

The summary is the admin's words. Facts and values come from the data.
