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
conservative per-minute bounds within each player's allowed minute range
(upper bounds for turnovers), including individual overrides. Zero minutes
contributes zero production; a fixed minute range evaluates only that workload.
They do not use optimistic observed-role rates. Constraint totals are explicitly marked as
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

- 182 prototype tests pass, including independent exhaustive roster AND integer
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

Release verification: implementation commit `db6c21f8` reached GitHub main;
all 20 cPanel files matched the local build byte-for-byte. The deployed browser
shows both model options and correct unsigned Scout guidance. No raw Scout
data or product records were uploaded. A subsequent regression also verifies
that unavailable historical priorities cannot veto complete primary Scout
evidence. The final response records the resulting follow-up commit/parity.
That follow-up uses Lineup-specific asset revision `20260905b` so a browser
cannot retain the earlier module graph under the same cache key.

## Next local upgrade: evidence and validation (20260905c)

This checkpoint is implementation and local verification, not a new cPanel or
Supabase release. The fitted runtime coefficients and primary Scout model are
unchanged. The exact solver still maximizes the chosen objective under user
requirements; there is no new preferred minute range or candidate-count cap.

### Runtime corrections

- The production envelope now uses each player's actual allowed integer-minute
  range, sharing the same bound resolver as the allocator. Scalar/Map defaults,
  individual aliases, fixed minutes, zero minutes, and invalid bounds are tested.
  A fixed 30-minute example with a 110-rebound floor now correctly passes; the
  old 1–48-minute envelope rejected it despite forbidding 48 minutes.
- Partial season records cannot pair full-season minutes or shooting attempts
  with a selected-team numerator. Evidence and rate must describe the same
  population for each metric. Complete matching evidence remains supported.
- Null, blank, and boolean impact fields no longer become measured zero BPM.
  Genuine numeric zero is still accepted.
- Diagnostics count matching season samples, approximate samples, and missing
  samples separately for each metric. Copy distinguishes fallback assumptions
  from observed exposure and statistical confidence intervals. The backtest
  game count comes from calibration metadata instead of hard-coded UI text.

### Offline benchmark improvements

Run the reviewed local benchmark without changing runtime defaults:

```powershell
node scripts/benchmark-lineup-workload.mjs --archive outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/data/2025 --out outputs/lineup-scout-upgrade/workload-validation-v2.json
```

`chronological-workload-v2` uses whole UTC days, explicit unique game/player
identities, strict future-only evaluation, and metric-specific paired counts
and denominators. It records exclusions instead of converting missing evidence
to zero. Free-throw attempts/makes are retained for future offensive-load
research; they do not activate a new usage coefficient.

The local run accepts 856 eligible regular-season games: 515 training, 168
tuning, and 173 test games (March 14–April 13, 2026 UTC). Five subgroup checks
use only training evidence: 5–19 versus 20+ valid metric appearances, and
observed MPG below 16, 16–below 28, or at least 28. These labels never constrain
the optimizer. The legacy expanded-role slice is explicitly outcome-conditioned.

Paired bootstrap resamples whole test games 1,000 times using a fixed seed.
It keeps teammates together and uses identical games/opportunity weights for
both models. The 95% intervals describe error improvement conditional on the
fitted parameters, not individual player/lineup forecast uncertainty. Games
are assumed independent; serial/team dependence and fitting uncertainty remain
unmodeled. Subgroup intervals are exploratory, without multiplicity correction.

| Metric | MSE improvement vs raw rates | 95% game-bootstrap interval |
| --- | ---: | ---: |
| Points | 2.22% | 1.39% to 3.08% |
| Assists | 2.11% | 1.08% to 3.20% |
| Rebounds | 0.24% | -0.57% to 1.03% |
| Steals | 3.50% | 1.93% to 5.17% |
| Blocks | 0.54% | -0.31% to 1.47% |
| Turnovers | 1.84% | 1.29% to 2.48% |
| eFG% | 0.86% | -0.28% to 2.00% |
| 3P% | 1.93% | 0.43% to 3.47% |

The rebounding workload correction's improvement over shrink-only is uncertain.
Other metrics select zero workload strength and equal shrink-only predictions.
This does **not** support adding a universal minute-expansion penalty. V1 and
V2 results are not directly comparable: split boundaries and shooting-metric
eligibility changed. The V1 runtime parameters remain untouched.

### Evidence gaps and the next implementation boundary

The archive audit found 18,550 active player appearances across these 856 games.
Team scoring and source minutes are checked, but independent official player
and team box-score totals were not retained by the archive normalizer. All-stat
reconciliation is therefore unavailable, not implicitly passed. The manifest
also contains 381 completed regular-tagged games excluded from publication;
their phase/quality exclusions need review before broadening inclusion. Archive
exposure is not a verified complete-season sample.

The prototype accepts all-team season evidence, but the shared browser catalog
currently has no `listNbaPlayerSeasonEvidence` reader. Thus this pass does **not**
claim real season exposure is active on the live page. Next, implement a reviewed
read-only bridge to the existing historical season aggregates and validate the
exact browser transformation. That shared integration is outside this
prototype-only change; no shared client or database definition was modified.

Before fitting responsibility-dependent production, preserve official box-score
totals in the private archive, reconcile all target metrics, and define
offensive opportunity separately from minutes. Actual future usage must not be
fed into a pregame predictor. Event-time lineups—not blindly possession-start
lineups—are needed when attributing opportunities during substitutions.

### Local verification

- 211 focused optimizer, private-bridge, and benchmark tests pass, including
  brute-force Scout objective comparisons and the new evidence/boundary cases.
- Site integrity reports zero issues; the 20-file generated release matches
  the prototype builder at independent Lineup revision `20260905c`.
- Rendered checks at 1280×900 and 390×844: no horizontal page overflow, no
  broken visible images, and no captured JavaScript errors. The updated
  Historical rotation completed a 715-candidate constrained search with 70
  feasible groups, 240 assigned minutes, and passing position/production rules.
- Private authenticated Scout was not re-exercised in this UI pass; focused
  authorization and pure Scout solver tests passed. No new live database query,
  database migration, cPanel upload, or Git push was performed by this task.

### Scoped file handoff

Source: `prototypes/basketball-lineup-optimizer/app.js` and `optimizer-core.js`.
Tests in that same prototype: `tests/scout-primary-benchmark.test.mjs` and
`tests/workload-evidence-boundaries.test.mjs`.

Offline tooling: `scripts/benchmark-lineup-workload.mjs`,
`scripts/lib/lineup-workload-validation.mjs`, and
`scripts/tests/benchmark-lineup-workload.test.mjs`.
Builder: `scripts/build-lineup-lab-release.mjs`. Documentation: this file.

Generated files changed by the reviewed build: `lineup-lab/app.js`,
`lineup-lab/index.html`, `lineup-lab/lineup-role-model.js`,
`lineup-lab/opponent-gameplan.js`, `lineup-lab/optimizer-core.js`,
`lineup-lab/optimizer-worker.js`, `lineup-lab/player-projection.js`,
`lineup-lab/projection-parameters.js`, and `lineup-lab/supabase-nba-data.js`.
Seven of those changes are cache-revision propagation only. No manifest was
changed, and `workload-calibration.js` remains identical to the prior release.
The unrelated concurrent `scripts/lib/nba-rapm.mjs` change is excluded from
this handoff; it was not edited or staged by this task.

## September 5 follow-up: release and read-only season integration

### Completed release

The user's GitHub `main` commit `8499f14cdfc1fa5f67cc7e3f51f3e0e55a57bf1a`
was verified remotely. The reviewed 20-file `20260905c` Lineup release was
uploaded to cPanel using the existing env-based FTPS workflow, with no deletes.
The post-upload audit found 20 identical files, zero missing/different files,
and zero unverified/error results. A production starting-five smoke search
checked all 1,287 groups, found 196 feasible groups, and showed no captured
JavaScript errors or broken visible images. No Git push was performed here.

### New local work, not part of that deployment

`listNbaPlayerSeasonEvidence` in the shared browser adapter now reads narrow
public count columns from the existing dedicated NBA project's RLS-protected
`nba_player_team_season_stats` table. It does not use the existing SUM view:
SQL SUM skips missing fields, which could pair partial counts with full minutes.
The client aggregation leaves a metric unavailable if any contributing team
row is missing it. Real zero remains zero; provider TOT/multi-team aggregate
rows are excluded to avoid double counting. Explicit phase/player scope,
duplicate detection, 50-ID batches, and exhaustive cursor pagination are tested.
These are transport batches, not a player or rotation-candidate cap.

No new Supabase storage, migration, grant, RLS policy, or data write was needed.
Public anonymous read access and the security-invoker view were checked live.
Private Scout/archive work remains separate. This bridge deliberately does not
invent full-season BPM, possessions, or source-completeness certification.

The prototype now distinguishes imported season evidence from selected-team
card stats, rejects malformed optional evidence without blocking a valid team
pool, and explains the available sample in each player's collapsed selection
details. Snapshot cache version v6 invalidates older pre-reader cached pools.
Generated Lineup files match the builder at local revision `20260905d`.

Verification: 227 focused tests pass, site integrity reports zero issues, the
secret audit passes, and generated parity passes. Browser checks confirm
season evidence for MIN 2026 regular (21/21), LAL 1980 regular (15/15), DET 2004
regular (17/17), and DET 2004 playoffs (12/12). A local nine-player MIN rotation
checked 220 groups, accepted 98, and assigned all 240 minutes. At 1280×900 and
390×844 there was no horizontal page overflow or broken visible image; no
JavaScript errors were captured. Ayo Dosunmu's 69-game/1,881-minute/two-team
sample and Kyle Anderson's 43-game/853-minute/three-team sample match a separate
database aggregation, while their cards retain Minnesota-only stats.

Source changes: `supabase-client.js`; prototype `app.js`, `index.html`, and
`supabase-nba-data.js`; prototype tests `supabase-nba-data.test.mjs` and
`header-and-benchmark-ui.test.mjs`; builder `scripts/build-lineup-lab-release.mjs`;
new shared-reader tests `scripts/tests/nba-season-evidence-reader.test.mjs`.
Generated changes: `lineup-lab/app.js`, `index.html`, `supabase-nba-data.js`, plus
revision propagation in `lineup-role-model.js`, `opponent-gameplan.js`,
`optimizer-core.js`, `optimizer-worker.js`, `player-projection.js`, and
`projection-parameters.js`. No release manifest was changed. Shared storefront
cache alignment/release review is still needed before publishing the new
shared adapter; this local revision has not been pushed or deployed.

The subsequent user-requested Gobert/Beringer diagnostic is documented in
`docs/lineup-gobert-beringer-diagnostic.md`, with a read-only reproduction at
`scripts/diagnose-lineup-center-case.mjs`. Its 56 controlled scenarios expose
remaining shooting-opportunity and role-extrapolation problems. Fix and
validate those before promoting the next model release; correct sample counts
alone do not establish a better player-quality or expanded-role forecast.
