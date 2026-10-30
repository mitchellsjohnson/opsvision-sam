# SAM — Creative Brief

SAM is the AI guide inside OpsVision: a cute, wise owl with big eyes. This brief is for the agent producing SAM's SVG artwork.

## Who SAM is

- **Wise, not stern.** Calm, attentive, quietly confident. The friend who has read every report and still explains it kindly.
- **Precise.** SAM never guesses a number. The look should feel trustworthy and clear, never goofy or chaotic.
- **Warm, with a little dry humor.** A slight head tilt or a raised brow, never slapstick.

## Where SAM appears

| Context | Size | Asset |
|---|---|---|
| Favicon, browser tab | 16–32 px | Mark (head only) |
| Chat avatar, side panel button | 24–48 px | Mark with expression |
| Empty states, onboarding, error pages | 120–240 px | Full body |
| Monthly one-pager signature | 32–64 px | Mark |
| "SAM is thinking" loading state | 48–96 px | Mark, animated |

## Look

- **Silhouette first.** It must be recognizable as a solid shape: round body, two ear tufts, big eyes. Test it filled in a single color.
- **Big eyes** are the signature: each about 35–40% of the face width, with a large pupil and one highlight dot. Eyes look friendly and curious, never predatory.
- **Facial disc:** a soft heart-shaped or rounded face in a lighter tone, framing the eyes.
- **Small beak**, a short rounded triangle. No visible talons.
- **Subtle "data" nod (optional, keep it tasteful):** the chest feathers, drawn as scallops, rise in three steps like a small bar chart.
- **Style:** flat, geometric vector with rounded corners. No outlines, or one consistent stroke weight throughout. At most one gentle gradient. No textures, no realism.
- **Avoid clichés:** no graduation cap, no book, no magnifying glass. Small round spectacles are allowed in one optional variant only.
- **Be distinct:** SAM must not resemble well-known owl mascots. Avoid green body colors and the chunky round-blob owl shape common in learning apps.

## Palette (starting point; tune for contrast)

| Token | Hex | Use |
|---|---|---|
| `sam-plum` | `#5B4BDB` | Body, matches the app accent |
| `sam-plum-deep` | `#3F33A8` | Wings, ear tufts, shading |
| `sam-cream` | `#FFF6E5` | Facial disc, belly |
| `sam-amber` | `#F5A524` | Irises, beak |
| `sam-ink` | `#1D2433` | Pupils, brows |
| `sam-white` | `#FFFFFF` | Eye highlights |

Must read well on white (`#FFFFFF`) and on the dark theme background (`#151826`).

## Deliverables

1. `sam-mark.svg`: head only, square, neutral expression. Must survive 16 px.
2. `sam-full.svg`: full body, perched or standing, neutral.
3. Expression set for the mark (same geometry; only eyes, brows, lids, and wings change):
   - `neutral`
   - `thinking` (eyes up and to one side, slight tilt)
   - `happy` (curved, smiling eyes; for green results and successes)
   - `concerned` (brows tilted inward; for red metrics; sympathetic, not alarmed)
   - `celebrating` (full body, wings up; for first-ever green and closing a month)
4. `sam-mark-mono.svg`: single color using `currentColor`, for favicons and dark or monochrome placements.

## SVG technical requirements

- Hand-authored vector only: no embedded rasters, no external fonts, no text in the artwork.
- `viewBox="0 0 64 64"` for marks and `viewBox="0 0 256 256"` for full body; no fixed `width` or `height`.
- No filters, blurs, or masks that inflate the file; keep each file under 8 KB after optimization.
- Prefix every `id` with `sam-` so several SAMs can be inlined on one page without collisions.
- Named groups so the app can animate parts: `sam-eyes`, `sam-pupils`, `sam-lids`, `sam-brows`, `sam-wing-left`, `sam-wing-right`, `sam-body`.
  - Blink: scale `sam-lids` on Y.
  - Look: translate `sam-pupils`.
  - Think: rotate the head group a few degrees.
  - The app turns these off under `prefers-reduced-motion`.
- Accessibility: `role="img"` with `<title>SAM</title>`; decorative placements will set `aria-hidden` in the app.
- Use the palette tokens above as literal hex fills (the mono variant uses `currentColor`) so colors can be themed later.

## Acceptance checks

- Silhouette is recognizable as an owl when filled solid black.
- The mark is legible at 16 px; the five expressions are distinguishable at 32 px.
- Looks right on both the light and dark backgrounds above.
- All expressions share identical head geometry (they swap cleanly in the UI).
- Files pass SVGO without visual change.

## Output location

`web/public/brand/sam/`, with a short `README.md` listing each file and its intended use.
