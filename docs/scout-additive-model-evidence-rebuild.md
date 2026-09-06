# Additive Scout package rebuild — 2022–23 through 2025–26

## Scope

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
3. **Validate minute exposure separately.** An otherwise reconciled game is not
   workload-training eligible if official and reconstructed player minutes differ
   by more than five seconds. That tolerance is not a minute target or cap.
4. **Separate minutes and responsibility.** `FGA + 0.44 × FTA + TOV` is a named
   possession-ending involvement proxy. It is not observed touches, creation
   share, or a fitted usage elasticity. No new decline coefficients are invented.
5. **Keep numerator and denominator scope equal.** Full-game player totals are
   not divided by verified-lineup-only possessions. Those per-100 rates remain
   null in the new table until matching-scope numerators are available; the
   existing package's separately defined possession metrics remain intact.
6. **No leakage claim from aggregate metadata.** Dates and chronological tests
   support checking temporal order, but future workload/chemistry fits must
   split by game and avoid repeated tuning against the final test set.

## Background workflow and recovery

`scripts/start-scout-model-rebuild.ps1` launches a hidden worker. API keys are
inherited through its environment only. They are not written to source, logs,
command-line arguments, or env files by these scripts. Requests are serial and
spaced at least two seconds apart across both keys. Authentication/access/rate/
quota failures stop the job; key rotation never bypasses those failures.

The worker refreshes missing official summaries, then automatically builds the
additions and runs full package validation. Closing this chat or reaching a
token limit does not stop the worker. The computer must remain on and awake.
Reboots terminate the process, but its completed downloads/checkpoints survive.

To resume, rerun the same launcher arguments with keys configured in the local
process environment. Resume validates source hashes and skips completed
downloads. A stale writer lock after a crash requires verifying its process is
gone before removing only that lock. The scripts never delete an existing
source package or automatically remove old analytics.

The replacement initially lives in a `.building` directory. Per-game outputs
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

Started September 6, 2026. Target under the private NBA archive:

`scout-analytics/2022-26-final-20260906-v2-model-evidence`

Official-summary checkpoint:

`summary-overlays/2022-2025-20260906-v2/progress.json`

After the refresh, build progress:

`scout-analytics/2022-26-final-20260906-v2-model-evidence.building/progress.json`

These files, not this document, are the authority for current progress.

## Tests

```powershell
node --test scripts/tests/nba-scout-model-evidence.test.mjs scripts/tests/lineup-scout-readiness.test.mjs
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
