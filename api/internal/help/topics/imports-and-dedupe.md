---
id: imports-and-dedupe
title: Imports and duplicates
keywords: import upload export csv file duplicate dedupe rows snapshot template unmatched source key apply preview twice
---
Data arrives two ways: values typed in the entry grid, and imports. A record import reads an export from a tracker (CSV or spreadsheet) through a saved template that maps its columns to record fields.

**Nothing is stored until Apply.** The preview counts records that are new, changed, unchanged, skipped, missing from a full export, unmatched, or in error, and shows what would change on the scorecard.

How duplicates are handled:

- A record is identified by its source and its ID in that source. Uploading the same record again adds nothing if its fields are unchanged.
- Each upload is a snapshot with an as-of date. A record keeps one revision per as-of date; a new upload for the same date replaces that revision.
- The same preview cannot be applied twice.
- An ID that appears on more than one row of a file is reported, and both rows are left out until the file is fixed.
- An ID that already belongs to another record type is an error.

Each row's product or team value must match an org unit or tracked item, by name or by a saved source key. Unmatched values wait for an admin to map or ignore them. New raw values (an unfamiliar status, say) and ambiguous dates are asked about once and remembered in the template.

For a full export, records the file no longer lists can be marked cancelled.
