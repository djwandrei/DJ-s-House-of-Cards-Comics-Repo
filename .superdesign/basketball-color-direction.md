# DJHC basketball palette preview

This is a design-review extension, not a production change. Preserve the
existing DJ company logo. No NBA/team logos, affiliation claims, source-data
changes, or private Scout values. The selected team automatically drives its
appearance, one way. Appearance controls must never change a team, roster, rule,
or result. The preview team selector is illustrative and does not load real data.

## Default and optional personalities

Collector Court is the proposed DJHC default: ink navy canvas, restrained
royal-blue/red details, warm gold active controls, off-white type. Dark opens
first; the user can choose light, and that choice survives team changes. DJHC is
the fallback when no supported team is selected. All 30 NBA teams have named DJHC
interpretations in `basketball-palettes.mjs`, not claimed official specifications.

Use the reference at https://nbacolors.com/ for recognizable seed hues, not its
page layout. The reference contains historical sets and at least one malformed
color label (Phoenix yellow is encoded black); do not blindly mirror it. Atlanta,
LA Clippers, and Utah use separately documented contemporary directions with
our own chosen UI shades. Exact source seeds remain distinct from derived tokens.

## Preview requirements

- Keep the five-step coaching journey and actual DJ/Lab emblems from the active
  draft. Refine its color system; do not replace the builder with a dashboard.
- Keep one visible Team selector, linked to the step-1 team context. It drives
  the palette automatically, without a separate color-team selector or Apply.
  The compact "Court style" drawer shows the derived palette name, three labeled
  seed swatches, and Dark/Light. Reset display returns to dark without changing
  the selected team. Start with the existing Minnesota demo and its dark palette.
  No team selection uses DJHC. Keep the coaching controls primary.
- Show the selected style across the canvas, panels, controls, selected cards,
  progress indicator and ticket. Use the exact `themeFor` role tokens. Never use
  a trim color for text without a contrast check. Focus is a two-layer outline.
- Athletic Barlow Condensed 700 headings and Manrope body/controls. Use proper
  @font-face declarations with the already uploaded TTF URLs, not @import TTF.
- 44px minimum touch targets; native selects with a clear label, custom closed
  affordance, and native keyboard behavior. No horizontal overflow at 320px.
- Coach prompt browsing changes only the prompt; Apply changes only strategy.
  Selected cards use aria-pressed plus a checkmark. Simple/Detailed work on mobile.
- Update the team context when it changes, retain the demo-season label, and show "Interactive design
  preview — no live data or optimizer run". Do not invent predictions or scores.
- Build types: Starting five (5 players), Full rotation (8–12 players, 240 minutes).
  Advanced evidence example: Historical box-score profile, no fabricated opponent
  options. Buttons to other unimplemented steps clearly explain preview scope.
- Motion is brief (160–280ms) and state-triggered, never flashing or looping.
  Respect prefers-reduced-motion, including live preference changes.
- Keep Fan Tools link https://www.djshouseofcards-comics.com/tools/.
- Show a source note linking nbacolors.com and call these team-inspired DJHC
  palettes. Existing emblems stay full color and are not recolored by the theme.

## Accessibility policy

The palette generator checks text and controls in 62 combinations (31 schemes,
two modes). Primary text >=7:1, secondary/status/action text >=4.5:1, control
borders/focus >=3:1, action labels >=4.5:1. These token checks are not a claim of
whole-page accessibility conformance; rendered and interaction checks follow.
Errors, warnings, and success keep distinct semantic roles and visible words/
icons. Team reds/greens do not become failure/success meaning. Color alone never
indicates a chosen plan, current step, validation result, or data availability.
