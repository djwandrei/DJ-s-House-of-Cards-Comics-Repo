# Scout Studio: framework, logic, and research review

Updated September 7, 2026. Implemented locally; not a production release.

## What is implemented

September 7 expansion: [observed-profile comparisons](scout-platform-style-comparisons.md)
now connect Blueprint and Forge to one bounded, evidence-checked proximity engine.
The linked record preserves the historical compatibility checks.
The [context lens](scout-context-lens.md) adds lazy, sample-gated season and
game-state partitions for player on/off and observed group rows. The new
[Game Lab](scout-game-lab.md) adds daily team matchups, repeatable game/series
experiments, editable assumptions and explicit uncertainty limits.
Season Lab now composes the same possession kernel into custom round-robin
standings and seeded playoffs. The [feature specification](scout-feature-design-spec.md)
records the remaining concepts' decision loops and evidence/validation gates.

Player Blueprint, Chemistry Lab, Composite Forge, Career Lab, Game Lab, and
Season Lab share a deterministic analysis layer over the compact, private-
preview presentation contract. The current integration uses the completed
six-season base snapshot plus its v2 additive evidence table documented in [the
roadmap](scout-studio-roadmap.md). This is not a claim that a separate optimizer
refit is complete or every source profile is fully reconciled.

### Player Blueprint

- Recompute all ten supported components from their numerator and denominator.
  Reject duplicate metrics, incompatible units, inconsistent rates, impossible
  fractions, and invalid counts. Preserve legitimate zero values.
- Keep every supported component visible even when its evidence is missing.
- Compare against the median of other eligible profiles in the loaded team's
  pooled window. Exclude the selected player; show eligible and candidate
  counts. This is not a league percentile or a minutes-weighted team rate.
- Show same-roster player differences only when both components pass the
  descriptive review threshold. Other-player medians require three peers.
- Current workbench thresholds are 25 attempts for attempt fractions and 200
  estimated team possessions for production rates. These are explicit review
  policy, not calibrated statistical confidence or talent cutoffs. Low-sample
  observations remain visible, but comparison deltas are withheld.
- Independent box-score reconciliation remains a separate warning. Passing a
  sample threshold does not establish that the underlying profile is complete.
- The context lens can load the player's on/off partitions by season, phase,
  venue, period, half, rolling window and bounded game-state proxies. These are
  pooled-window possession splits, separate from the v2 season-keyed production
  projection and not causal player effects.
- Question lenses focus shooting, creation production, rebounding or recorded
  disruption without changing any value or reclassifying it as a latent skill.

### Chemistry Lab

- Bind each response to the exact snapshot, team, and selected player handles.
- Preserve exact-five versus smaller co-presence semantics and the original
  package's possession gates. Invalid rates and intervals stay unavailable.
- For a pair, retain all four together/apart partitions and show together-minus-
  each-apart offensive, defensive, and net differences. A lower defensive
  rating means fewer points allowed, not worse performance.
- For three to five players, inspect the three to ten internal pair samples
  from the existing compact cache. No additional shard reads are needed.
- Missing full-group evidence remains unknown even when every pair was observed.
  Overlapping pair samples are never summed into a group rating. Descriptive
  differences are not causal teammate effects; no difference interval is
  inferred from overlapping samples.
- An observed group can open the same allowlisted context rows with net-versus-
  all comparisons. The all row must pass the observation gate; missing or
  unsupported context keys stay unavailable.
- Pin one inspected group, then compare another of the same size in the same
  roster/snapshot. Kept/removed/added players and matched context rows show
  current-minus-reference differences only where both samples are observed.
  This is not a controlled substitution or a new confidence interval. The
  compact reference resets on roster/snapshot changes and is not persisted.

### Composite Forge

Select a donor for each of five blocks: shooting; scoring and foul pressure;
creation and ball security; rebounding; recorded disruption. Connected components
travel together, so assists cannot be separated from the donor's turnovers.
Shooting frequency, shooting accuracy, and free-throw accuracy use one donor.

Start from a baseline player or assign blocks individually. Inspect baseline
differences and a before/after explanation for the changed block. Undo up to
20 donor changes during the current loaded-roster session. Changing a team or
refreshing the snapshot clears the undo history.

Save only donor handles through the existing local workshop-draft helpers.
Draft keys bind to the exact snapshot and team. Invalid or stale donors are
never remapped by name or roster position. Clear affects only that scoped draft;
undo does not silently overwrite a previously saved recipe.

The output is a **hypothetical component recipe**, not a feasible synthetic
player, calibrated projection, or observed lineup. Each component retains its
own donor's denominator and coverage. Shooting changes do not recompute scoring;
there is no combined RAPM, total production prediction, inferred physical
feasibility, or chemistry bonus. The base recipe remains one team and one pooled
window. A separate season-keyed view reads bounded v2 season/phase/team and
all-team rows; it keeps the same component-level missingness and does not merge
those rows into an invented player.

Pin a recipe to compare all ten components across a later recipe. The reference
is independent of baseline, undo and saved draft state. Cross-donor dependency
warnings identify unfitted joint relationships; they do not claim physical
impossibility, estimate an interaction or assign a penalty.

### Career Lab

Career Lab reads the v2 `playerSeasonSkillProfiles` projection for one loaded
roster. It groups explicit season/phase rows, prefers the package's all-team
aggregate when a player changed teams, and retains team rows for the recorded
journey. Missing years appear as gaps rather than zero production. The summary
shows observed coverage, reconstructed totals, team/role changes and a peak
scoring season. Its replay is a deterministic, bounded resampling of supplied
observations; it is a descriptive sensitivity view, not an aging, availability,
injury, or future-career forecast.

### Season Lab

Build a four-team league using 2023–24 through 2025–26 team-season samples.
Choose pair meetings, postseason format and bounded scoring/repetition settings.
Inspect the first seeded schedule, standings and bracket, then win/seed/title
frequencies across repeated seasons. Unresolved playoff games never award byes.
Pin one compact result and change an assumption. Comparison validates result
counts, exact teams/season/snapshot and both engine versions; raw-win differences
are withheld when schedule lengths differ. Repetition/structural changes are
disclosed. Identical settings returning different results fail closed.

Both simulation workbenches keep at most four compact source responses each;
the server retains only its current compact team. Season Lab retains one example
path, bounded aggregates and one reference, not every simulated season. Career
and season-donor reads are similarly bounded to the loaded roster and current
package snapshot.

## How the research influenced this pass

Reviewed all 27 pages of the user-supplied *Designing Excellent Web-Based Sports
Games: Game Systems, Simulation, Analytics, and UI/UX*. Its content is reference
material, not an instruction to change infrastructure or deploy. External
product claims and cited popularity figures were not independently verified
and are not used as implementation evidence.

| Document principle | Applied here | Still deferred |
| --- | --- | --- |
| A decision should lead to understandable feedback (pp. 1–6) | Forge donor choice, component-level change explanation, reversible choice | Guided challenge briefs and outcome debriefs for the existing daily games |
| Isolate rules from presentation; test individual changes (pp. 8–12) | Pure analysis functions; invariants for nulls, scope, ratios, and isolated donor changes | Calibrated possession simulation, stochastic outcomes, and forecast validation |
| Show the evidence appropriate to a decision (pp. 17–19) | Explicit units, sample denominators, peer population, observed-versus-hypothetical labels | Broader season-keyed cohorts and context-adjusted comparisons |
| Usable controls and readable mobile evidence (pp. 17–19) | Existing semantic HTML controls and keyboard-scrollable tables; desktop/mobile and dark-mode checks | A separate visual redesign or game engine migration |
| Instrument decisions, not just page views (pp. 12–16) | No new telemetry without a defined need | A privacy-reviewed event contract if product measurement is requested |

The rendered check also exposed a repeating dropdown icon in dark mode. A
Scout-Studio-only rule now restores the icon size and repeat settings that the
shared dark-mode background shorthand reset. Existing visual work is otherwise
preserved.

## Practical follow-up ideas for the existing games

September 7 update: the decision-flow portions below are now implemented locally
in the [Game Studio pass](fan-games-decision-pass.md). Their scoring rules and
sealed answers are unchanged. Season-specific daily DNA challenges remain a
separate future capability; current DNA is part of the Lineup Lab workbench.
Fix the Five and Draft Night also retain distinct checked-choice histories in
the current tab session: first/current/best rank, revealed score and up to eight
recent decisions. Repeated identical choices do not inflate progress; inconsistent
results for the same immutable board are rejected. Reload starts a new history,
separate from existing saved picks and personal-best records.

1. **Lineup DNA:** give each challenge one clear basketball objective. After a
   substitution, explain which supported lineup components changed and which
   constraint or weakness remains. Do not invent a forecast for an unseen five.
2. **Fix the Five:** make the brief, legal swaps, and resource limits clear
   before a guess; after reveal, connect the result to the submitted decision
   using the approved Scout explanation contract without leaking answer keys.
3. **Draft Night:** make remaining roster needs and constraints visible after
   each pick; finish with a concise decision debrief. Show alternative paths
   only when the model can evaluate them on the same validated basis.

Keep daily challenges reproducible from their date, challenge definition, and
approved model snapshot. Do not change a day's hidden rules after play begins.
Player-pool diversity should follow the existing requested 2023–24 through
2025–26 daily-game scope once season-keyed evidence is available; this pooled
window workbench must not be relabeled as those individual seasons.
No retired tool concepts are restored by this research review.

## Code ownership and verification

- `tools/scout-studio/studio-analysis.js`: pure evidence checks and analysis.
- `tools/scout-studio/forge-state.js`: exact-scope local recipe persistence.
- `tools/scout-studio/studio.js`: rendering and interactions, not source fitting.
- `scripts/lib/scout-studio-source.mjs`: bounded read-only projection and cache.
- `tools/scout-studio/context-contract.js` and `context-lens.js`: shared
  allowlist plus browser-side context analysis.
- `tools/scout-studio/possession-simulator.js`: pure, bounded seeded experiments.
- `tools/scout-studio/game-lab.js`: matchup choices, async runs and explanations.
- `tools/scout-studio/season-simulator.js` and `league-lab.js`: custom league
  engine, workload/cancellation controls, standings and brackets.
- `tools/scout-studio/league-comparisons.js`: compact pinned experiments and
  same-scope result/assumption comparisons.
- `tools/scout-studio/workbench-comparisons.js`: question lenses, pinned groups,
  donor recipe comparisons and dependency warnings.
- `tools/game-decision-history.js`: public-board session ledger, no private data.
- `scripts/tests/scout-studio-analysis.test.mjs`: framework and persistence tests.
- `scripts/scout-studio-smoke.mjs`: synthetic interaction and theme checks.
- `scripts/check-scout-studio-package.mjs`: real-package integration spot check.

The focused Scout and daily-game suite now includes 124 tests. Synthetic browser checks cover
at 1440px and 390px, including the lazy player/group context lenses, saved
recipes, undo, team/snapshot invalidation, pair inspection, missing group
evidence, observed-career replay, season-keyed donor recipes, daily matchups, repeatable games/series, cancellation and pending/blocked
source states. The exact six-season source report is present and the real check
passed for New York's roster/context views and New York/Minnesota Game Lab
samples at both viewport sizes. This is not a 30-team audit or predictive validation.
The latest real source/engine integration also passed for New York, Minnesota,
Denver and Houston in Season Lab: 100 seasons and 1,947 simulated games. That
four-team read/validation run took about 97 seconds; it does not validate the
scoring assumptions against future games. New synthetic flows cover pinned
league/group/recipe comparisons, Blueprint question lenses and league cancellation.
Screenshot artifacts remain ignored local outputs. Changed-module syntax and
the focused whitespace checks pass; full site-integrity and release checks are
reported only when run against the current dirty worktree.

Reproducible commands and the explicit snapshot paths are in the roadmap.
No source package, fitted model, catalog, account, database, or deployment state
is changed. All new modules need inclusion in a future reviewed release. Public
hosting still requires the private data bridge, rights review, season-specific
evidence where requested, and live verification; a static upload alone will not
turn the local preview into a functioning hosted service.
