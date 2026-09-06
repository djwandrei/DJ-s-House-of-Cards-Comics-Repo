# Lineup Lab: guided coaching journey

## Existing system and retained behavior

The Lab is a static HTML page with vanilla ES modules, DOM-backed form values,
an application state object, localStorage preferences/caches, and a background
exact-search Worker. There is no frontend framework, router package, or build
dependency to replace. `app.js` owns data loading and submission;
`optimizer-core.js` owns calculations. Source lives in
`prototypes/basketball-lineup-optimizer/`; the release builder owns `lineup-lab/`.

| Stage | Preserved inputs and dependencies |
| --- | --- |
| Team & season | Historical team, season, regular/playoff phase, explicit reload, CSV import, course demo, cache/failure disclosures. A changed selector must match the loaded roster before continuing. |
| Game plan | Starting five (5) / rotation (8–12, default 9); Balanced/Offense/Defense and detailed specialties; six custom skill families; Historical/authorized Scout objective; optional same-season opponent analysis and explicitly applied/undoable weights. |
| Players | Search, mutually exclusive locks/exclusions, comparisons, private local watchlist, and Detailed rotation usage scenarios. Searching does not change eligibility. |
| Rules | G/F/C slots and verified-position policy; games/minutes eligibility; optional points/rebounds/assists/steals/blocks floors and turnover ceiling; rotation bounds (8–40 recommended), role-minute profile, risk, role balance, per-game/per-36 scoring, rate stability; report display and alternative count. Existing Simple defaults and temporary Detailed settings are preserved. |
| Review | Current source, objective/weights, named locks/exclusions, every applicable rule/report setting, with Edit actions and a complete validation pass. |
| Search | Original Worker request and exact-search guardrails, real rotation progress text, duplicate-submit guard, cancellation for either mode, existing access/network/Worker failure recovery. No invented completion percentage. |
| Results | Existing best group, Lineup DNA, baseline caveats, role coverage, exact swap, minute/unit proof, alternatives, comparison, copy/share/CSV/print, and revise/rebuild. No score or privacy boundary changes. |

Existing model calculations and API shapes remain in their original modules.
The new UI does not persist Scout responses, credentials, datasets, or results.
`workflow-state.js` contains whitelisted draft serialization, ordered steps, and
cheap structural checks. `workflow-view.js` moves—not clones—the existing
controls into an accessible shell. `workflow.css` owns only the new shell.
Application integration is through explicit capture/restore/validate/lifecycle
callbacks; the Worker submission payload is unchanged.

## Draft and navigation contract

- Browser Back/Forward uses the `step` query parameter, preserving scenario
  query parameters and route. Unvisited required steps cannot be deep-linked.
- Completed steps can be revisited without removing form nodes or selections.
- Drafts store only whitelisted settings under `djhc-lineup-lab-workflow-v1`.
  Shared scenario links take priority over a local draft and retain their
  existing replay behavior. Results are recalculated, never restored as facts.
- A draft is applied only to its matching historical roster or the course demo.
  CSV files must be reimported after a refresh. Storage failure is visible and
  meaningful unsaved work gets a browser unload warning.
- Start over confirms and clears this draft, not the watchlist or comparisons.
- Simple/Detailed retains the existing product logic: Simple applies its known
  defaults; returning to Detailed restores the prior custom settings.

## Validation and accessibility

Native numeric bounds, positive priorities, roster size, total role slots,
locks, eligibility counts, distinct role availability, and 240-minute bounds
are checked before submission. An obvious starting-five production upper bound
is also checked early. Complex joint production/minute feasibility, private
Scout evidence coverage, and optimization remain the exact engine's authority;
they are not replaced by a heuristic in the UI.

Steps have semantic buttons, numbered/textual status, current-step ARIA, heading
focus, inline field errors and a linked error summary. Inactive stages are
hidden. Motion respects reduced-motion preferences. Review and progress have
one in-flow primary action, with 44px controls and no fixed mobile solve overlay.

The Fan Tools hub now filters the live registry into Games or Build & Explore,
offers a non-navigating random suggestion, and places planned/research tools
inside a disclosure. Daily games retain their scoring contracts, gain focus
handoffs and textual progress states, and offer explicit next-play links.

## Verification

`node scripts/lineup-workflow-smoke.mjs` exercises the source in real Chromium
using an isolated offline fixture; `--release` checks the generated page.
Screenshots are saved in ignored `outputs/lineup-workflow/`. State tests cover
structural conflicts, draft privacy, malformed storage, and navigation limits.
Production source availability and private Scout authorization are distinct
from this deterministic UI test and must not be claimed from its fixture.
