---
id: commitments-and-slips
title: Commitments and slips
keywords: commitment committed slip slipped due date on time delivered missed late moved epic pending dropped
---
Records with due dates (such as epics) are measured by their **commitments**. Each committed due date is one commitment, counted in the month it falls due.

- **Met**: the record was done on or before the due date.
- **Slipped**: the due date moved to a later date. The original date counts as **missed** in the month it was due: a slip dings the committed month. The commitment then resets to the new date, which is met or missed in its own month like any other.
- **Pulled in**: a due date moved earlier simply replaces the old one; nothing is missed.
- **Missed**: the due date has arrived (as of the latest upload) and the record is not done.
- **Pending**: the date has not arrived yet. Pending commitments are not counted until they resolve.
- **Dropped**: the record was cancelled on or before the date. It is not counted.

An on-time metric is usually commitments met divided by commitments resolved (met plus missed, slips included). A record that slips twice and then ships on its third date adds two misses and one met, each in the month it was due.

Earlier due dates come from a prior-due-dates column in the export, or from the due date changing between uploads. Outcomes are judged as of the latest upload's as-of date.

To explain a commitment metric, list the records behind the cell: each shows its due date and whether it was met, missed, slipped or pending.
