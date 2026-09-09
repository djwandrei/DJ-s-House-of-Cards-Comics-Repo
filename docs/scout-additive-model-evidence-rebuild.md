# Additive Scout evidence — expanded target: 2020–21 through 2025–26

## Scope

**Latest instruction:** finish the six-season data import and validation before
rebuilding. The earlier four-season offline rebuild was stopped at 4,700
processed games; its `.building` directory is an incomplete checkpoint, not a
completed or deployable package. The two added source seasons must be separately
validated and included in a new, six-season source revision. The existing
four-season RAPM calibration must not be relabeled as a six-season fit.

This rebuild preserves **all existing package analytics and fitted coefficients**
and adds compact modeling tables. It does not replace the existing RAPM,
lineups, on/off, WOWY, contexts, shooting profiles, residuals, or approximate
intervals. It does not claim that additional raw statistics alone make a new
predictive model accurate.

The user's excluded inputs remain excluded: defender assignments, screen
coverage, wingspan, injuries, contracts, and cognitive traits. The supplied
blueprint guides the new data contracts, not an assertion that every proposed
tool or simulation has already been fitted and validated.

## New data alongside the existing data

| Added table | Grain and purpose |
| --- | --- |
| `playerGames` | One player/game, with team, opponent, season, phase, actual minutes, independently sourced official totals, PBP totals, shooting opportunity, shot-type/distance evidence, and field-level reconciliation. |
| `playerSeasons` | Separate player/team/season/phase and all-team player/season/phase aggregates. Trades never erase a missing field or duplicate a player-game. |
| `gameContext` | Chronologically ordered game outcomes, team IDs, home/away, and time between observed scheduled starts. This is not measured rest or fatigue. |
| `assistedBasketConnections` | Game/team/passer/shooter counts from explicit assisted made baskets. These are not counts of every pass or causal chemistry effects. |
| `sourceGames` | Game-by-game source and optional official-summary overlay hashes. |
| `summaryRefreshQueue` | Any games that still need missing official fields after the refresh; no fabricated completion. |

Files are compressed JSONL under `model-evidence/`. The new manifest's
`modelEvidence` field records their sizes, hashes, row counts, definitions,
coverage, capabilities, and remaining limitations. Existing manifest fields
are preserved verbatim as JSON values.

## How this supports the requested tools

- **Lineup selection and rotations:** separate observed production, measured
  impact, actual minutes, and possession-ending involvement. Keep the exact
  constraint solver and offense/defense priorities. Required skills/roles can
  use observable evidence without pretending proxy labels are tracking data.
- **Games, series, and season simulations:** retain real game-level samples,
  outcomes, context, and team schedules for future distribution fitting and
  validation. Existing possession outcomes and pace remain available.
- **Composite players and skill profiles:** distinguish shot frequency from
  accuracy; retain shooting categories and distances with missingness. Novel
  skill combinations remain hypothetical rather than learned certainty.
- **Chemistry and tendencies:** add explicit assisted-basket relationships to
  the existing together/apart and lineup context evidence. Unseen-combination
  chemistry still needs validation; do not add RAPM and observed residuals as
  independent bonuses without demonstrating incremental value.
- **Career arcs and archetypes:** season/phase-specific profiles provide a
  trajectory foundation without mislabeling pooled four-season totals as one
  season. Four seasons alone are not a validated lifetime aging model.
- **Impact and matchups:** preserve adjusted O/D impact and observed opposing
  teams/lineups. No defender-assignment or screen-coverage inference is added.

## Important evidence rules

1. **Separate official source from PBP.** The official provider [Game Summary](https://developer.sportradar.com/basketball/reference/nba-game-summary)
   endpoint supplies independent player box-score fields. Missing archived
   fields trigger a refresh; the original PBP is never rewritten to force a match.
2. **Compare each field.** Missing, matching, and contradictory fields stay
   distinct. Partial totals remain available under explicitly partial names,
   while complete totals stay null when any contributing game is missing.
   An invalid provider count no longer discards the entire game: that field
   stays null, with `invalidFields` and `rejectedValues` retained in the source.
   Game/season modeling rows retain the invalid-field flag and count. Neither
   independent reconciliation nor the data-first gate can treat it as zero.
3. **Validate minute exposure separately.** An otherwise reconciled game is not
   workload-training eligible if official and reconstructed player minutes differ
   by more than five seconds. That tolerance is not a minute target or cap.
4. **Separate minutes and responsibility.** `FGA + 0.44 × FTA + TOV` is a named
   possession-ending involvement proxy. It is not observed touches, creation
   share, or a fitted usage elasticity. No new decline coefficients are invented.
   Direct player turnovers count explicit `turnover` rows only. The provider's
   `offensivefoul` label is retained separately, because the same play commonly
   has its own turnover row. Counting both creates an artificial second turnover.
   A missing explicit row remains a discrepancy, not an inferred correction.
5. **Keep numerator and denominator scope equal.** Full-game player totals are
   not divided by verified-lineup-only possessions. Those per-100 rates remain
   null in the new table until matching-scope numerators are available; the
   existing package's separately defined possession metrics remain intact.
   PBP per-36 rates also require reconciled full-game minutes. The independent
   Summary minutes supply the denominator, not a potentially incomplete stint
   sum. `officialRates` uses only official counts/minutes; the PBP `rates` field
   stays separate. One game's missing exposure withholds the complete season
   rate instead of inflating it, including after an all-team trade aggregation.
6. **No leakage claim from aggregate metadata.** Dates and chronological tests
   support checking temporal order, but future workload/chemistry fits must
   split by game and avoid repeated tuning against the final test set.

## Background workflow and recovery

`scripts/start-scout-model-rebuild.ps1` launches a hidden worker. API keys are
inherited through its environment only. They are not written to source, logs,
command-line arguments, or env files by these scripts. Requests are serial and
spaced at least two seconds apart across both keys. Authentication/access/rate/
quota failures stop the job; key rotation never bypasses those failures.

The default worker imports missing official summaries **only**. It does not
automatically rebuild, fit, validate a new package, upload, or deploy. Closing this chat or reaching a
token limit does not stop the worker. The computer must remain on and awake.
Reboots terminate the process, but its completed downloads/checkpoints survive.

To resume, rerun the same launcher arguments with keys configured in the local
process environment. Resume validates source hashes and skips completed
downloads. A stale writer lock after a crash requires verifying its process is
gone before removing only that lock. The scripts never delete an existing
source package or automatically remove old analytics.

After data completion has been verified, an explicitly **offline** rebuild can
use the launcher's `-Offline` switch. Do not run that switch while data is incomplete.
No API key is required and no provider request runs. Existing overlays are
used where available; the builder now refuses to promote an output when any
required official Summary field is missing. Passing structural validation
still is not a claim of a newly fitted workload model.

When a rebuild is eventually started, it initially lives in a `.building` directory. Per-game outputs
are checkpointed and bound to source/code hashes. Any source/code changes
require a fresh checkpoint version; they cannot silently mix old and new work.
The 30 existing team shards are hard-linked into the replacement, never edited,
and each is checked against its recorded SHA-256. Hard links avoid copying the
roughly 34 GB raw base a second time; deleting one directory entry later does
not remove the other's data. Never edit either linked shard in place.

Only after new-table checks and the existing full package validator pass is
the staging directory renamed to the completed output name. The new package
is not automatically uploaded, made public, or enabled in Lineup Lab.

## Current run

Data-first scope expanded September 6, 2026:

- Source seasons 2020/2021: `data-2020-2021-trial/`.
- Source seasons 2022–2025: `data-2022-2025-trial-composed/`.
- Active Summary import: `summary-overlays/2022-2025-20260906-v3-data-first/`.
- Sequential controller: `scripts/continue-scout-data-import.mjs` first resumes
  older source games, then imports newer summaries within an explicit local
  request budget. It cannot launch a package rebuild.
- Progress audit: `scripts/audit-scout-import-completeness.mjs` distinguishes
  unattempted games, failed archives, missing official fields, and contradictory
  fields. It does not relabel an actively changing archive as validated.

Original four-season target, **stopped and not complete**:

`scout-analytics/2022-26-final-20260906-v2-model-evidence`

The initial refresh stopped safely on HTTP 429 after 2,000 successful new
summaries. No further provider requests are made by the offline rebuild.
The original validated package and all completed summary files are retained.

Original stopped official-summary checkpoint:

`summary-overlays/2022-2025-20260906-v2/progress.json`

Current official-summary checkpoint (read only while its worker is active):

`summary-overlays/2022-2025-20260906-v3-data-first/progress.json`

Stopped four-season build checkpoint (not active):

`scout-analytics/2022-26-final-20260906-v2-model-evidence.building/progress.json`

These files, not this document, are the authority for current progress.

## Tests

```powershell
node --test scripts/tests/nba-scout-model-evidence.test.mjs scripts/tests/lineup-scout-readiness.test.mjs
node --test scripts/tests/scout-import-completeness.test.mjs
node --test prototypes/basketball-lineup-optimizer/tests/scout-impact.test.mjs prototypes/basketball-lineup-optimizer/tests/scout-primary-benchmark.test.mjs
```

The local `benchmark-lineup-scout-package.mjs` additionally reads the exact
validated private package and tests Gobert/Beringer coefficients under an
explicitly synthetic, isolated center-allocation scenario. Balanced and defense
currently prefer Gobert; offense-only prefers Beringer's package estimate. The
test checks exact optimization against exhaustive enumeration, not whether that
offensive estimate proves Beringer is a better real-world offensive player.
That small-sample/scenario limitation is a reason to validate workload and
uncertainty models—not to hard-code a star's identity into the solver.

## September 7 comprehensive additive build

The user authorized this expanded build, with all existing/planned metrics
retained. The base is the validated six-season
`2020-26-final-20260907-v2-comprehensive-model-evidence` package; the earlier
v1 base lineage was superseded and removed after v2 validation. It is not the
older interrupted four-season stage above. The output target
under the same private working prefix is:

`scout-analytics/2020-26-final-20260907-v2-comprehensive-model-evidence/`

Until final validation and promotion finish, outputs and `progress.json` remain
in the sibling directory ending `.building`. A completed base package or an
intermediate model-evidence report is not proof of final additive validation.

### Additive application tables

The original six model-evidence tables remain: `playerGames`, `playerSeasons`,
`gameContext`, `assistedBasketConnections`, `sourceGames`, `summaryRefreshQueue`.
Eight tables are added, without removing original manifest fields or metrics:

| Table | Intended use and evidence boundary |
| --- | --- |
| `simulationPossessions` | Ordered game possessions, both on-court groups, actual scoring outcomes, and eligibility/exclusion flags. Rejected reconstructions remain visible. |
| `rotationStints` | Observed game rotation intervals and lineup identities, with source validity flags; not new optimized rotations. |
| `shotEvents` | Recorded FG/FT outcomes, available shot labels/distance/location, explicit assists and court context. No guessed shot clock, defender assignment, or coordinate units. |
| `teamGames` | Game results, official/effective player-summed box totals, filtered possession cohort sizes, exact scoring histograms and paired offense/defense outcomes. |
| `playerSeasonSkillProfiles` | Team-specific and all-team season/phase donor profiles, measured ratios, field coverage, shooting counts, and unavailable-trait declarations. |
| `playerIdentities` | Provider/NBA identity crosswalk, observed membership/position ranges and conflict flags. Existing authorized media can join through reference IDs; no invented headshot URL. |
| `teamSeasonSimulationProfiles` | Season/phase team scoring distributions, exact tails rather than one 4+ bucket, empirical moments, and contributing game IDs. Not calibrated forecasts. |
| `sourceCorrections` | Explicit user-authorized corrections, immutable original values, reason, scope, and original source/overlay hashes. |

Simulation exports stream from per-game checkpoints to limit memory use. Every
gzip is decoded and its row count checked. Existing base JSON/gzip team shards
are preserved through hard links and verified by hashes; the builder never
rewrites a linked shard. Existing manifest keys must compare exactly equal.
Source-code hashes are checked before export and after full package validation
to reject a build whose implementation changed midway through execution.

### Sabonis correction and independent evidence

For game `019f60d6-36a1-46cb-98ae-395c11d4a851`, the provider's Sabonis steals
count was -1. The user explicitly directed an effective value of 0. The private
ledger `work/scout-user-corrections-20260907-v1.json` binds that one field to its
player/team/game and original raw/overlay hashes. The original rejected value
is retained; effective totals/rates and correction identifiers are additive.

This satisfies the effective-data completeness gate without pretending the
provider supplied a valid zero. Original official completeness remains false
for that field, and a user correction does not become independent PBP/box-score
reconciliation or workload-training eligibility. The optimizer's compact
evidence compiler still requires actual matched official/PBP observations.

### Observed build checkpoint and remaining modeling work

At the September 7 base-preservation phase, 7,776 in-scope games had produced
166,104 player-games across 1,096 players. Of these, 166,081 were fully
field-reconciled, 96,808 passed the existing workload-training eligibility
gate, and one had the explicit user correction. These are build-stage counts,
not final validation or predictive-performance claims. All 14 gzip tables had
been written; the original package preservation/full validation was pending.

The independent acquisition/application contract tests passed (28 existing
cases and 5 new application/correction cases). The optimizer suite was not
rerun in this pass. No live data promotion or older-package deletion occurred.

The package preserves the planned tool surface, but data availability is not
application validation. Fitted possession models, shared-court interactions,
synthetic-player feasibility/coherence constraints, aging models, and
out-of-sample uncertainty calibration remain implementation/evaluation work.
The user's excluded traits (defender assignments, screen coverage, wingspan,
injuries, contracts, cognitive traits) are not fabricated. Other planned traits
remain declared even when missing from this provider archive.
