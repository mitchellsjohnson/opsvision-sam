---
id: rca
title: Why?, attribution and exec summaries
keywords: why rca attribution exec executive summary summaries publish gate required incident incidents downtime overlap unexplained explained remainder
---
**Why?** opens a card that explains a cell that is not perfect: what it is short by, what counts against it, and what nothing explains.

**Attribution** is computed for every cell that is not at its best status, or is below its ideal (100% for uptime and ratios, the plan for money) even when it is at its best status.

- **Downtime metrics** (uptime) count imported incidents to the minute. Each incident's minutes inside the month, at its impact (a 40% partial outage counts 40% of its minutes), become points of the gap. An incident that started the month before counts only the minutes that fell in this month.
- **Overlaps are counted once.** When two incidents overlap on the same service, the overlapping minutes count once, split between them by impact. Nothing is counted twice, so the parts never add up to more than the downtime reported. This is the conservative overlap rule.
- **The rest is always shown.** When the incidents explain less than the reported downtime, the remainder is shown as "not explained" (for example `0.09 pts · 40m of the 7h 00m reported`). When they add up to more, the excess is shown as "more than reported". Incidents never change the metric's value.
- **Other metrics** list the records behind the value: the epics that missed, the defects that weigh most, the spend over plan.
- A company cell with no value of its own (uptime across services) shows its worst three services and their attribution lines.

**Exec summaries** are one or two sentences an admin writes for each metric that is not perfect in a month, for the whole company, with up to 25 links. Only admins write, edit or delete them, on every channel (the app, an API token, MCP). Everyone who can read the company's values reads them.

- A summary is **required** when the company is not at its best status, or below its ideal even at its best status, or (for a metric with no company value) any reporting subject is. A metric that is perfect, or not reported, needs none; an admin may still write one.
- A quarterly, twice-yearly or yearly metric's summary belongs to its own period and is required in the month that closes it.
- A summary is **stale** when the value, status, services short of 100% or counted incidents changed since it was written. Stale summaries still count as written.

**The publish gate:** a month cannot be published while any required exec summary is missing. Publishing (including republishing a later revision) answers with the list of missing summaries, each with its standing and why it is required, and nothing is published. Nothing ever stands in for a missing summary: not a computed sentence, not a SAM draft. A published revision keeps a frozen copy of every summary as it was at publication; later edits change the live summary only.

An admin can ask SAM to draft a summary from the attribution. The draft is a suggestion inside the editor: it is never saved, exported or counted for publishing until the admin uses it and saves.
