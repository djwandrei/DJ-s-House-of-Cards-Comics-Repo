# Lineup Lab: implementation review, September 7, 2026

## Verdict

The recent work contains useful improvements, but it does **not yet satisfy the
full model re-engineering request**. This pass reviewed and repaired source;
it did not run model tests, browser tests, accuracy backtests, or a deployment.
Earlier test reports are historical and do not validate the current edits.

The exact solver still optimizes the configured mathematical objective, not
the real-world quality of a lineup. A proof of optimality cannot establish that
the statistical coefficients, uncertainty assumptions, or workload model are
accurate. Keep those two validation questions separate.

## Findings repaired locally

1. **Replacement comparisons changed their own reference pool.** A private
   selection-only exclusion now removes the outgoing player from the choices
   while retaining the original normalization, metric availability, role
   reference, and Scout scaling. Normal user exclusions still define a new
   scenario. No lock or rule is silently relaxed.
2. **The replacement explanation omitted the optimized tradeoff.** It now
   compares whole, unrounded objective values under matching scoring references,
   shows Scout offense/defense/net/weighted changes and all minute changes, and
   includes steals and blocks in the production comparison. A positive feasible
   objective improvement is a consistency warning, not a harmless swap. A tie
   does not acquire an unrequested box-score tie-breaker.
3. **Scout selection explanations cited historical box-score strengths.**
   Primary Scout cards now explain the actual O/D coefficients, chosen weights,
   and assigned-minute contributions. The result headline highlights the user's
   weighted objective; raw net impact remains distinct descriptive context.
4. **Incomplete evidence could borrow another player's baseline.** Prior-only
   records now use their own season reference and contain no copied sample
   moments or invented workload. Mixed-source metrics without sufficient
   matching baselines are disabled rather than restoring noisy raw-rate credit.
   Wholly legacy/raw sources retain their explicitly labelled compatibility path.
5. **Prior-only estimates could look like observed NBA-average performance.**
   Such rows no longer supply a measured Fit-vs.-NBA-baseline index.
6. **Risk preferences changed an uncalibrated expected workload response.**
   A common disclosed workload prior is now shared across risk preferences;
   decision uncertainty stays separate. A missing fitted value cannot be
   coerced from null to a supposedly validated zero response.
7. **Missing production could become a zero-valued curve.** Unsupported curves
   are omitted; matching count/exposure evidence is preferred for linear
   fallback. Requested production constraints explicitly reject nonfinite
   totals instead of letting JavaScript NaN comparisons pass.
8. **Compact Scout rates were accepted without full arithmetic checks.** The
   reader now checks revision binding, count/denominator units, verified-game
   counts, shooting bounds, per-36 arithmetic, and attempt-frequency arithmetic.
   This supplements, not replaces, independent source reconciliation.

These repairs are intentionally player-neutral. No Nance/Portis, Gobert/Beringer,
team-name, star-status, or historical-depth-chart exception was added. The
supplied screenshot does not contain enough original settings/source revision
to prove that its original Nance selection was mathematically wrong. It does
demonstrate that the former replacement explanation was inadequate.

## Requirements: what remains

| Request | Current implementation assessment |
| --- | --- |
| Correct small-sample shooting inflation | Paired makes/attempts/minutes, posterior shrinkage, supported frequency, and separate sampling reserves are implemented. No new predictive-accuracy claim has been established. |
| Avoid star-like extrapolation of small roles | Historical rotation curves use matched exposure and a fitted-or-disclosed-prior response. The unfitted prior is a sensitivity assumption, not a learned causal production decline. |
| Separate offensive responsibility from minutes | Separate scenario inputs exist; minutes do not manufacture usage. Complete on-court possession exposure and a validated usage-response fit are still required. |
| User-adjustable offense and defense | Primary Scout has continuous O/D weights in its solver API. The page still exposes preset priorities, not the complete custom-control experience. Fine-grained validated within-side model controls remain unfinished. |
| Automatically handle unavailable advanced players | Optional unsupported candidates are excluded for the current run with an explanation. Explicit locks and package-level evidence failures are not silently bypassed. |
| Use the same production model for hard rules | Shared rate/quantity paths and nonfinite guards have been strengthened. Exhaustive constraint/oracle regression cases have not been rerun. |
| Account for uncertainty | Game-cluster variation can supplement the event/prior reserve. These are working sensitivity scales, not calibrated individual-player prediction intervals. Primary RAPM uncertainty still needs validated treatment. |
| Optimize who shares the court | A rotation-unit planner exists, but the primary Scout objective is still additive player impact. A jointly optimized, independently validated five-player interaction model is not complete. |
| Preserve all-team stat gaps | Metric-specific reconciled subsets preserve missing components and their matching exposure. Subset completeness is not whole-season certification. |
| Completely re-engineer both models around the newest package | Not complete. The compact evidence reader is local; the unfinished additive package and production adapter are not promoted. |
| Broad tests and real-case validation | Still required before release. No tests were run in this pass, per the user's earlier instruction. |

## Package status observed in this pass

Private prefix:
`outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/`.

- The six-season base manifest is
  `scout-analytics/2020-26-final-20260907-v1-six-season/nba-scout-analytics-2020-26.json`.
  Its saved package-validation report passed with 30 teams, 1,083 O/D RAPM
  players and 897,735 eligible exact-lineup possessions. This is the base
  package, not the unfinished additive player-game evidence package.
- The required-Summary refresh resumed with a separately authorized allowance.
  At 2026-09-07 13:21:31 UTC it finished the six-season sweep: 8,202 archives
  checked, 426 outside scope, 170 summaries downloaded in this restart, 3,793
  overlays reused, and 3,813 complete original records retained.
- One 2020-21 game remains incomplete: the official response reported **-1
  steals for Domantas Sabonis**. The normalizer correctly rejected the negative
  count and retained the other fields. It must not be relabelled zero or replaced
  with PBP-derived steals while claiming independent reconciliation.
- Progress is `blocked_incomplete_summaries`, not quota-exhausted. The reserve
  key was not used. No downloader or reserve supervisor remained active after
  this completed sweep. Downloaded artifacts remain checkpointed.
- No additive rebuild, package promotion, Supabase update, old-package deletion,
  Git push, or cPanel deployment occurred in this pass. The provider defect
  requires a documented resolution or explicit partial-coverage policy before
  claiming complete evidence. Additional keys alone cannot correct that record.

## Verification and release boundary

Syntax checks passed for the ten affected model/interface modules and the
Lineup-specific builder. Scoped generated parity passed for those ten modules.
Whitespace/diff checks passed for the reviewed paths. No model behavior,
rendered interface, predictive accuracy, or live-state success is implied.

An unrelated task has generated-only telemetry and accessibility edits in
`lineup-lab/index.html` and a new telemetry module. These were preserved. The
builder's new explicit `--only` allowlisted subset option synchronizes owned
model files without overwriting those edits. Default full-release behavior is
unchanged; subset parity is **not full-page release parity**.

Next acceptance work should cover fixed-reference replacement invariance,
small-sample versus established-player cases, risk-mean invariance, traded-player
partial metrics, tampered compact evidence, zero-attempt shooting, missing-data
locks, offense/defense endpoint weights, feasible integer-minute production
constraints, and exhaustive small-pool oracle comparisons. Only afterward should
new predictive parameters be compared on untouched chronological holdouts.

## Follow-up: optimizer work while the comprehensive package builds

This is a later September 7 checkpoint, superseding the earlier statements
that Scout custom controls were API-only and the additive build had not started.
These changes are local; no commit, push, cPanel release, or Supabase write was
performed by this task. Public files are frozen after this atomic edit/parity
check while the separate release audit is in progress.

### Objective controls and explanations

- Scout now exposes Balanced, Offense only, Defense only, and Custom. Custom
  accepts two nonnegative, finite weights through 10,000. At least one must be
  positive. The shared resolver normalizes their proportions without rounding:
  3/1 and 0.3/0.1 describe the same 75% offense / 25% defense preference.
- Both Simple and Detailed expose these controls. They change the preference
  applied to the current O/D coefficients, not the coefficients, predicted shot
  mix, or hard minute limits. There is no new player-name exception or hidden
  historical-minutes target. An entirely zero Historical objective no longer
  blocks a valid Scout request through its hidden Historical controls.
- Historical skill controls are now available in an optional collapsed panel
  in Simple too. Changing detail level no longer maps a custom or specialized
  priority to Balanced/Offense or restores an obsolete custom mix over edits
  made in Simple. A selected specialized preset remains visible.
- Local drafts retain the new numeric fields. Scenario URL v3 preserves exact
  custom O/D inputs; v1/v2 remain readable under their existing contracts.
  Invalid custom O/D links are not restored as a default-balanced scenario.
- Result explanations and copied summaries use the result's saved weights,
  not newer form edits. They show the O/D objective formula; equally weighted
  net impact is still separate context. The spacing description now matches
  its supported three-point accuracy/frequency calculation.

### Production logic and missingness

- Removed the browser's raw per-game production rejection. The solver already
  uses its evidence-aware starting-five bounds; the UI's team-only displayed
  numbers were not valid bounds on reconciled all-team component subsets.
- Allocation feasibility, final candidate acceptance, and the result audit
  now share `projectedConstraintStatus`, including finite-value checks and the
  existing 1e-9 numerical tolerance. Missing turnovers cannot pass a ceiling
  through JavaScript's `null <= limit` coercion.
- Production totals and starting-five preflight bounds keep calculation
  precision. Six-decimal display rounding no longer creates or erases a tight
  hard-rule violation. UI formatting is separate from constraint arithmetic.
- Unknown production remains unavailable in cards, copied reports, and
  alternative comparisons. Missing values no longer become apparent zeros or
  imply that two alternatives have equal production.

### Verification boundary

Syntax checks passed for the five touched model/interface modules and four
regression files. Regression cases were added for O/D endpoint/custom-weight
oracle comparisons, proportion scaling, fixed-reference replacements, invalid
links, draft preservation, tight fractional production rules, and missing
turnovers. **Optimizer tests and browser tests were not executed**, following
the earlier user instruction. New cases are authored, not passing results.

The ten-model-file generated subset and `index.html` each passed builder
`--check` at revision `20260907c`. The page's telemetry/accessibility work from
the other task was preserved; no full release or production-parity claim is
made. A release must validate the complete dependency graph and reviewed cache
revision, not merely reuse these local syntax/subset checks.

### Still unfinished

The primary Scout objective is still additive O/D impact. This pass does not
complete fine-grained within-offense/within-defense learned controls, a
source-bound six-season usage-response refit, calibrated impact uncertainty,
or jointly optimized five-player interactions. Those need the validated
additive package and the held-out acceptance plan before changing estimates.
Historical's existing family controls are not a substitute for that work.

### Atomic optimizer edit paths for release review

This pass's optimizer/interface edits (each file may also contain preserved
earlier changes; do not stage the entire shared tree):

- Source under `prototypes/basketball-lineup-optimizer/`: `app.js`, `index.html`,
  `optimizer-core.js`, `scenario-url.js`, `workflow-state.js`.
- Matching generated files under `lineup-lab/`: the same five paths. The
  broader ten-file parity check also covered earlier model changes, but this
  is not authorization to publish any unrelated working-tree edits.
- Tests under the prototype's `tests/`: `scenario-url.test.mjs`,
  `workflow-state.test.mjs`, `scout-primary-benchmark.test.mjs`,
  `scout-player-game-evidence.test.mjs`.
- Documentation: this review and `docs/scout-additive-model-evidence-rebuild.md`.

The independent package-build work also owns changes to
`scripts/rebuild-scout-model-evidence.mjs`, `scripts/start-scout-model-rebuild.ps1`,
`scripts/lib/nba-scout-model-evidence.mjs`, new
`scripts/lib/nba-scout-source-corrections.mjs`, new
`scripts/lib/nba-scout-application-evidence.mjs`, and new
`scripts/tests/nba-scout-application-evidence.test.mjs`. These are private
pipeline tooling, not cPanel assets. The ignored correction ledger and generated
package remain under `outputs/`; never include their data in a public release.
