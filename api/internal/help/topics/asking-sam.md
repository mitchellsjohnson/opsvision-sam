---
id: asking-sam
title: Asking SAM
keywords: sam assistant ask key claude model privacy cost tokens chat thread read only
---
SAM is the OpsVision guide. It answers questions about your scorecards, such as how a metric is measured, why a number moved, or what needs attention, by reading the same data you can see, plus these help topics.

- **Read only.** SAM cannot change anything. It can suggest what to do; you do it in the app.
- **Your access.** SAM reads as you, so it sees only what you can see.
- **Your key.** SAM runs on your own Claude API key, saved in My settings → Ask SAM. Your questions and the data SAM reads are sent to the model provider under that key, and your key pays for them. Each answer shows the tokens it used.
- **Model.** An admin chooses the model for the organization (a lower-cost one by default) and can turn SAM off.
- **Context.** SAM starts from the page you were on: the scorecard, period, scope and metric. Name another period, unit or metric to change it.
- **Threads.** Conversations are private to you. The 50 most recent are kept.

SAM cites the values it uses with their period and scope, and says when data is missing. If an answer looks wrong, open the cell it cites and check.
