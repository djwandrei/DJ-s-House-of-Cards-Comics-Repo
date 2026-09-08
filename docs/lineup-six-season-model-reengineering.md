# Lineup Lab: six-season model reengineering and acceptance plan

Status: implementation started alongside the restarted Summary download.
The user clarified that the working input is the NEW, interrupted package,
not the older completed 2022-26 release. Use verified available fields from
that interrupted build now; do not wait for the entire package to complete.
New fitted parameters still require independently reconciled evidence and
holdout validation. This document distinguishes requirements from results.

## User requirements

- Reengineer both the Simple and Advanced optimizer models around the new
  Scout data, preserving useful existing analytics and the exact constraint
  selection layer.
- Rework objective functions, examine parameters, and improve projection and
  allocation logic. Accuracy means useful estimates for the user's scenario;
  reproducing a coach's historical rotation is not the target.
- Let users change priorities **within offense and within defense in both
  models**, as well as the overall offense/defense balance.
- Test many cases. Gobert/Beringer is one motivating diagnostic, not a
  hard-coded ordering or the definition of a successful model.
- Correct uncertainty and extrapolation from limited opportunity. Historical
  team games must not silently determine a player's proposed minutes. Playing
  more minutes and taking more offensive responsibility are different inputs.
- Keep the interface understandable, show what changed a result, preserve
  assumptions in shared scenarios, and leave explanatory comments in source.
- After implementation and verification, push the reviewed changes to GitHub
  and deploy the matching public Lineup Lab release to cPanel using the
  existing credential-loading deployment workflow. The user has authorized
  this release; another general deployment confirmation is not needed.

## Acquisition, parallel model work, and promotion gates

The full required-Summary pass was restarted on September 7 using
`scripts/refresh-scout-model-summaries.mjs --source-only true`. It verifies all
source game hashes, keeps valid existing observations, re-fetches incomplete
Summaries, and writes a new overlay revision without changing PBP inputs.
Resume checks and post-download checks use the same field-completeness
contract. A downloaded partial response is retained, not marked complete.
Provider authentication/quota failures stop the job without key switching.

Current private working paths (relative to the repository):

- Source: `outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/data-2020-2025-trial-composed-20260906-v1-six-season/`
- Base build target: `outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/scout-analytics/2020-26-final-20260907-v1-six-season/`
- New overlays/progress: `outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/summary-overlays/2020-2025-20260907-v4-required-fields/`

Before the restart, the six-season audit checked 8,202 archived games and
found 1,312 in-scope games with missing official Summary fields (1 in 2020,
640 in 2024, 671 in 2025). Ten games had box-score discrepancies; no file
errors were reported. These are a dated audit, not live remaining counts.
Completeness and reconciliation remain distinct gates.

Model implementation and fixture tests may proceed immediately using the
interrupted package's schema and verified source observations. Its partial
outputs are not a production-ready package, and missing fields cannot be
substituted with zeros, inferred Summary counts, or an older release.

The active derivation creates the base six-season analytics package. It does
not itself attach the additive `modelEvidence` player-game tables. Completion
of the base process therefore is not completion of every modeling dependency.

1. Validate the finished base manifest, every team shard, exact six-season
   source binding, reconstruction coverage, and O/D calibration. Staging files
   and a passing unit-test suite are not a passing derived-package report.
2. Check independent Summary coverage, field discrepancies, and minute
   reconciliation. Attach the additive evidence with
   `scripts/rebuild-scout-model-evidence.mjs` only when its data-first gate
   passes. Preserve partial and invalid fields as such. Do not remove the gate
   to get a completed-looking package.
3. Validate the additive package and its preserved base shards. Verify
   `playerGames`, `playerSeasons`, `gameContext`,
   `assistedBasketConnections`, and their source/hash/coverage descriptors.
4. Freeze the exact input revision and current model as comparison baselines.
   Report usable training coverage by season, phase, player opportunity, and
   field. Package validity does not make every appearance training-eligible.
5. Retire superseded generated packages only after the replacement passes and
   dependent consumers have been checked. Keep raw archives, validation
   evidence, and reconstruction inputs needed to reproduce the replacement.

The current baseline code includes one-season workload calibration and many
solver regression tests. Reuse correct behavior and tests; do not label a
one-season fit as six-season validation. The existing Gobert/Beringer package
benchmark uses real coefficients in a synthetic center-allocation problem.
It proves objective plumbing/exactness for that problem, not predictive accuracy.

## Architecture and objectives

Both models should share one versioned evidence adapter, projection contract,
constraint representation, scenario serializer, and explanation contract.
Separate data estimation from user preferences and from exact search.

| Layer | Responsibility |
| --- | --- |
| Evidence | Player/team/season/phase identity, paired counts and exposure, field-level reconciliation, provenance, availability. |
| Estimation | Shooting frequency and success, production, O/D contribution, conditional workload response, uncertainty. Fit from training data only. |
| Scenario | Requested minutes, offensive responsibility, pace/opponent assumptions, permitted positions, user priorities, risk preferences. |
| Objective | Convert supported projections and preferences into a documented utility, with a separate expected-value and uncertainty breakdown. |
| Search | Optimize the declared utility subject to hard requirements; disclose proof status, bounds, or an unfinished search. |
| Explanation | Reconcile reported contributions to the actual objective and compare feasible alternatives using the same assumptions. |

### Simple model

Use a transparent set of supported basketball components with stable units or
a fixed, source-scoped reference scale. Defaults should be tested, not selected
to make famous players win. Avoid candidate-pool ranks that change player value
when an irrelevant player is added or filtered out.

Treat a custom weighted skill score as preference utility unless calibration
supports a stronger interpretation. Do not label arbitrary slider weights as
predicted wins, points, or win probability. A simple display should still use
the shared sample, opportunity, missingness, and workload safeguards.

### Advanced model

Start from the validated offense/defense impact baseline, then compare
incremental models for responsibility, opponent context, and shared-court
effects. Keep effects in compatible units and validate their incremental value.
RAPM, on/off, box-score impact, and lineup residuals can overlap; adding them
as independent bonuses is not an acceptable default.

Optimize shared-court decisions when they enter the objective. A schedule
generated after individual-minute optimization does not establish that the
combined lineup-interaction problem was solved optimally. Any new coupled
decision variables require independent exact-oracle tests and valid search
bounds, including cases where a linear relaxation has an integer gap.

### Workload and responsibility

- Estimate attempt frequency separately from shooting accuracy. Per-36 is a
  reporting unit, not additional evidence or an observed high-volume role.
- Fit supported conditional changes in production and efficiency when
  responsibility changes. Distinguish observational relationships from causal
  forecasts; widen or disclose uncertainty outside the training support.
- Use shared-court possession accounting to avoid assigning more than a team's
  supported offensive opportunity. A possession-ending involvement proxy is
  not measured touches, gravity, or every offensive action.
- Use the same conditional production function in scoring, production floors,
  turnover ceilings, results, and replacement explanations.
- Do not impose an 18-32 minute target, historical-team-share cap, or artificial
  smoothness just to make a rotation look familiar. Boundary allocations can
  be mathematically correct; test whether the marginal values are justified.

## User-adjustable offense and defense controls

The model selection and interface detail level are separate concepts. Both
Simple and Advanced must expose offense and defense priorities. A compact view
can collapse controls, but it must not silently disable them.

| Control family | Intended behavior |
| --- | --- |
| Overall balance | Adjust offense versus defense, including offense-only and defense-only objectives. |
| Offensive priorities | Adjust supported scoring, shooting efficiency, three-point contribution, creation, offensive rebounding, and turnover-control components. Explain measured inputs and avoid counting the same scoring event twice without a stated utility reason. |
| Defensive priorities | Adjust supported overall defensive contribution, defensive rebounding, rim-related evidence, and disruption measures. Blocks/steals alone are not complete rim/perimeter defense or tracking coverage. |
| Scenario assumptions | Adjust allowed minutes, supported offensive responsibility, pace, opponent context, and positional constraints. Mark user-supplied assumptions separately from measured data. |
| Advanced sensitivity | Expose interpretable uncertainty and interaction-trust assumptions, and selected projection sensitivities where evidence supports them. Keep fitted defaults and user overrides separately versioned. |

Requirements for every visible control:

1. Give its unit, direction, practical meaning, default, and supported range.
   Clearly separate preference weights, scenario assumptions, and fitted
   statistical parameters. Editing an assumption does not retrain the model.
2. Normalize proportional weights automatically; users need not make them add
   to 100. Reject an entirely empty objective with an actionable message.
   Zero offense/defense must really remove that side's utility contribution;
   explicitly requested hard constraints still apply.
3. Preserve unrounded weights in the model contract so small inputs are not
   silently erased. Rounding is for presentation. Changes to shared-link
   formats must be versioned and preserve supported legacy scenarios.
4. Show effective weights when inputs lack coverage. Never silently replace
   Advanced with Simple or give a missing value a measured-zero interpretation.
5. Provide defaults/reset, a changed-assumptions summary, and a score breakdown
   that reconciles to the optimizer. Save both offensive and defensive
   settings, risk, model version, and scenario assumptions in shared URLs.
6. Explain why the selected players fit these settings and what a feasible
   replacement changes. Do not promise that every slider movement changes the
   winner; discrete optima can remain stable across a range of weights.

## Broad test matrix

Run applicable cases for both models, starting-five and rotation modes, and
offense/defense/balanced/custom priorities. Tests must assert basketball or
mathematical contracts, not copy the implementation's formulas as their oracle.

| ID | Case family | Required evidence or behavior |
| --- | --- | --- |
| E01 | Empty, malformed, stale, or changed package | Explicit unavailability or validation failure; no old-package substitution. |
| E02 | Missing versus zero | Unknown counts, percentages, impact, minutes, or usage stay distinct from real zero values. |
| E03 | Trades and all-team aggregation | No duplicate player-games; changing team-stint length alone cannot change the projection or minute limits; one team's missing field stays missing in a complete season total. |
| E04 | Season/phase separation | A pooled multiseason coefficient does not become a current-season per-game stat; postseason and regular-season evidence remain identified. |
| E05 | Independent reconciliation | Missing or contradictory official fields and minute mismatches cannot become workload-training ground truth. |
| P01 | Gobert/Beringer | Exercise full team context, isolated center minutes, and different offensive/defensive priorities. Diagnose evidence, extrapolation, and marginal values; never force a winner by name. |
| P02 | Tiny-sample outlier and genuine breakout | Test noisy reserve efficiency as well as sustained improvement. Sample correction must not become a blanket rookie/bench penalty. |
| P03 | Shooting frequency and accuracy | Cover non-shooters, 1-for-1 three-point samples, high-volume moderate accuracy, low-volume high accuracy, and equal percentages with different attempts. Keep rate denominators and confidence consistent. |
| P04 | Finishing versus spacing | Efficient interior finishers should not acquire unsupported three-point spacing; high-volume shooting value should not be erased by an unrelated eFG metric. |
| P05 | Minutes versus responsibility | Increase each independently, then jointly; test fixed low-responsibility roles at high minutes, expanded creation, and extrapolation beyond observed support. |
| P06 | Offensive and defensive specialists | Test creators with defensive weaknesses, low-usage defenders, turnover-prone scorers, rebounders, and two-way players under each priority. Check defensive sign conventions. |
| P07 | Sparse and unseen players | New identities, returning low-sample players, incomplete seasons, and unsupported roles yield honest uncertainty/availability behavior. |
| O01 | Weight scaling and rounding | Multiplying all weights by a positive constant preserves ranking; small positive priorities survive serialization; negative/nonfinite inputs fail explicitly. |
| O02 | Within-side controls | Change each offensive and defensive parameter in both models. Use constructed competing alternatives to prove the intended component responds; zeroed components contribute zero. |
| O03 | Dominance and sensitivity | With identical constraints/interactions, worsening a candidate in every valued component cannot improve its utility. Sweep weights and projection parameters, including endpoints and ties. |
| O04 | Stable reference and identity | Permuting input rows or adding an excluded/dominated player does not change existing player estimates or spuriously rescale the objective. |
| O05 | Risk decomposition | Changing pure risk preference leaves estimated means unchanged; downside treatment reconciles separately. Test correlated shared exposure and incomplete uncertainty evidence. |
| C01 | Roster requirements | Exact size, locks, exclusions, conflicting requests, duplicate IDs, too few eligible players, and feasible alternatives. |
| C02 | Position flexibility | F/C and G/F flexibility, scarce centers, small-ball and oversized requests, and competing slot assignments. One player cannot occupy two simultaneous places. |
| C03 | Minute bounds | Zero, fixed, asymmetric, minimum, maximum, impossible total capacity, and tight 240-minute allocations. No hidden historical-minute ceiling or target range. |
| C04 | Production constraints | All enabled floors/ceilings use the same conditional model as the objective, including exact-boundary, multi-constraint, and otherwise-attractive infeasible solutions. |
| C05 | Exact optimization | Independently enumerate small roster/minute/usage/unit fixtures. Compare feasibility and best objective; include relaxation gaps, nonlinear marginals, negative values, and tied optima. |
| C06 | Search size and interruption | Exercise pools beyond the old rotation candidate cap, pruning, cancellation, and limits. An incomplete incumbent is never called a proved optimum. |
| I01 | Shared-court feasibility | Exactly five distinct players on court, correct player-minute totals, compatible positions, and no simultaneous double assignments. |
| I02 | Interaction evidence | Familiar units, unseen units, correlated teammates, role overlap, and complementary specialists. Unsupported chemistry cannot become a confident bonus. |
| I03 | Opponent context | Different opponent strengths, pooled versus matching-season evidence, neutral context, absent context, and stale context. No unobserved defender assignments. |
| V01 | Broad real-data evaluation | All six source seasons where supported; every supported phase; training-defined sample/usage/shooting/impact groups; whole-roster and within-team comparisons. |
| V02 | Temporal leakage | Game/day-separated train/tune/test blocks; future targets, future teammates, and full-package fits must not leak into earlier prediction tests. |
| V03 | Ablations and baselines | Compare each new component with the frozen current model and simple opportunity-adjusted baselines on identical held-out rows. |
| V04 | Parameter robustness | Training/tuning sensitivity, regularization/recency, prior strength, risk, usage response, and interaction weight sweeps; record unstable rankings and subgroup regressions. |
| U01 | Score and explanations | Component arithmetic reconciles; labels distinguish preference utility from predictive points; replacement comparisons use the same evidence and constraints. |
| U02 | Controls and saved scenarios | Both sides' controls in both models, keyboard access, reset/defaults, legacy links, round trips, missing evidence notices, and mobile layout. |
| U03 | Runtime behavior | Worker responsiveness/cancellation, useful progress, deterministic results, memory, load failures, and generated-release parity. |

## Evaluation and promotion rules

- Freeze scenario definitions and the evaluation design before observing final
  test performance. Define subgroups from information available at prediction
  time, not a held-out game's realized performance or minutes.
- Use chronological development folds and retain an untouched final test
  block. Do not reuse the existing six-season pooled RAPM coefficients as
  supposedly out-of-sample inputs to earlier games. Refit within each fold or
  explicitly limit that analysis to retrospective scenario checks.
- Predict observed production conditional on known evaluation exposure when
  assessing rate models, and label that task accurately. Separate it from
  forecasting unknown future minutes and from unobserved counterfactual lineups.
- Report eligible counts, exclusions, weighted and player/group-level errors,
  interval coverage where available, and error changes against identical
  baseline populations. Do not let a large high-minute group hide a severe
  failure among low-opportunity players.
- Use paired game-level uncertainty for model comparisons, and examine
  date/team dependence before stronger inference. Intervals for benchmark
  improvement are not individual-player prediction intervals.
- Require all hard invariants and oracle cases to pass. For exact numeric
  comparisons, preregister absolute/relative tolerances appropriate to the
  objective scale; do not loosen them after seeing a failure.
- Select statistical settings on development/tuning data. Record meaningful
  improvement and subgroup non-regression criteria before opening the final
  test results. Retain the simpler validated component when additional
  complexity has no supported gain; label inconclusive outcomes honestly.
- Record model version, package hash, feature definitions, folds, parameters,
  seeds, objective units, prediction limitations, and benchmark results with
  each candidate release. Comments should explain evidence assumptions,
  normalization, units, extrapolation, missingness, and proof boundaries.

## Delivery order

1. Restart complete-source acquisition with required Summary-field guards.
2. Audit available evidence from the interrupted package and begin shared
   projection/objective implementation while acquisition continues.
3. Finish and validate the base and additive package without silently filling
   gaps. Only fit new response coefficients on reconciled evidence.
4. Finish both models' adjustable controls; compare Simple candidates, then
   Advanced O/D and interaction candidates using the declared holdouts.
5. Run the broad test matrix and review objective/constraint explanations.
6. Synchronize generated Lineup Lab files, verify desktop/mobile flows, and
   release only reviewed code/public assets. Keep private Scout records out of
   public Git/static/cPanel outputs; preserve unrelated concurrent edits.

This plan supplements `docs/scout-additive-model-evidence-rebuild.md` and the
existing readiness/benchmark tooling. It does not establish that the rebuild,
model changes, full evaluation, or deployment has already completed.

## September 7 implementation checkpoint

Completed locally in this first modeling pass:

- Removed whole-number rounding from skill-family weights; small priorities
  retain their influence, and rescaling priorities preserves their proportions.
- Added scenario URL v2 for fractional/combined weights. Legacy v1 links remain
  readable with their original contract. Invalid weights cannot silently
  disappear while generating a new link.
- Added `compileScoutPlayerGameEvidence` and a solver input path for compact
  `analytics.scoutPlayerGameEvidence`. Each component sums only jointly verified
  official/PBP observations and the matching independent game minutes.
- A missing field at one team stays a gap; another team's minutes cannot
  inflate the sample. Missing Scout fields do not borrow older displayed rates.
  Shooting accuracy, attempt frequency, and uncertainty use actual attempts.
- Lineup bounds, production constraints, and reported totals use the same new
  evidence. Fixed 240-minute rotation tests check floors and turnover ceilings
  against the same rates. Missing required production fails explicitly.
- No-data posterior calculations now return the stated prior without `0*NaN`
  contamination or substituting a legacy raw rate.

Real interrupted-checkpoint audit (not a predictive accuracy result):

- 4,773 game checkpoints and 101,948 player-game rows were inspected.
- 67,360 shooting player-games passed the paired-component checks.
- These frozen interrupted additive checkpoints cover 2022-23 onward, but do
  not yet contain the 2020-21/2021-22 additions. Their 2025-26 shooting Summary
  columns were still unavailable. The newer repaired overlays are separate;
  they will be incorporated through the controlled additive rebuild.
- Report: `outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/validation/six-season-data-first-20260906/interrupted-model-component-audit-20260907.json`.

Verification: the full Lineup unit suite returned 299 passes out of 300. The
single failure is the existing header test expecting the former `lab-header`
markup; both that test and the header HTML were unchanged by this model pass.
The ingestion/source suite passed 41 tests. Generated Lineup parity passed.
Site integrity reported zero issues. Re-run after further edits.

The six-season base derivation completed with 30 team shards on September 7;
full package validation is a separate ongoing step. The base manifest is
`scout-analytics/2020-26-final-20260907-v1-six-season/nba-scout-analytics-2020-26.json`
under the private working prefix above. The Summary pass resumed with the
user-confirmed additional authorized allowance after an earlier HTTP 429.

Not completed: replacement of the Advanced impact coefficients, new fitted
usage-response parameters, fine-grained offense/defense controls in both
models, full six-season predictive validation, live data-adapter rollout,
GitHub/cPanel deployment, or retirement of older generated packages. The new
reader is implemented/tested but is not a claim that production already
receives these new player-game inputs. Keep those gates explicit.

## Later September 7 source review and acquisition update

The newer review is recorded in [lineup-model-review-2026-09-07.md](lineup-model-review-2026-09-07.md).
Its local fixes and skipped-test status supersede the earlier verification
paragraph for the current working files. The older test counts above describe
that earlier checkpoint only.

The base package's saved validation has now passed. The required-Summary sweep
also finished checking all 8,202 archives after the authorized-key restart, but
one official 2020-21 Sabonis record supplied -1 steals. That invalid source
value was rejected and retained as an explicit gap. The additive rebuild has
not restarted or been promoted, and the reserve key was not consumed.
