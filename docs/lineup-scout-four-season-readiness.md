# Lineup Lab: prepare now, fit and promote after validation

The incoming package covers season **start years 2022, 2023, 2024, and 2025**
(2022–23 through 2025–26). More seasons and more metrics are opportunities,
not evidence by themselves that a new optimizer is more accurate.

## Work that is safe before the package finishes

The read-only `scripts/audit-lineup-scout-readiness.mjs` preflight checks a
specific package manifest, its derived-package validation report, and its
source-archive validation report. It does not fit coefficients, modify the
running derivation, query a database, or change Lineup Lab's current model.

Example invocation (replace the three paths with the final output paths):

```powershell
node .\scripts\audit-lineup-scout-readiness.mjs --manifest "PATH\nba-scout-analytics-2022-26.json" --package-validation "PATH\nba-scout-analytics-validation-2022-26.json" --source-validation "PATH\checkpoint-validation-report.json" --seasons 2022,2023,2024,2025
```

The three possible results are:

- `pending` (exit 2): a required file is not available yet. Never substitute an
  older package automatically.
- `blocked` (exit 1): supplied metadata fails a check, or a file cannot be
  parsed/read. Correct or regenerate the evidence before considering adoption.
- `ready_for_integration_review` (exit 0): compact metadata passed. This is
  **not deployment approval** and does not certify every player's box scores.

Checks include exact season scope, SHA-256 binding of both validation layers,
completed-package status, team/profile coverage, primary O/D solver convergence, and the
existing package validator's chronological prediction and O/D ablation checks.
Additional checks require dated, nonempty train/tune/test blocks and identical
nonzero test denominators for the model and baseline. Equal scheduled times
at a split boundary produce a review warning, not an invented leakage claim.
Game-ID disjointness cannot be proved from aggregate date ranges alone.
Schema v4 does not export the net model's solver diagnostics. Their absence is
not a failure; an explicitly reported net solver failure is still rejected.

The preflight reuses `validate-local-scout-analytics.mjs` checks; it does not
replace that script's full streaming shard/replay validation. Rerun the full
validator if package files change. It reads only metadata (up to 16 MiB per
file), so it will not compete with derivation by loading enormous team shards.
No preflight files are included in the public release.

## What must wait for the final evidence

1. **Approve the exact package.** Require the completed derived validation,
   not merely successful downloading or raw-source validation. Review warnings
   and exclusions; do not require every historical field to exist or fill gaps
   with zero. Preserve the current working package until a replacement passes.
2. **Version the consumer contract.** Keep the player's selected season/team
   separate from the multiseason training window. Verify identity joins and
   all-team evidence without duplicating traded players. A four-season pooled
   total must never masquerade as the current season's per-game production.
3. **Require independently reconciled production evidence.** Use official
   summary totals for workload fitting only when every expected appearance is
   complete and reconciled. A partial or unreconciled component stays unknown,
   including when another team/season has enough numbers to make a plausible
   aggregate. An archive-level PASS does not remove these per-player gates.
4. **Benchmark before adding predictors.** Compare the new O/D model with the
   existing Scout baseline on the same held-out games and sample. The package's
   chronological test measures the full model; its separate game-fold ablations
   test offensive/defensive components. Neither establishes causal player
   impact or arbitrary-lineup accuracy. Do not repeatedly tune against the
   held-out test block; further tuning needs a fresh evaluation design.
5. **Fit responsibility and workload separately.** Use verified possessions,
   attempts, turnovers, and minutes to estimate what changes when offensive
   responsibility increases. Minutes are a decision variable, not a stand-in
   for usage. Do not impose a player's historical team minutes as a ceiling.
   Low-volume efficiency should gain credibility from actual evidence, not
   from multiplying it to per-36. Production constraints and the objective must
   use the same fitted workload assumptions.
6. **Keep upgrades only when they help.** Add uncertainty, contextual splits,
   and shared-court effects incrementally with out-of-sample comparisons.
   Avoid counting RAPM, on/off, and observed lineup residuals as independent
   additive bonuses without showing incremental value. Exercise Gobert/Beringer,
   low-attempt shooting, missing team totals, new players, offense-only,
   defense-only, and tight-constraint cases. Success means coherent responses
   to the user's requirements, not copying real NBA rotations.

## Verification of this preparation

```powershell
node --test .\scripts\tests\lineup-scout-readiness.test.mjs
node --test .\prototypes\basketball-lineup-optimizer\tests\scout-impact.test.mjs .\prototypes\basketball-lineup-optimizer\tests\scout-primary-benchmark.test.mjs .\prototypes\basketball-lineup-optimizer\tests\workload-evidence-boundaries.test.mjs
```

Readiness fixtures are synthetic contract tests, not fitted NBA results. A
successful test suite demonstrates fail-closed integration logic, **not an
accuracy improvement from the unfinished package**. No browser, generated
release, database, or live-site changes are necessary for this preparation.
