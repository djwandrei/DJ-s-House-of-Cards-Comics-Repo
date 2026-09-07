# Lineup Lab design system

## Product intent

Lineup Lab is a fan-facing, exact NBA lineup and rotation optimizer. It finds
the highest-scoring eligible group for the constraints a fan enters; it does
not imitate a historical coach's rotation, predict wins, or claim chemistry.
The interface should make that contract obvious before a result is shown.

## Visual direction

- Use the existing DJHC visual language: deep navy for structure and trust,
  royal blue for active controls and data emphasis, red only for the primary
  solve action or destructive emphasis, and a restrained gold focus accent.
- Keep the cool blue-gray page canvas and white cards, but reduce the number of
  competing borders, shadows, pills, and gradient treatments. One visual
  emphasis should be obvious at each step.
- Preview direction requested September 7: use Manrope for readable UI copy,
  controls, and navigation; Barlow Condensed 700 for athletic display headings
  and scoreboard numerals. Keep DJ's existing script wordmark unchanged. These
  font changes were approved for Lineup Lab and the fan suite on September 7.
- Minimum interactive target is 44px. Body copy should remain at least 15px
  on desktop and 16px on narrow screens; labels and help text should be short
  enough to scan without creating a wall of microcopy.
- Evolve toward a premium professional-basketball product: compact broadcast
  hierarchy, tabular numbers, crisp 12–16px cards, thin separators, strong
  selected-menu states, and restrained gold/royal-blue accents. No NBA logo,
  league mark, sponsor mark, or claim of official affiliation.
- Motion: finite 160–280ms control and panel transitions, subtle badge bounce
  on intentional input, and brief step/result entrances. No flashing or
  ambient loops; respect reduced motion. Keep source warnings visible.
- Reuse the original Lineup Lab basketball emblem beside the hero title; the
  DJ company logo remains the header identity. The optional Coach's prompt
  cards in the Game plan step browse Balanced/Defense/Offense ideas without
  changing settings until explicitly applied. They never trigger a solve.
- Team colors follow the selected team automatically. Dark/light remains a
  separate user preference and survives team changes. If no supported team is
  selected, use the DJHC fallback. Appearance never writes back to team, roster, or rules.
  This one-way behavior is approved for the real team selector. Unselected and
  unsupported historical codes retain DJHC; appearance never chooses a team.

## Information hierarchy

The primary path is: select team and season → choose a game plan → choose the
player pool → build → understand the result. Simple mode exposes only the
decisions needed for that path. Detailed mode progressively reveals advanced
weights, constraints, comparisons, and evidence rather than showing every
control at once.

The workspace navigation should read as four clear destinations: Build,
Compare, Watchlist, and How it works. Keep one compact active state with a
strong navy/blue contrast and a visible underline or inset bar; avoid making
every tab look like a rounded badge. Counts should be secondary and never
compete with the destination label.

The Simple/Detailed switch is a segmented control with a concise explanation:
Simple is the recommended guided answer; Detailed is for changing rules and
auditing the math. Do not duplicate that explanation in multiple cards.

## Component guidance

- Hero: one confident statement, one sentence of context, one primary action.
  Keep the court illustration as a quiet brand accent, not a second dashboard.
- Team-season loader: group Team, Season, and Phase as one “Data set” block;
  use sentence-case labels and a short status line. Avoid “team stint” in
  shopper-facing copy; say “stats recorded with this team” when provenance is
  relevant.
- Game plan cards: use title case and high-impact descriptions. The first
  three options are Balanced, Offense, and Defense. Advanced specialties sit
  behind Detailed mode.
- Selects and number inputs: use a clear field label above the control, one
  short help sentence below only when the choice affects the model. Avoid
  technical option labels such as “legacy comparison” in the primary path.
- Position rules: keep the legend and its explanatory sentence inside the
  bordered fieldset. State that a player may fill any verified position on his
  season/career profile, but each player occupies only one slot in a solution.
- Results: answer first, then show “Why these players?” and “What changes in
  the next-best group?” Use score definitions next to the score, not in a
  distant model page. The exact search-relative score is a within-run ranking;
  Plan Fit Index 100 is the same-season NBA baseline for the selected
  priorities. Neither is a win probability or a general player rating.
- Evidence: say “sample and role context.” Team-stint games and total minutes
  are provenance only; they never cap, target, or reward rotation minutes.
  OBPM/DBPM are modest individual box-score cross-checks, only used when the
  complete eligible pool has them.
- Menus/actions: use verbs (“Build lineup”, “Copy setup link”, “Export CSV”)
  and sentence case. Keep the primary solve action visually dominant and make
  quiet actions secondary outlined controls.

## Responsive behavior

At narrow widths, stack the loader fields and keep the Simple/Detailed switch
full width. Navigation becomes a two-row grid with equal touch targets. Keep
the solve bar sticky only while the form is active and ensure it never covers
the result heading or focused content. Player rows become cards with visible
data labels; do not require horizontal scrolling for the primary lock/exclude
actions.

## Content guardrails

- Prefer “game plan,” “eligible players,” “assigned minutes,” and “source
  sample” over “model score,” “stint,” “readiness,” or “historical guardrail.”
- Explain that the solver optimizes the user's requirements, not real-world
  historical rotations.
- Do not imply injury status, chemistry, matchup simulation, or live roster
  knowledge from box-score data alone.
- If a metric is unavailable, say it is left out for every eligible player;
  never imply the value was guessed or silently imputed.
