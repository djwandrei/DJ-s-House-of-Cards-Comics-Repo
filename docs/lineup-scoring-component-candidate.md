# Scoring-component model: private candidate, not the live optimizer

Updated September 7, 2026.

Implementation: `scripts/lib/lineup-scoring-components.mjs`.
Regression specifications: `scripts/tests/lineup-scoring-components.test.mjs`.

This is a new estimation layer, separate from exact roster/minute selection.
It does not change the deployed page, RAPM, offense/defense objective weights,
player eligibility, or the allowed number of candidate rotations. It is not a
completed replacement for either public optimizer. No new behavior tests or
held-out fits were run while the user's optimizer-testing pause remains active.

## The problem this addresses

A reserve's impressive shooting percentage and per-36 production may reflect
very few shots or minutes. Assigning that player 36 minutes must not turn those
few observations into a large, reliable sample. Conversely, playing for two
teams must not impose an artificial minutes restriction.

The candidate separates three quantities:

- **Shot frequency:** how many attempts were recorded per minute of exposure.
- **Conversion skill:** made shots divided by actual attempts, with uncertainty.
- **Scenario exposure:** minutes and optional shot rates supplied by the caller.

Changing the third quantity never changes the first two quantities' samples.
It also does not establish how efficiency would respond to a harder offensive
role. That response is still an unfitted, separate modeling task.

## 1. Accept evidence as a consistent scoring family

Each accepted player-game requires independently matching official and
play-by-play counts for points, FGA/FGM, 2PA/2PM, 3PA/3PM, and FTA/FTM. The
scoring identities must hold, minutes must reconcile, and numerator counts must
share the same full-game exposure. Partial-lineup possessions cannot stand in
for whole-game possessions to calculate usage or per-100 rates.

A user-corrected scoring count is not independent evidence. An unrelated
steals correction does not invalidate otherwise verified shooting. Original
fields, reconciliation statuses, and correction provenance remain untouched.

Training is scoped to an explicitly named season, phase, and UTC-date cutoff.
All teams for a player in that scope are combined. Duplicate player-games,
conflicting game timestamps, and invalid dates are rejected. Training and
evaluation cannot share a game or straddle the same training-cutoff date.

Rejected appearances remain visible in per-player and per-team coverage,
including reasons and missing fields. Accepted totals are explicitly a subset
when a team has a gap. Even accepting every supplied row does not certify that
the caller supplied the complete schedule or a validated package.

## 2. Estimate accuracy using attempts, not assigned minutes

For each shot type, let A be observed attempts and S be observed makes. Let p
be the accuracy of OTHER players in the same season/phase before the cutoff.
The candidate Beta posterior is:

    alpha = S + 0.5 + K * p
    beta  = A - S + 0.5 + K * (1 - p)
    estimated accuracy = alpha / (alpha + beta)

K is bounded by the actual comparison-pool attempts. Its configured maximum
defaults to 200 attempts for twos, 180 for threes, and 100 for free throws.
These are starting candidates, not parameters learned from the new package.
The player's own attempts are excluded from the comparison pool so they do
not count twice. The half-success/half-failure weak prior prevents one perfect
shot from implying certainty, even without a comparison pool.

With no player attempts, a comparison prior can describe a hypothetical shot
type but is labeled **prior-only**, not proven player skill. With neither
attempts nor a usable prior, accuracy is unavailable, not zero.

The working uncertainty measure retains the larger of posterior standard
deviation and game-cluster variation. It does not establish calibrated future
intervals and does not fully model uncertainty in the empirical baseline.

## 3. Temper tiny-exposure frequency spikes without choosing minutes

Without an explicit shot-rate scenario, the starting candidate uses:

    raw attempts per 36       = 36 * A / M
    estimated attempts per 36 = 36 * A / (M + k)

M is actual accepted exposure, and k defaults to 60 minutes. This is disclosed
zero-centered regularization, not extra observed minutes, an NBA rule, or a
validated stabilization threshold. Setting k to zero provides a raw-rate
ablation. The fitted output exposes both rates, actual M, and the regularizer.
Zero observed threes stay zero volume: the model does not invent league-average
three-point attempts for a non-shooting center.

This candidate must be compared with other strengths on held-out games before
promotion. In particular, zero-centered shrinkage can underpredict genuine
high-frequency players with little evidence; it is not automatically correct
merely because it reduces an extreme per-36 value.

Explicit shot rates bypass frequency regularization because they are user
conditions, not new evidence. Above-observed demand is flagged as extrapolation.
There is no hidden target of 18-32 minutes, team-membership minutes cap, or
promise that a player's efficiency stays constant under a larger role.

## 4. Derive production from the same components

For each shot type:

    expected attempts = supplied minutes / 36 * scenario attempt rate
    expected makes    = expected attempts * estimated accuracy
    expected points   = 2 * expected 2PM + 3 * expected 3PM + expected FTM

FGA, FGM, FG%, and eFG% are derived from those same twos and threes. Values stay
unrounded until display. Zero attempts imply zero expected makes, not a known
zero shooting percentage. Nonzero attempts with unknown accuracy remain missing.

An optional risk weight produces a separate conservative sensitivity scenario;
it does not rewrite the mean forecast or change its evidence sample. Reducing
both frequency and accuracy is a stress scenario, not a jointly calibrated
confidence bound. Correlations and unseen-lineup interactions are not fitted.

## 5. Evaluation and promotion work still required

The authored evaluator distinguishes production conditional on realized minutes
from conversion conditional on realized attempts. Neither evaluates a forecast
of minutes, and the latter cannot validate shot-volume prediction. Overtime and
very short appearances retain actual exposure. Missing player/shot-type
predictions are reported; they do not become zeros or disappear from accuracy
coverage. Known shot types remain evaluable even when total points are missing.

Before either optimizer consumes this candidate:

1. Bind input manifest/table hashes to the completed package's validation report;
   a caller-provided source-revision string alone is insufficient.
2. Run the authored regressions, then whole-date chronological training/tuning/
   final-test splits. Tune regularization on tuning data only, not the final test.
3. Compare raw rates, the current production model, and declared prior strengths.
   Report game-cluster uncertainty and coverage, including short appearances,
   low-usage reserves, non-shooters, traded players, stars, and postseason players.
4. Investigate Gobert/Beringer and Nance/Portis using their actual available
   evidence and settings, without hard-coding preferred winners.
5. Fit offensive-responsibility response separately from minutes when matching
   possession exposure and verified box-score components support it. Observational
   workload associations must not be described as proven causal effects.
6. Only after validation, route scoring objectives, production constraints,
   replacements, and explanations through the same accepted projection contract.
   Preserve user offense/defense priorities and exact constraint selection.

## Package status, distinct from model accuracy

The private additive package completed on September 7 with its full validation
report passing (zero errors and zero warnings):

    outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/
      scout-analytics/2020-26-final-20260907-v2-comprehensive-model-evidence/

It contains 7,776 games and 166,104 player-game rows. The explicit Sabonis
steals correction remains separate from original official evidence. Existing
analytics and the additive simulation/player-builder tables are preserved.
Package completeness is not proof of prediction accuracy: workload-response
fitting and this candidate's calibration remain incomplete. This model pass
does not delete older packages, publish private tables, or deploy site changes.
