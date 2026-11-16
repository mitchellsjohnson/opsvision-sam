---
id: statuses-and-bands
title: Statuses and bands
keywords: status green yellow red color rule threshold override judged
---
Every value on a scorecard is judged by its metric's **status rule**. The organization's status scale names the statuses and ranks them; the default is Green, Yellow and Red, where a higher rank is worse.

A rule is one of three types:

- **Bands**: thresholds checked in order (for example `>= 90` Green, `>= 80` Yellow, anything else Red). The first band the value meets wins; the last band, with no comparison, catches everything else. A rule can give one unit or item its own bands.
- **Scale**: steps with a minimum; the value gets the step with the highest minimum it reaches.
- **Change**: judges improvement rather than the raw value. The improvement is the percentage by which the value beats a reference, in the metric's better direction: the prior period, the prior fiscal year's value, or a baseline target. With no reference (or a zero reference and a non-zero value) there is no status.

Bands and scales judge the value rounded to the precision shown, so the status always agrees with the number you see.

A blank cell (an input is missing) and a not-applicable cell have no status. Neither is the same as zero.

An admin can override a cell's value or status for one period. The cell then shows the override and keeps the computed value and status alongside it.

Statuses are always shown with a label or symbol, never by color alone.
