# Lineup Lab: evidence-aware workload upgrade

Local checkpoint: September 5, 2026. Generated Lab revision: `20260905g`.
This checkpoint is not a GitHub push, cPanel deployment, or Supabase write.
Some underlying paired-evidence model changes were already present in the
shared checkout; this pass completed regression coverage, solver corrections,
responsibility controls, and truthful explanations around them.

## What the optimizer is trying to do

Find the highest-scoring feasible group under the user's objective and rules.
It is not trained to copy a coach's rotation or force everybody into an 18–32
minute range. Minutes, offensive responsibility, statistical confidence, and
player quality are different concepts. More court time does not automatically
mean more possessions used while on court.

Historical mode is a skill-priority model. Scout mode remains a separate,
authorized, validated offense/defense impact model. Basketball Reference
context and production requirements must not silently become a second Scout
impact score. Neither mode is a validated game prediction.

## Completed behavior and why it matters

### Paired counts, not guessed sample sizes

For each metric, the reader/adapter retains a numerator and denominator from
the same scope. All-team season counts are preferred when available. When a
season metric is incomplete, a complete selected-team pair may still be used,
explicitly labelled as team evidence. Missing counts never borrow the larger
all-team denominator. The old MPG-times-an-assumed-number-of-games fallback
is gone.

The all-team reader preserves a null for a metric if any imported real-team row
is missing it. Provider aggregate rows are not added on top of team rows. This
protects against partial season sums being described as complete evidence.
It does not prove that every source game or team row was imported: independent
source completeness remains a separate validation requirement.

With a usable league reference but no matching sample, the metric uses a
baseline-only prior. Without the required baseline, legacy raw behavior remains
explicit. A measured zero is not missing evidence. Zero three-point attempts
earn no demonstrated spacing credit, even if a shooting-accuracy prior exists.

### Uncertainty is explicit, and is not a fitted fatigue curve

The working posterior mean blends the observed rate with its league prior:

`mean = baseline + sample / (sample + prior) * (observed - baseline)`.

Counting-stat uncertainty uses a Gamma/Poisson working model; eFG uncertainty
uses the second moment of effective makes (0, 1, or 1.5), not an invalid
ordinary binomial variance. These are sensitivity scales, not calibrated
prediction intervals. Games are dependent and context varies.

The decision reserve expands with unsupported minutes and, for offensive
metrics only, an independently requested increase in usage:

`reserve = risk * standardError * max(1, plannedMPG / observedMPG)
           * max(1, requestedUsage / observedUsage)`.

The usage multiplier is omitted where measured usage is absent and is not
applied to rebounds, steals, blocks, or defensive impact. Higher-is-better
rates subtract the reserve; turnovers add it. Rates stay nonnegative, while
signed impact remains signed. Missing impact uncertainty is not invented.

Reliable, Balanced, and Upside use reserve multipliers 1, 0.5, and 0. In the
existing calibrated 2025–26 regular-season scope, the fitted mean settings are
shared. Other scopes retain disclosed prior-strength differences. The older
chronological workload benchmark does not validate this new reserve, new
usage effects, lineup forecasts, or the browser's league baseline.

Only previously supported conditional minute-response coefficients can adjust
the mean. There is no newly claimed causal usage-efficiency relationship.
Learning that relationship is pending independently reconciled box scores.

### Preserve meaningful differences instead of inflating rank gaps

Evidence-adjusted rotation scoring uses bounded, league-anchored differences.
An unrelated candidate entering the pool cannot turn a tiny supported rate gap
into a large rank advantage. Raw mode and descriptive comparison charts still
use percentiles; they are labelled separately.

The three-point component also weights demonstrated attempt volume smoothly.
The two-attempts-per-36 scale is a disclosed normalization convention, not a
learned measure of spacing or defensive gravity. BPM keeps negative values.

### Solve and audit the same production curve

Projected production is tabulated at every integer assignment from 0 to 48
minutes. Hard production requirements and reported totals evaluate those same
assigned-minute curves. They no longer evaluate a static worst-allowed-minute
rate while the score uses another workload.

Tests compare the nonlinear constrained solver with exhaustive small-case
oracles, including flex roles, fixed roles, production floors, and turnover
ceilings. Linear-only feasibility certificates are not applied to nonlinear
curves. Raw plans retain their fast linear checks. The existing concavity guard
keeps the utility representation compatible with exact minute optimization;
it is a conservative modeling restriction, not a biological claim.

Exactness refers to the implemented objective, integer-minute resolution,
constraint set, and completed search—not proof of real-world basketball
optimality. No new candidate-rotation cap is introduced. A player can still
legitimately reach the user's minimum or maximum.

### Improve who shares the court without changing the solved minutes

After the exact minute/position allocation, the planner builds 48 legal
five-player frames. It then exchanges same-role players between frames to
reduce uneven offensive responsibility. Every exchange preserves all player
minutes, role minutes, and five distinct players on court.

This is a secondary scheduling preference, not jointly fitted chemistry.
The report distinguishes a pair-exchange local optimum from an attained
relaxed lower bound. Missing usage is not filled automatically. Tests verify
determinism, preserved minutes/roles, no remaining improving exchange, and
honest handling of incomplete evidence.

## New controls and explanation fixes

- Detailed rotation player rows have an optional **Usage scenario (%)** input.
  Blank uses observed usage; 30 means 30% of on-court possessions finished by
  a shot, free-throw trip, or turnover. It is not minutes or assists.
- The exact input survives edit → solve → copy link → reload. Invalid values
  invalidate the old result instead of silently reusing it. Shared links reject
  malformed, duplicate, unrepresentable, or oversized usage settings.
- Usage fields are hidden and disabled in Simple and starting-five modes, so
  an invisible scenario cannot affect those runs or block form validation.
- The responsibility audit reports unassigned responsibility or overlapping
  roles. It no longer automatically expands individual usage to fill a gap or
  invents a group penalty. It distinguishes explicit scenarios from observations.
- Model contributions are no longer described as percentiles when they are
  normalized, league-anchored scores. Raw displayed stats remain labelled raw.
- Removed outdated copy about synthetic per-appearance samples and claims that
  evidence could never affect assigned minutes. Evidence affects confidence;
  team history does not prescribe a minute target or cap.

## Gobert/Beringer check against current imported records

Reproduction command:

```powershell
node scripts/diagnose-lineup-center-case.mjs --live --centers-only
```

This read-only diagnostic fixes a nine-player roster, explicitly includes both
centers despite the default MPG filter, uses 8–40 minute limits, and gives both
C-only eligibility to isolate rate valuation from Beringer's F/C flexibility.
All cases total 240 minutes. It is not a reconstruction of the user's unknown
original settings, and it does not load private Scout coefficients.

| Objective | Raw Gobert / Beringer | Paired-evidence Gobert / Beringer |
| --- | --- | --- |
| Balanced | 40 / 8 | 40 / 8 |
| Offense | 8 / 40 | 40 / 8 |
| Defense | 40 / 8 | 40 / 8 |
| Rebounding | 40 / 8 | 40 / 8 |
| Blocks only | 8 / 40 | 33 / 15 |

Current imported exposure was 2,380 minutes for Gobert and 314 for Beringer.
That difference supports different confidence, not a predetermined depth chart.
A narrow blocks objective is still allowed to value Beringer's observed skill.
The result is not an assertion that Gobert must win every possible objective.

## Three-season Scout package: not yet connected

The inspected task, **Sports Analytics Work — Primary**, is building the
2023–24 through 2025–26 package. Its earlier source checkpoint reported 4,194
replayed records without errors, but that is not a completed package-validation
pass. A later provenance gate found 16 records declaring production access in
an enclosing trial manifest. The latest completed update was checking for a
clean local source copy; the task was still active at the final status read.

The previously inspected sample archives did not contain retained official
per-player box-score fields. The new code distinguishes PBP-derived counts
available now from official Summary counts after archive refresh. A PBP total
matching another total derived from the same PBP is not independent box-score
reconciliation. No new Scout payload was promoted by this task.

Next acceptance gates before a usage-dependent model can consume the package:

1. Complete a source-attested build with consistent per-game provenance and
   hash binding. Preserve the previous validated package until the replacement
   passes its full validator.
2. Export explicit per-player official counts, measured opportunities, phase,
   player/team/season identifiers, and metric-level reconciliation/completeness.
   Keep source totals distinct from PBP-derived totals and preserve null gaps.
3. Reject partial numerators, mismatched denominators, cross-phase aggregation,
   duplicate team totals, or unreconciled games from usage-response fitting.
4. Fit on earlier games/seasons and test on untouched later games, with
   low-usage reserves, established starters, trades, tiny samples, and zero
   attempts assessed separately. Compare against simple unadjusted and
   shrinkage-only baselines before adding variables.
5. Calibrate uncertainty/coverage as well as mean error. A better Gobert case
   alone is not evidence of out-of-sample accuracy.
6. Verify the new combined-season Scout identity and coefficient scale in the
   private adapter. Do not combine independently centered season models as
   though their offsets were directly comparable.
7. Only then consider joint unit selection plus usage-dependent production.
   Current unit staggering does not jointly optimize minutes and chemistry.

## Verification and release boundary

Completed locally:

- 237 focused tests passed: the prototype suite, season-evidence reader tests,
  and private Scout-preview access-boundary tests.
- Live read-only center regression: 28 controlled cases; all three reviewed
  public NBA SELECT requests returned HTTP 200.
- Browser: 1280×900 desktop and 390×844 mobile; exact rotation result, usage
  input, link persistence/restoration, invalid values, hidden-control behavior,
  and no document overflow at either width. No JavaScript errors were captured.
- Existing Supabase SDK emitted a multiple-client warning during reloads; this
  pass did not change the shared authentication module.
- Site integrity: zero issues. Generated parity: all 21 files match the builder.
- `git diff --check` passed.
- Secret audit passed with no blocked credential patterns.

Reproducible checks:

```powershell
node --test prototypes/basketball-lineup-optimizer/tests/*.test.mjs scripts/tests/nba-season-evidence-reader.test.mjs scripts/tests/lineup-scout-preview.test.mjs
node scripts/build-lineup-lab-release.mjs --check
node scripts/site-integrity-check.mjs
git diff --check
```

`scripts/cpanel-lineup-lab-20260905g-release.txt` lists the 21 generated files,
including the new `projection-evidence.js` module. It places assets before HTML
and contains no private package, database migration, commerce files, or deletes.
Do not deploy using the older 20-file manifest: it omits the new dependency.

Source scope is the prototype and its tests, the Lineup builder, the focused
center diagnostic, this note, and the new Lineup-only release manifest.
Generated scope is `lineup-lab/`. Other tasks' Scout pipeline, daily games,
Supabase configuration/migrations/functions, and commerce changes were not
edited, staged, committed, uploaded, or reverted by this pass.
