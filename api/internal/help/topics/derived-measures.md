---
id: derived-measures
title: Derived measures
keywords: derived derive records count sum weighted open days age formula measure rollup ratio typed entered
---
A **measure** is an input quantity; a **metric** is a formula over measures that gets a status. A measure is either **entered** (typed in or imported as a value) or **derived** from records by a rule.

Derivation rules:

- **Count**: records whose chosen date falls in the period.
- **Sum**: a number field of those records.
- **Daily open, weighted**: for each day a record is open, the weight of its priority that day.
- **Commitments**: met or resolved due dates (see commitments and slips).
- **Days in period**: the days elapsed in the period through the cutoff.
- **Age sum**: days between two dates, counting through the cutoff while still open.

A rule can filter records with a condition (for example priority is high). Each record lands on the org unit or tracked item its product or team value matches. Values run through the latest upload's as-of date (the cutoff), and only from the record type's tracked-from month.

If someone typed a value for a slot that records also derive, the typed value stays unless an admin chooses the records value during an import.

**Roll-up**: each measure is combined across units (sum, minimum, maximum, average or latest) and across months before the formula runs. A ratio for a quarter or a division is therefore computed from the summed parts, not by averaging the monthly ratios. A unit's own entered value wins over the roll-up of its children.
