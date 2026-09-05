# Lineup Lab: primary Scout model and workload validation

Implementation checkpoint: September 5, 2026 UTC. This document distinguishes
mathematical solver correctness from predictive evidence. Neither an exact
optimum nor an improved player-rate backtest proves that a hypothetical lineup
will outperform a real NBA rotation.

## 1. Private Scout connection

The browser requests bounded derived player evidence through the commerce
`lineup-scout-preview` Edge Function. Commerce Auth validates the user, and
`site_admins` is checked on every request. Only then does the function contact
the dedicated NBA analytics project, `fbbmuqbdpgsmvnezowwn`. No private Scout
tables, PBP rows, archives, Storage URLs, or service credentials are published
to cPanel. Browser responses are private/no-store and held in memory, not the
historical-data cache. Account changes clear Scout evidence and its results.

The new analytics migration is
`20260905013059_lineup_scout_preview.sql`. Its RPC is executable only by
`service_role`. Anonymous users and ordinary signed-in accounts cannot call it.
The commerce function is deployed to `gkqdymnmczabcggvigce`.

Eligibility requires matching season/team scope, validated archive/model
metadata, usable offense AND defense coefficients, and an unambiguous identity.
The existing tables do not provide a complete BRef–Sportradar ID crosswalk.
The bridge prefers an explicit external ID; otherwise it requires exact
normalized name plus same-season team, rejects collisions, and labels that
method `exact-name-team-season`. This fallback is not independent identity
verification. A MIN 2025–26 readback matched 20 players; 16 had usable impact
rows. Coverage is checked again against the actual eligible pool at solve time.
Missing players are named; the user must exclude them or choose Historical.

The current Scout package combines regular season, tournament, play-in and
playoff evidence. It is not a regular-season-only or playoff-only impact fit.
The interface states this even when Basketball Reference context uses one
specific phase. Shared URLs save the model/objective, never the private payload;
recipients must obtain their own authorized evidence.

## 2. What the two objectives mean

**Historical** preserves skill-priority optimization with Basketball Reference
stats. **Scout** makes validated advanced player O/D RAPM the primary objective:

- Offense maximizes offensive RAPM.
- Defense maximizes defensive RAPM; positive values mean points prevented.
- Balanced maximizes equal-weight offense plus defense.

For a rotation, additive impact is `sum(player impact × assigned minutes / 48)`.
For a five-player group it sums the five effects. These are additive player
estimates, not validated lineup net ratings, win probabilities, or matchup
forecasts. The current model does not estimate causal fatigue or new usage
responses for RAPM coefficients. Extreme minutes can therefore still be an
honest optimum under the chosen objective and hard bounds.

The solver rescales impact affinely into its bounded minute-score interface.
Because all successful rotations contain exactly 240 minutes, this preserves
effect gaps and the optimizing roster/minute plan. Percentile ranking would
erase those gaps. Already ridge-regularized estimates are not multiplied by a
reliability proxy again. Reliability remains an evidence qualifier/context.

Scout does not add hidden historical priority weights, OBPM/DBPM cross-checks,
heuristic role bonuses, or unvalidated five-player residuals. The old hybrid
mode remains available to older API experiments, not the public mode selector.
Basketball Reference still supplies positions, eligibility, hard production
requirements, and descriptive comparisons. The historical opponent assistant
is hidden in Scout because its weight changes would not alter a Scout objective.

The Simple Scout report leads with offense/defense/net player effects. The
100-based NBA comparison is separate historical context in Detailed view.
Historical fit of 105 means five index points above that reference—not a 5%
win improvement or five extra points per 100 possessions.

## 3. Workload and small-sample correction

`workload-model.js` isolates the conditional-rate calculation. A posterior mean
combines the observed rate with its baseline using `sample / (sample + prior)`.
Sample units are minutes for counting rates and attempts for shooting accuracy.
An optional fitted expansion response reduces only above-baseline advantages
beyond observed all-team MPG; it does not improve below-baseline players merely
because they are assigned a larger role. Turnovers use the opposite direction.

There is no new curve beginning at `240 / roster size`, no automatic 18–32 minute
target, and no selected-team games/minutes cap. Low-minute evidence affects
confidence in rates, not a player's right to receive user-permitted minutes.
The static sample projection is applied once at observed workload; assigned
minutes then enter the conditional response. This removes the previous double
role-expansion discount.

Calibration is restricted to 2025–26 regular-season context. Other seasons use
explicit legacy priors and sensitivity assumptions, not a claim of universal
validation. The historical adapter can fall back to a standardized per-appearance
sample when complete all-team season totals are unavailable. That fallback and
the transfer from provider-derived rates to BRef context were not independently
validated by this benchmark. The UI reports actual source coverage.

To preserve exact min-cost flow, cumulative utility must have nonincreasing
marginal minute values. The calibrated path uses a conservative concave minorant
where needed. Extreme extrapolations that would imply negative utility fall
back to the lowest nonnegative conditional rate across the interval. This is a
numerical/optimization approximation, not an empirically fitted fatigue law.
Descriptive production and the NBA-baseline display use conditional means,
not this utility approximation.

Hard production constraints currently need linear inequalities. They use
conservative per-minute bounds across 1–48 minutes (upper bounds for turnovers),
not optimistic observed-role rates. Constraint totals are explicitly marked as
bounds rather than forecasts. This is safe against a falsely passing production
floor, but can reject a plan that a future nonlinear constraint solver would
accept. The selected minute objective remains unchanged by adding a satisfied
production floor.

## 4. Predictive evidence and limitations

The reproducible local benchmark is `scripts/benchmark-lineup-workload.mjs`.
It uses 856 complete regular-season games: 513 for training, 171 for tuning,
and 172 held-out games from March 14 through April 13, 2026 UTC. Whole games
are split chronologically. Parameters are selected on tuning data, profiles
are refit on train+tuning, and test outcomes are not used to select parameters.
Altering test outcomes is regression-tested not to change selected parameters.
Player histories aggregate across trades. Incomplete scoring ground truth is
rejected. Minutes are observed exposure inputs—not a coaching-minute target.

The following are relative reductions in exposure-weighted **rate MSE** versus
raw historical rates. They are not lineup accuracy percentages or confidence
intervals.

| Rate | Prior exposure | Expansion strength | Held-out MSE reduction |
| --- | ---: | ---: | ---: |
| Points | 100 minutes | 0 | 2.25% |
| Assists | 100 minutes | 0 | 2.12% |
| Rebounds | 0 minutes | 0.25 | 0.21% |
| Steals | 250 minutes | 0 | 3.50% |
| Blocks | 100 minutes | 0 | 0.61% |
| Turnovers | 100 minutes | 0 | 1.86% |
| Effective FG% | 180 attempts | 0 | 1.41% |
| Three-point % | 350 attempts | 0 | 2.86% |

All eight improved MSE in this one test window, including the expanded-role
subgroup, but block MAE worsened. Improvements are small and not accompanied
by game-cluster bootstrap intervals. Most metrics selected zero additional
minute-expansion decline: this sample did not justify a blanket penalty.
That does not establish that workload or usage has no causal effect.

Only scalar parameters, aggregate metrics and source-ID hashes are exported to
`workload-calibration.js`. Private observations remain under ignored `outputs/`.
The full local report is `outputs/lineup-scout-upgrade/workload-benchmark.json`.

Separately, the private v10 O/D package passed its existing five-fold held-out
component checks on 916 eligible games / 183,083 exact possessions. Full-model
MSE was 0.377958 versus venue-only 0.380824 (about 0.75% lower); offense and defense
ablation checks also passed. That gate validates a modest conditional predictive
signal, not additive lineup forecasts, causal player effects, or unseen chemistry.

## Verification checkpoint

- 181 prototype tests pass, including independent exhaustive roster AND integer
  minute enumeration for Scout offense, defense and balanced objectives.
- Six backend/benchmark tests pass: authorization ordering, no-store responses,
  target isolation, malformed/oversized request rejection, split leakage, trade
  aggregation and incomplete-ground-truth rejection.
- New tests cover negative-utility prevention, missing/invalid Scout metadata,
  locks/exclusions, flex positions, impossible minute bounds, conservative
  production floors and private-free shared URLs.
- New live Edge endpoint rejects unauthenticated requests with HTTP 401.
  RPC permission readback: anon false, authenticated false, service_role true.
- Security advisor returned six existing warnings on three older historical
  public RPCs, none on the new private bridge. They were not modified here.
- Secret audit and site integrity pass. Source/generated parity is checked by
  `node scripts/build-lineup-lab-release.mjs --check` over 20 files.
- Desktop 1280×900 and mobile 390×844 rendered checks: no horizontal overflow;
  historical five-player and nine-player solves succeed, headshots load, no
  browser error logs. The 9-player test checked 5,005 groups and found 1,344
  feasible groups. Local unsigned Scout gives explicit sign-in guidance.
- Successful authorized browser-to-live-Edge-to-Scout solving has not yet been
  manually exercised in this checkpoint. Server authorization is behavior-tested,
  and the live private RPC was queried separately; these are not the same test.

## Best next model upgrades

1. Complete a reviewed BRef/provider ID crosswalk and expose per-team usable
   Scout coverage before a visitor starts the search.
2. Add rolling-season validation with game-cluster uncertainty intervals and
   low-sample, traded-player, postseason and workload-expansion slices.
3. Validate additional Scout information incrementally against O/D RAPM before
   adding interactions: lineup residuals, role complementarities and opponents.
4. Fit usage/shot-difficulty/defensive-role response jointly with workload. Do not
   invent a fatigue curve merely to spread minutes more attractively.
5. Replace conservative linear production bounds with an exact nonlinear
   frontier over workload-dependent production, keeping honest optimality proofs.
6. Independently validate the historical adapter's fallback evidence and the
   additive lineup forecast before describing either as prediction-grade.

## Release boundary

The migration and private Edge Function have been applied/deployed. Public
assets are generated from the prototype; release manifest:
`scripts/cpanel-lineup-lab-20260905a-release.txt`. It contains only 20 Lineup Lab
files and performs no deletes. A local build alone is not cPanel or Git parity;
final release results must be verified separately after upload/push.
