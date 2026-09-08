# Scout games and tools: decision systems and acceptance contract

September 7, 2026. Local implementation and forward design, not a release claim.
This specifies all ten concepts in the user's newest attachment (items 3–12),
plus the existing daily games. It does not restore the six retired concepts.
The source text is product input, not authorization for infrastructure changes.

## Product rules shared by every experience

Each screen should answer one basketball question, expose the meaningful choices,
let the user inspect a consequence, and offer a reversible next experiment.
Depth comes from comparing defensible alternatives, not accumulating opaque scores.

- **Evidence type:** label observed evidence, descriptive comparison, hypothetical
  recipe, uncalibrated simulation and validated prediction separately. A package
  being ready does not turn an experiment into a validated predictor.
- **Scope:** bind every result to snapshot, model/rules version, team or cohort,
  true season grain, phase and selection. Changing any dependency invalidates
  the result and its comparison reference. Never match stale players by name.
- **Missing states:** distinguish loading, unavailable source, unsupported field,
  insufficient sample, unseen combination and failed reconciliation. A zero is
  a measured zero; unavailable is not a zero or a below-average player.
- **Comparison:** show what was held fixed and what changed. Deltas need compatible
  units, denominators, samples and scope. Overlapping samples do not justify an
  independent difference interval or a causal substitution claim.
- **Feedback:** show a short result first, then optional samples, alternatives,
  assumptions and provenance. No hidden bonus, unexplained grade or claim that a
  fixed-board rank explains a private model's reasoning.
- **Interaction:** keyboard controls, visible focus, cancel, explicit stale state,
  bounded work, responsive evidence tables and readable contrast in both themes.
- **Retention:** scoped recipe drafts remain local. Experiments, pinned evidence
  and decision histories are bounded session state, not a public leaderboard.
  Do not add database persistence or new analytics payloads implicitly.
- **Privacy:** browsers receive only approved presentation fields and opaque
  handles. No RAPM coefficients, private source identifiers or raw package routes.

## Current build map

| Experience | Implemented locally | Next evidence-dependent expansion |
| --- | --- | --- |
| Lineup Lab / DNA | Existing optimizer and DNA workbench; maintained in their existing lane | Approved current-model integration, then objective-driven daily DNA boards |
| Fix the Five | Sealed Scout boards, preview/confirm/reveal, swap exploration; new first/current/best checked-choice history | Approved explanations and validated team-season/mixed-pool board catalog |
| Draft Night | Fixed legal slots, undo, reveal, one-pick alternatives; new distinct-choice history | More pool structures and feasible needs/constraint feedback from the board contract |
| Player Blueprint | Ten observed components, zones/labels, peers, style proximity, contexts; new question lenses | Season-keyed production histories and exposure-qualified cross-team cohorts |
| Chemistry Lab | Observed 2–5-player groups, WOWY and context lenses; new pinned group comparison | Held-out, context-adjusted interactions, not a hand-tuned synergy grade |
| Composite Forge | Five coherent donor blocks, undo/scoped save, baseline/style comparisons; new pinned recipes and dependency warnings | Season-keyed donor catalog, then separately fitted joint-response models |
| Game Lab | Seeded games/series, daily matchup, editable pace/blend and distributions | Chronologically evaluated forecasting model with documented calibration |
| Season Lab | New four-team round-robin UI, standings, seeded playoffs, repeated seasons and controlled pinned comparisons | Full schedule/availability/rotation system after those inputs are versioned |
| Career, impact, learned archetypes, assignment matchups | Design contracts below; some observed building blocks exist | Required input grain, cohorts, approved private service and validation |

## 3. Optimal lineup construction and Lineup DNA

**Decision loop:** select the goal and legal pool → construct a feasible five →
inspect the binding constraints and supported contribution changes → exchange
one player while holding the rest fixed. Keep rotation allocation and staggering
in the existing Lineup Lab, rather than duplicate its solver in a new game.

**Daily DNA design:** versioned goal cards may ask for a two-way five, an
offense/defense tradeoff, or a production floor supported by source metrics.
The board must declare pool grain, objective, constraints, allowed alternatives
and reveal semantics before play. A hypothetical five must never masquerade as
an observed lineup. Exactly enumerated legal boards can show rank and regret;
solver-wide global-optimum claims require the optimizer's actual certificate.

**Acceptance:** a legal lineup exists; identical snapshot/rules/seed reproduce
the board; no duplicate real player across season variants; units and hard
constraints hold; unseen synergy stays absent; objective/constraint explanation
recomputes from the approved evaluation. Salaries, age, size and injury limits
wait for authoritative inputs. Do not modify the concurrent optimizer refit here.

## 4. Game, series and season simulation

**Implemented experiment:** Game Lab samples validated team-season possession
outcomes with an explicit, editable offense/defense blend. Season Lab composes
that same engine into balanced pair schedules, standings and seeded series.
The UI starts with four teams so first-read cost and bracket structure are clear.
It supports one, two or four meetings per pair; no postseason, a top-two final,
or top-four semifinals; and repeated seasons with a visible seed/model/snapshot.

**Rules:** custom standings use wins plus half-credit unresolved ties, then point
differential, then a disclosed seeded lottery. Home/away are neutral labels.
Playoff ties beyond the overtime cap leave the bracket unresolved; no automatic
bye or invented champion. Only the first season's full path is retained; other
draws accumulate bounded win, seed, qualification and title summaries.

Pin a result before changing the assumptions. The comparison retains one compact
reference and shows exact changed settings and outcome differences. Schedule
length changes suppress raw-win deltas; disabled playoffs are unavailable, not
zero; seed/repetition changes are disclosed. Team/season/snapshot changes clear
the reference, and inconsistent outcomes under identical settings are rejected.

**Next design:** separate an official schedule provider, availability timeline,
rotation policy and scoring kernel so none silently substitutes for another.
Calendar events must be versioned and auditable. A user may edit a scenario's
assumptions, but a historic replay cannot use later information. Rest, injuries,
travel and substitution policies need their own evidence before affecting scores.

**Acceptance:** score and W/L/T conservation, one appearance per team per round,
correct pair counts, balanced paired home/away cycles, deterministic replay,
valid bracket advancement, honest unresolved outcomes, cancellation, memory/work
caps and invariant totals. Forecast release additionally requires game-grouped
chronological holdouts, baseline comparison, Brier/log loss, reliability curves
and score/margin interval coverage. Freeze evaluation criteria before tuning;
do not choose a post-hoc success cutoff from the test results.

## 5. Composite Forge

**Decision loop:** choose a baseline → change one coherent donor block → inspect
the exact component change and retained denominators → pin a recipe → compare
the next recipe, undo or save. Shooting frequency and accuracy travel together;
assists cannot be detached from the donor's turnovers.

**Implemented depth:** pinned A/B comparison covers all ten components and five
blocks. Cross-donor dependency warnings explain why shooting, scoring, creation,
rebounding and disruption have not been jointly reconciled. These warnings are
not fitted incompatibility scores, physical impossibility detectors or penalties.

**Next design:** add a cross-team, season-keyed donor browser only after that
grain exists. A future joint-response model must condition on role/opportunity
and show distributions rather than add isolated best skills. Physical sliders
remain unavailable without measurements; no donor RAPM summation is permitted.

**Acceptance:** unchanged blocks are invariant, stale donors rejected, missing
values retained, only qualified deltas shown, reference and saved draft remain
independent, undo does not alter a saved recipe, and no aggregate talent claim.

## 6. Chemistry Lab

**Decision loop:** inspect a pair or 3–5-player group → examine shared-floor
sample and supporting pair/context evidence → pin that group → change one or
more members → compare kept/removed/added players and matched context cells.

**Implemented depth:** the reference binds to the same roster/snapshot and group
size. Both groups must be observed for rating deltas. Missing contexts remain
unknown on their respective side. A five-player row is not interchangeable
with a smaller group's co-presence row. Pair evidence cannot fill an unseen five.

**Next design:** compare learned interactions against an additive model on
held-out games and previously unseen groups; account for context and dependence.
Report exposure, shrinkage and uncertainty next to any approved interaction.
No Synergy Score until its estimand, calibration and interpretation are defined.

**Acceptance:** four WOWY partitions retained, context keys aligned, no summing
overlapping pair samples, no causal reading of group differences, no synthetic
difference interval and no unobserved-group rating.

## 7 and 10. Tendencies and skill decomposition / Player Blueprint

**Decision loop:** choose the basketball question (shooting, creation, rebounding,
recorded disruption or full profile) → inspect component/sample → compare an
eligible peer → inspect the applicable context → identify what remains unknown.
The new question lenses reduce the initial metric load without changing values
or quietly dropping unavailable evidence within the selected question.

**Next design:** distinguish shot selection from accuracy, recorded assists from
creation opportunities, steals/blocks from assignment defense, and exposure from
usage. Season views need season-keyed direct events; the current pooled profile
must not be relabeled by a context filter. True play types and decision-making
features require source qualifiers, not inference from a box score.

**Acceptance:** each component preserves value/null, units, numerator,
denominator, completeness and method; valid zero survives; comparisons use the
same grain; peer populations are disclosed. A sample gate is not proof of
coverage or calibrated certainty. Latent skill grades require a separate model.

## 8. Career arcs

**First useful release:** an observed, season-keyed role/production timeline with
gaps visible and changing team/role/completeness annotated. Users compare a
player to an explicitly selected age/role cohort, not a fabricated future curve.

**Predictive design:** trajectories should condition on known age, prior role,
opportunity and availability at the forecast date. Separate future playing
opportunity from performance conditional on playing. Define breakout/decline
events before fitting. Quantiles must remain ordered and include nonparticipation
where appropriate; a median-only line is insufficient.

**Data gates:** age-linked identity resolution, season-level profiles, longer
career cohorts, attrition/availability and team changes. Contract, salary, awards
and Hall-of-Fame outputs require separate targets and data, not proxy claims.
**Acceptance:** player-aware chronological splits, no future leakage, explicit
survivorship handling, naive age/role baselines and held-out interval/event
calibration. This forecasting model is not implemented yet.

## 9. Impact and value

**First useful release:** three separate explanations for observed production,
adjusted on-court impact and lineup fit. An approved private service can return
bounded presentation summaries while keeping coefficients private. A user can
ask why two evaluations differ and inspect the corresponding assumptions.

**Next design:** replacement level, wins added and monetary value need separate
reference populations and explicit conversions. Salary is not a basketball
skill. Playoff translation requires playoff validation; a regular-season effect
cannot simply receive a postseason multiplier.

**Acceptance:** exact model snapshot, component reconciliation, coverage and
uncertainty; changing a baseline explains the result change. No raw plus-minus
as causal impact, RAPM-to-wins shortcut, private coefficient exposure or fake
floor/ceiling designation. Model integration stays in its existing work lane.

## 11. Archetype detection

**First useful release:** current observed-component proximity with visible
components and qualified peers; explicitly not archetype membership probability.
**Next design:** an exposure-gated, season-keyed cohort and multi-label/mixture
model. Show membership uncertainty, nearest evidence-supported examples and
which features drive similarity. Low-information players may remain unassigned.

**Acceptance:** feature scaling learned on training data only, missingness not
treated as zero, no duplicate-player season leakage, stability across resamples
and held-out seasons, interpretable feature summaries. Human-readable names are
descriptions of learned clusters, not labels invented first then sold as a model.

## 12. Matchup analytics

**First useful release:** Game Lab's symmetric team-season experiment, with the
chosen pace/blend visible and one-assumption-at-a-time comparisons. Future
lineup-v-lineup views can reuse approved optimizer components at their true grain.

**Next design:** assignment-level advantages require player-v-defender, coverage,
tracking or qualified play-type observations. Distinguish descriptive historical
matchups from forecasts under a specified scheme; disclose sparsity and opponent
selection. Do not infer switches, doubles, contest distance or defensive roles
from height, steals or blocks.

**Acceptance:** forward/reverse matchup consistency, same-context comparisons,
out-of-time and unseen-matchup tests, additive baseline comparison, no invented
assignment, and a defined calibrated target before any advantage score.

## Daily replay and challenge variety

Fix the Five and Draft Night now keep a bounded session ledger of distinct
checked decisions. First checked means this tab session, not the player's first
ever attempt; rechecking the same selection does not inflate progress. First,
current and best reveal ranks remain tied to the immutable board. Reload clears
this history, while existing saved picks and personal records remain separate.

Planned daily pool families: one team/one season, one franchise across seasons,
and mixed-franchise/mixed-season pools. All use 2023–24 through 2025–26. Before
publishing a board, validate identity uniqueness, eligible player-season grain,
constraints, at least one feasible answer and meaningful alternatives. Keep a
stable day/snapshot/rules seed and pin answers before accepting attempts. A
data update must not alter a running day's scoring. If no valid board exists,
show unavailable; do not silently fall back to Timberwolves-only or old fixtures.

Challenge success should be measured separately as valid completion, willingness
to try an alternative, and comprehension of why a revealed result changed. A
numeric engagement target must be chosen from an actual baseline and testing
plan, not invented in advance. No new telemetry is added by this design document.

## Integration order while model work continues

1. Maintain the local tested decision loops and evidence boundaries above.
2. Consume a frozen, exact-scope completed package/model interface; do not read
   partial output as a ready release or mutate a package owned by another task.
3. Reconcile season-keyed profiles and cross-team identity before expanding
   donors, timelines, cohorts and daily pools.
4. Build model-specific evaluations and compare against explicit baselines.
5. Review rights, approved presentation fields, private service limits and
   production authentication. Deploy backend and static assets only with release
   authority, then verify live behavior and scope parity.

Current verification is local: 121 focused tests, synthetic desktop/mobile
interactions and a real four-team integration check. These do not establish
predictive validity, all-team completeness or a production release.
