---
name: machun-workspace
description: Extend MACHUN1's existing light sage score workspace with its current tokens and components.
---

Use this system when editing MACHUN1's application or creating a review mockup.

- Read `tokens/colors_and_type.css` and `brand/style-notes.md` before changing presentation.
- Keep the existing light sage page, white panels, dark green text and thin separators. EXP, MAS and ULT colors identify difficulty; they are not brand accents.
- Preserve the familiar score form, source panels, B30 and records controls. Do not introduce an unrelated brand, font service or icon set.
- Give mobile controls a minimum 44 px touch target; inputs use at least 16 px type. Keep focus indicators and respect reduced motion.
- Use tabular numbers for scores and Rating. Score grouping uses commas; constants use one decimal; song Rating uses four decimals in the records table.
- Do not style errors as successes. Never say a file was downloaded when only image generation completed.
- Demo data must be explicitly fictional. Public song names and chart metadata are permitted; real accounts, scores, tokens and screenshots are not.

The UI kit recreates a small set of current components. It is a review artifact, not an application or a new runtime dependency. Source files remain the authority if this snapshot diverges.
