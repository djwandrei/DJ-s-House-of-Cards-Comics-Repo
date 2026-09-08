# Lineup Lab takeover and validation handoff — 2026-09-07

This document records the context recovered from the original Codex task
**“Lineup Lap Optimization Work”** (the task title contains the spelling
“Lap”), its preserved session history, the checked-in implementation, the
private evidence outputs, and the validation run completed in the continuation
task. It is intended to let a later task resume without treating an old design
draft or a historical test report as current proof.

## User goal and recovered task state

The original request was to turn an R/lpSolve basketball lineup optimizer into
a fan-facing website tool, first building and testing the application and then
integrating it into DJ’s House of Cards & Comics. The requested product is a
transparent “what-if” lineup builder: choose a historical NBA team and season,
choose a starting five or a full rotation, set priorities and constraints, and
inspect why the exact result was selected.

The original task reached a substantial implementation checkpoint and then
stalled because its selected model repeatedly hit capacity/usage errors. The
latest completed checkpoint is commit `aa6372c6` (“Synchronize Lineup Lab
responsibility evidence release”), which is present at `HEAD` and `origin/main`
at the time of the original handoff. The continuation added the responsibility
guardrail test and released the reviewed static fan-tool path list. No
unfinished tool call from the original task needs to be replayed; future work
should use the files and evidence described here.

The original checkpoint included the following work:

- exact starting-five enumeration and exact integer rotation allocation,
  including hard locks, exclusions, positional assignment, minute bounds,
  projected production constraints, cancellation, progress, and a fallback to
  exact state enumeration when a continuous certificate has an integer gap;
- a per-36 rotation scoring path with an explicit legacy per-game compatibility
  choice, sample-adjusted rates, paired source evidence, uncertainty reserves,
  and additive explanations that reconcile to the returned objective;
- a separate Historical path and a private, validation-gated Scout path for
  O/D impact and possession evidence;
- Lineup DNA explanations, replacement comparisons with a stable reference
  pool, usage scenarios, saved scenario links, and individual-player views;
- source-first adapters for Basketball Reference/Supabase rows, strict missing
  value handling, and generated public release parity between the prototype and
  `/lineup-lab/`;
- fan-tool navigation and collector-oriented storefront styling while keeping
  checkout/catalog code separate from the optimizer.

## Repository and website map

DJHC is a static HTML/CSS/JavaScript storefront. There is no ordinary npm build
step. The buyer site uses `core.js` for shared initialization, theme, assets,
wishlist, fallbacks, and accessibility; `catalog.js` for product loading and
rendering; `supabase-client.js` as the only browser module that directly talks
to Supabase; `backend-admin.js`, `payments.js`, and `account.js` for admin,
checkout, and account behavior; and `nav.js`, `contact.js`, `seo.js`, and
`sw.js` for site-wide navigation, metadata, and caching.

The catalog sources remain separate from the sports tool:

- `products.json` is the protected local generation source;
- `products-public.json` and category files are generated buyer-safe outputs;
- Supabase `products` is the live catalog source;
- the authoritative non-legacy listing source is the `Listings` sheet in the
  protected eBay workbook;
- `assets/` contains product and fan-tool media.

The public fan-tools hub is registered in `tools/registry.js` and currently
contains the Lineup Lab/Lineup DNA experience, Fix the Five, Draft Night, Game
Decisions, Card Matchups, and the Workshop framework. Scout Studio and raw
possession/RAPM material are private boundaries. A static registry entry or a
local artifact does not prove that a private daily game is deployed or
available in production.

Lineup Lab has two copies by design:

- source: `prototypes/basketball-lineup-optimizer/`;
- deployable mirror: `lineup-lab/`.

`scripts/build-lineup-lab-release.mjs` owns the mirror. Its allowlist currently
contains 32 files and uses release revision `20260907f`. Never hand-edit the
generated mirror or generated catalog files. After an approved source change,
run the builder and then its full `--check` parity mode.

## Model contract now implemented

The optimizer separates four questions that had previously been easy to mix:

1. **Selection utility.** The visitor’s visible weights define the objective.
   Rotation mode defaults to per-36 opportunity rates so historical minutes do
   not silently become hidden ranking weight. Positive rescaling of all weights
   leaves decisions unchanged.
2. **Hard feasibility.** Locks, exclusions, exact roster size, positional
   coverage, integer minutes summing to 240, individual 0–48 bounds, and enabled
   production floors/ceilings are hard requirements. A flex player cannot fill
   two simultaneous positional slots.
3. **Evidence and uncertainty.** Counts, exposure, baselines, shooting
   opportunity, impact, and usage are kept in their own source- and scope-aware
   envelopes. Missing or contradictory values remain unavailable; explicit zero
   is preserved as known zero. Risk changes the downside reserve, not the fitted
   mean.
4. **Explanatory projections.** The returned player contributions, projected
   production, baseline index, replacement deltas, and minute diagnostics use
   the same objective and evidence assumptions as the exact solve.

The workload/responsibility boundary added in the last checkpoint is especially
important:

- selected-team stint minutes can describe a row and its confidence sample, but
  cannot silently become a season-wide role target;
- all-team season MPG can be a role-size anchor when it is actually present,
  but it is not a minute cap or coaching recommendation;
- a larger-role rate prior requires the explicit
  `scout-responsibility-evidence-v1` contract with a valid scope, games, minutes,
  and reconciled FGA/FTA/turnover involvement (or a separately source-bound
  Scout game subset);
- a calibrated chronological workload fit takes precedence, including a
  calibrated zero; malformed calibration fails closed;
- without that contract or fit, the optimizer does not invent a decline,
  usage elasticity, or confidence from raw team-stint minutes;
- offensive responsibility is separate from minutes and does not alter
  defensive metrics. A below-baseline player cannot improve merely because the
  requested rotation gives them more minutes.

This is an evidence-gated sensitivity/prior layer. It is not a causal fatigue
model, a learned usage law, or proof that the chosen lineup will win games.

## Evidence and private Scout status

The reviewed private 2020–26 Scout package is useful for model development but
is not production proof. Its saved validation reported a passed package with 30
teams, 328,240 player/team combinations, 2,252 on/off and profile records,
26,382 WOWY records, 1,083 net/O/D RAPM records, 4,517 eligible archives, and
897,735 exact possessions. The package contained 7,776 games and 166,104
player-game rows. Those figures describe the local evidence package at the
reviewed timestamp; they do not establish a deployed Edge Function, current
database parity, or predictive accuracy.

One provider anomaly remains documented: Sabonis’ provider steals value was
invalid and retained as missing; a user-authorized effective zero is recorded
separately from the official value. Do not turn that correction into a claimed
official observation.

The six-season reengineering documents correctly leave several gates open:
chronological train/tune/test evaluation, calibrated usage/workload response,
interaction terms, holdout comparisons against frozen and simple baselines,
parameter/subgroup robustness, and a full current-season integration. Exact
solver optimality proves only the configured mathematical objective; it does not
prove coefficient quality or basketball predictive accuracy.

Scout Daily Games likewise remain readiness-gated. Before calling them live,
there must be evidence for the private catalog, validated scope, service
credentials, Edge Function deployment, and static parity. No such live write,
deployment, or external charge was performed during this takeover.

## Validation completed in this continuation

The two failures found by the first full run were outdated workload fixtures,
not an optimizer regression. They now test the intended evidence boundary:

- a season-MPG-only row remains descriptive and does not activate a hidden
  responsibility prior;
- a fixed 40-minute low-role player with a valid season-wide responsibility
  contract has 32 expanded minutes, while the required minute assignment stays
  unchanged and projected totals are tempered.

The complete prototype suite now passes **326/326 tests**. This includes the
exact rotation oracle and integer-gap cases, source/season/team scope gates,
paired Scout evidence, workload and responsibility boundaries, production
constraints, scenario URLs, cancellation/progress, Lineup DNA explanations,
and fan-facing UI contracts.

An additional offline chronological benchmark was run against the available
2025-directory six-season trial archive without writing back to the repository
or private package. It accepted 856 eligible regular-season games with no
rejections and split them into 515 training, 168 tuning, and 173 held-out test
games. The selected conditional-rate path improved held-out MSE versus the raw
rate baseline for points (2.22%), assists (2.11%), steals (3.50%), ball security
(1.84%), and three-point rate (1.93%); rebounds (0.24%), blocks (0.54%), and eFG
(0.86%) had intervals that crossed zero. This supports keeping the current
parameters as a disclosed conditional benchmark, not promoting them to a
causal workload or lineup forecast. The aggregate report was written only to a
system temporary file and is not a release artifact.

Previously completed release checks at the same source checkpoint also passed:

- `node scripts/build-lineup-lab-release.mjs --check` — all 32 generated files
  synchronized at `20260907f`;
- `node scripts/site-integrity-check.mjs` — 30 HTML pages, 3,270 catalog rows,
  asset revision `20260907f`, and zero reported issues;
- `node scripts/audit-fan-suite-release.mjs` — 105 reviewed static files, no
  deletes, and no Scout Studio/private backend/catalog files included;
- JavaScript syntax checks and focused model/adapter tests;
- `git diff --check`.

The test and handoff edits are recorded in commits `8264c060` and `70851bd3`.
GitHub `origin/main` is synchronized at `70851bd3`, and the reviewed 105-file
fan-suite path list was uploaded to cPanel over verified FTPS. HTTP byte parity
after upload was 105/105 with zero differences and zero fetch errors. No
Supabase write or production browser smoke claim has been made.

## Season stability probe (2026-09-08)

The same `chronological-workload-v3` evaluator was run independently against
the six available season directories (2020 through 2025). Each directory was
split by whole UTC dates into development/tuning/test blocks, with parameters
chosen on tuning data only. The table reports held-out MSE improvement versus
the raw-rate baseline; positive values mean lower error. Each comparison used
1,000 paired whole-game bootstrap replicates with seed `20260905`.

| Season end | Games (train/tune/test) | Points | Assists | Rebounds | Steals | Blocks | Ball security | eFG | 3P |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2020 | 342 / 113 / 115 | 2.63% | 0.00% | 2.80% | 3.41% | 1.60% | 7.34% | 4.65% | 4.01% |
| 2021 | 378 / 125 / 126 | 1.50% | 0.00% | -0.29% | 0.71% | 2.13% | 2.82% | 2.65% | 3.59% |
| 2022 | 381 / 125 / 126 | 2.48% | 1.33% | 0.00% | 8.85% | 2.91% | 2.55% | 4.01% | 5.05% |
| 2023 | 435 / 141 / 147 | 1.28% | 0.77% | -0.15% | 3.45% | 2.44% | 0.15% | 2.47% | 4.00% |
| 2024 | 471 / 154 / 159 | 2.76% | 2.47% | 0.00% | 3.46% | 2.48% | 5.21% | 3.01% | 4.03% |
| 2025 | 515 / 168 / 173 | 2.22% | 2.11% | 0.24% | 3.50% | 0.54% | 1.84% | 0.86% | 1.93% |

Points and three-point rate improved in every season, with intervals above
zero in this probe. Steals, blocks, ball security, and eFG improved in every
season by point estimate, but one to two season intervals crossed zero. Assists
were unchanged in the first two seasons and had intervals crossing zero in
four of six seasons. Rebounds were inconclusive in all six seasons, including
two slightly negative point estimates. These results support a conditional
benchmark stability check; they do not validate a causal workload response,
unknown future minutes, lineup interactions, or a promoted cross-season
runtime calibration. The archives are eligible-game subsets rather than proof
of complete NBA-season coverage, and the per-season parameters were selected
within each season rather than frozen across seasons.

## Safe continuation order

For the next implementation task:

1. Inspect `git status --short --branch` and preserve unrelated user changes.
2. Read the relevant source prototype module and its tests first. Change the
   prototype before changing the generated mirror.
3. Run the narrow focused tests, then the complete prototype suite.
4. If a source release file changed, run
   `node scripts/build-lineup-lab-release.mjs` followed by
   `node scripts/build-lineup-lab-release.mjs --check`.
5. Run `node scripts/site-integrity-check.mjs` and `git diff --check`.
6. Treat Supabase parity, Edge Function deployment, cPanel FTPS, and production
   browser behavior as separate evidence requests. Do not infer them from local
   files or a passing unit suite.

The most valuable next model work is the documented holdout/ablation program,
especially the minutes-versus-responsibility tests and six-season chronological
validation. The most valuable next release work is a scoped rendered desktop
and mobile smoke check for the deployed fan tools. Future releases should
repeat the reviewed path-list process after the relevant source and generated
checks.
