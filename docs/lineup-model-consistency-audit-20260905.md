# Lineup Lab: shooting evidence and objective consistency

Local model: `historical-rates-v7-consistent-shooting-evidence`.
Prepared September 5, 2026. This is a code-and-test improvement pass, not a
deployment or a newly trained/validated basketball outcome model.

## Bottom line

The historical model now treats shooting frequency as uncertain evidence,
uses the same recommended scoring path for starting five and full rotation,
and closes several ways raw or mismatched statistics could regain influence.
The optimizer still maximizes the user's priorities subject to their rules.
It does not try to reproduce coaching rotations, protect famous players,
prescribe an 18–32 minute range, or impose a new candidate-rotation cap.

**Assessment: locally regression-tested; predictive claims need caveats.**
Tests demonstrate calculation and solver consistency, not that the new
objective predicts wins, shooting under a different role, or real player
impact more accurately. User preference weights are not learned basketball
exchange rates. No Scout package or production database was changed.

## Defects and improvements addressed

1. **Starting-five scoring bypassed evidence safeguards.** Recommended starting
   fives now use evidence-adjusted per-36 contributions like rotations. Each
   selected player has equal objective exposure; no minutes are assigned.
   Starting-five production rules still explicitly add recorded per-game
   profiles. They are not a forecast of one team box score. Explicit API
   `rotationOptions.scoringBasis: "perGame"` / `rateStability: "raw"` retains
   compatibility comparisons; missing league evidence remains a labelled raw
   fallback, not fabricated calibration.
2. **Equal per-36 attempt rates were treated as equally demonstrated volume.**
   Shooting frequency now has a separate count/exposure downside sensitivity.
   The accuracy estimate and attempt-frequency evidence are distinct inputs.
3. **eFG% lacked an opportunity-aware contribution.** The efficiency component
   now evaluates shooting surplus/deficit relative to the NBA eFG baseline at
   supported FGA volume, instead of awarding a full efficiency score to a tiny
   number of shots. No attempts means neutral efficiency utility, not evidence
   of finishing skill. This is an objective preference, not a possession model.
4. **A risk-setting edge case could arise when discounting volume.** A below-average
   shooter's penalty must not shrink merely because the user chooses more
   caution. Positive efficiency surplus uses supported volume; negative
   surplus retains observed volume. Utility is continuous at zero surplus,
   and increased risk cannot improve that shooter's utility.
5. **Spacing rewarded non-spacing traits.** The Spacing family previously
   assigned 60% to threes, 30% to eFG%, and 10% to OBPM. It now assigns 100% to
   the three-point component, which itself combines accuracy with frequency.
   Finishing and overall offensive impact remain in their other families.
   This removes an obvious duplicate reward, but does not make all remaining
   components statistically independent.
6. **The secondary role model could reintroduce raw outliers.** When called by
   the optimizer, it now reuses the exact same normalized metric contributions,
   including each metric's explicit raw fallback. Finishing no longer creates
   a floor-spacing signal. Missing usage is neutral, not a measured 20% rate.
7. **Role preferences added unwanted priorities.** Removed the automatic
   positive intercept for every role. A points-only objective cannot secretly
   reward defensive coverage via the role preference. Equal-role weighting
   remains only for a standalone descriptive call with no specified objective.
8. **Roster-only role bonuses did not account for assigned court time.**
   Rotation role coverage is now explanation-only. A roster member receiving
   zero minutes cannot earn an unoptimized coverage bonus. Starting-five
   complementarity remains optional because all selected players participate
   equally. Scout keeps its independently measured objective without a
   box-score role bonus. Joint court-time coverage optimization is still future
   work, not silently approximated by roster membership.
9. **Risk settings changed expected ability as well as caution in older seasons.**
   All three presets now share the same priors/posterior means. Reliable,
   Balanced, and Upside use downside multipliers 1, 0.5, and 0, respectively.
   Those are preferences, not calibrated coverage probabilities. Existing
   matching-season fitted prior values were not retuned on old test outcomes.
10. **Impact values could use the wrong exposure scope.** The core now selects
    all-team OBPM/DBPM together with matching all-team minutes, and accepts
    complete season impact even without a team coefficient. It cannot combine
    a positive team coefficient with a negative all-team coefficient's exposure.
11. **Shooting counts could be individually plausible but jointly impossible.**
    Added FGA/FGM/3PA/3PM cross-checks, including implied two-point makes and
    attempts. Invalid all-team evidence may fall back only to a valid matched
    team pair. Gaps are not filled with zeros or mixed denominators.
12. **Very large objective weights could overflow their sum.** Finite individual
    values whose combined total overflows now fail validation instead of
    producing a zero/invalid normalized objective. Tests also verify ordinary
    proportional rescaling does not change the selected group or its score.
13. **Explanations described the old model.** Starting-five contributions now
    carry the correct evidence/basis labels. Removed obsolete references to
    fixed percentage reserves, average-roster-minute decay, synthetic samples,
    and universally linear production constraints. Source comments explain the
    intended units, scope, limitations, and solver boundaries.

## How shooting volume is handled

The input grain is a player/season/phase metric with **matching** counts and
minutes. Prefer a complete imported all-team pair; otherwise use a complete
selected-team pair. An imported aggregate is not automatically proof of full
season coverage.

Let A be observed attempts, T their matching minutes, and z the downside
preference. The observed frequency is `36 * A / T`. The supported frequency is:

`36 / T * (2*A / (sqrt(4*A + z*z) + z))^2`.

For A = 0 the result is explicitly zero. This is the numerically stable form
of a lower Poisson score bound; it uses actual attempts, not attempts per game
multiplied by an invented number of games. The statistical method is described
in the [statsmodels count/exposure score-interval documentation](https://www.statsmodels.org/stable/generated/statsmodels.stats.rates.confint_poisson.html).
Basketball attempts need not follow a homogeneous Poisson process: these values
are downside sensitivities, not validated player confidence intervals.

At Balanced risk, each following hypothetical sample has an observed rate of
six attempts per 36, but receives different supported frequency:

- 1 attempt in 6 minutes: approximately **3.658**.
- 10 attempts in 60 minutes: approximately **5.123**.
- 360 attempts in 2,160 minutes: approximately **5.844**.

These are inputs to the volume credit, not predictions of next-game attempts.
The sample-adjusted shooting accuracy is calculated separately. Upside uses
the observed attempt frequency without a downside reserve. A high-frequency
reserve with substantial evidence can still outperform a low-frequency starter.

Three-point utility uses `adjustedAccuracy * V / (V + 2)` before normalization.
The two-attempt scale is a disclosed saturation convention, not measured gravity.

eFG utility uses `2 * (adjustedEFG - leagueEFG) * V`, then a smooth normalized
score centered on zero surplus. Negative surplus uses observed rather than
discounted V. Four surplus points per 36 is the score-scale convention, not a
learned exchange rate against rebounds or assists. The raw eFG% displayed on
player cards is unchanged. eFG still accounts for the additional value of
threes; see the [NBA's definition](https://www.nba.com/stats/help/glossary).

No role-dependent attempt-rate prior was fabricated. The observed rate remains
the expected-frequency estimate for now. Fitting a better expected-frequency
model, correlation between frequency and accuracy, overdispersion, and shot
difficulty remains important follow-up work.

## Verification and evidence

- Eight targeted regression cases failed against the pre-fix implementation
  before the fixes were applied; those cases now pass.
- **301 focused tests passed** in the final full run, including historical and Scout
  objective tests, season evidence, nonlinear production/turnover requirements,
  rotation scheduling, and existing workload benchmark checks.
- New tests distinguish tiny/established samples with equal frequency, preserve
  genuine high-frequency reserves, cover zero/missing/impossible observations,
  verify risk monotonicity, and prevent mixed-scope impact evidence.
- Exhaustive small starting-five oracles check points, threes, and eFG with the
  revised role contributions. Existing nonlinear minute-allocation oracles and
  contribution-reconciliation tests remain green.
- Real Chromium smoke checks passed on the generated page: desktop 1440×1000
  and mobile 390×844, locks, rule errors, restored drafts, a completed exact
  starting-five solve, rotation minute validation/cancellation, keyboard focus,
  history navigation, and reduced-motion behavior. This uses the offline course
  fixture; it is not a live API, auth, or production deployment test.
- Source syntax checks, the secret audit, and site-integrity checks passed
  (zero integrity issues). Generated revision `20260905i` matched all 27 builder
  files at the final build check. Other local tasks are editing shared page/product files, so
  generated parity must be rechecked immediately before any later deployment.

Reproduce model checks:

```powershell
node --test --test-reporter=spec prototypes/basketball-lineup-optimizer/tests/*.test.mjs scripts/tests/benchmark-lineup-workload.test.mjs scripts/tests/nba-season-evidence-reader.test.mjs scripts/tests/lineup-scout-preview.test.mjs
node scripts/build-lineup-lab-release.mjs --check
node scripts/lineup-workflow-smoke.mjs --release
```

Screenshots: `outputs/lineup-workflow/desktop-results.png` and
`outputs/lineup-workflow/mobile-rules.png`. The workflow and new product panels
were already being edited separately; this pass does not claim authorship of
their new design or feature work.

## Next improvements, in priority order

1. **Backtest a two-part shooting model on independently reconciled games.**
   Fit attempt intensity and conditional accuracy separately on early games;
   select parameters on tuning dates; evaluate once on untouched later dates.
   Compare raw, shrinkage-only, and uncertainty-aware versions. Include low-
   exposure players, established reserves, starters, and trades. Report error,
   calibration, source coverage, and whole-game bootstrap uncertainty. Do not
   use full-season aggregates as earlier-game features.
2. **Learn offensive responsibility and shot-context effects.** Minutes do not
   automatically change usage. Validate how requested shot share, assisted vs
   self-created attempts, and defensive contest change production/efficiency.
   Keep unknown context unknown. Per-possession exposure helps pace comparison
   only when the possession denominator is reliable and correctly scoped.
3. **Use offensive opportunities for turnover control.** Low turnovers per
   minute can reward players who rarely handle or finish possessions. Test a
   matched opportunity-based turnover model plus creation demands; do not use
   assists or minutes as an interchangeable denominator.
4. **Jointly optimize legal on-court units.** Couple unit minutes, possession
   responsibility, and genuine role availability. Enforce five distinct
   players per unit and reconcile all player minutes. Distinguish exact global
   optimization from scheduling heuristics or local exchange optima. This is
   required before restoring a rotation court-coverage bonus.
5. **Calibrate decision risk, not just mean rates.** Shot counts and basketball
   events are clustered by game/opponent/role. Test count overdispersion and
   joint shooting uncertainty. Separate posterior uncertainty from outcome
   variability and scenario uncertainty; do not label every reserve a 95% CI.
6. **Audit overlapping objectives and defense proxies.** Points, eFG, assists,
   OBPM, rebounds, and DBPM share information. Use component ablations and
   sensitivity sweeps before changing additional weights. Steals/blocks are
   not complete defense; use validated Scout offense/defense where available.
   Free-throw creation and shooting need their own matched evidence and model
   tests before introducing TS% or a replacement scoring component.
7. **Improve baseline and missing-data behavior.** A missing league baseline
   can still force a raw comparison. Expose exactly which requested metrics
   are adjusted, prior-only, or raw; validate complete league/season scope.
   Do not infer source completeness merely from a non-null season total.
8. **Measure decision sensitivity and practical equivalence.** Show when small
   changes in weights/risk change a roster or minutes, and when alternatives
   are effectively tied. A decimal solver score is not evidence of a precise
   real-world advantage. Preserve exact-search completeness disclosures.

The new three-season Scout coefficients were not rederived or promoted here.
Existing Scout contract tests passing does not certify a package still being
built elsewhere. No Git commit/push, cPanel upload, or Supabase write occurred
in this pass. A later deployment needs review of the current shared tree.
