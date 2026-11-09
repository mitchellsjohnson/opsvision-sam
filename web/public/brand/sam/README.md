# SAM artwork

SAM is OpsVision's AI guide, a wise owl. These files follow
[`docs/brand/sam-creative-brief.md`](../../../../docs/brand/sam-creative-brief.md).

| File | Use |
|---|---|
| `sam-mark.svg` | Head, neutral. Favicon, the "Ask SAM" button, one-pager signature. |
| `sam-mark-happy.svg` | Head, happy. Successes and green results (for example, records applied). |
| `sam-mark-thinking.svg` | Head, thinking. Loading states ("getting your preview ready"). |
| `sam-mark-concerned.svg` | Head, concerned. Red metrics and errors; sympathetic, not alarmed. |
| `sam-mark-mono.svg` | Head in `currentColor`. Monochrome and dark placements. |
| `sam-full.svg` | Full body, neutral. Empty states and onboarding. |
| `sam-full-celebrating.svg` | Full body, wings up. First-ever green, closing a month, finishing setup. |

Marks use `viewBox="0 0 64 64"`, full-body art `viewBox="0 0 256 256"`. Every `id` is
prefixed `sam-`, and each file has `role="img"` and `<title>SAM</title>`. The app shows
SAM decoratively (`alt=""`) next to text that carries the meaning.
