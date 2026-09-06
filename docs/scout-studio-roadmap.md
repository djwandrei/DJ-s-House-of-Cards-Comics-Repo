# Scout Studio: current-package audit and product plan

Updated September 6, 2026. This plan interprets the ten concepts in the user's
attached text (items 3–12). It replaces the next-tools direction, not the
existing Lineup Lab, Lineup DNA, Fix the Five or Draft Night implementations.

Scope exclusion requested September 6: **Two Truths, One Box Score; Evidence
Court; Statline Sleuth; Optimizer Sensitivity Studio; Franchise Fingerprints;
and Phase Flip are retired**, not queued for development. Their public registry
cards and workshop definitions have been removed. They are named here only to
record the decision and prevent accidental reintroduction. Existing browser
drafts are left untouched; no user data or historical source documents are deleted.

## Outcome

Use the **new four-season Scout package**, not the old single-season v10 package,
as the private evidence foundation. Begin with **Player Blueprint** and
**Chemistry Lab**, then add a constrained composite-player workbench and a
calibrated scenario simulator. Build the reusable evidence contract first so
each subsequent tool inherits source scope, null handling and uncertainty.

The first two workbenches are implemented locally in `tools/scout-studio/`.
They are not deployed or promoted to live tools. This task did not send work
to other tasks or modify the running Scout derivation / existing optimizer.

## Which package was inspected

The actual build was identified from the running process and the latest state
of **Sports Analytics Work — Primary**, then verified against its completed
manifest and validation report. The build completed during this work.

- Directory, relative to the repo:
  `outputs/01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e/nba-last-five-seasons/scout-analytics/2022-26-final-20260905-v1-recency-calibrated/`
- Manifest: `nba-scout-analytics-2022-26.json`.
- Manifest SHA-256:
  `81d8dec894ad942a8b79784a2abbbf180ecf472f5d7bb3b1edd13e977d55540f`.
- Derived validation: `nba-scout-analytics-validation-2022-26.json`, passed
  September 6 at 08:34:39 UTC (03:34:39 America/Chicago), zero errors/warnings.
- Source validation:
  `validation/2022-2025-trial-composed-20260905-v1-source-attested/checkpoint-validation-report.json`
  under the same `nba-last-five-seasons` root. Passed with **19 warnings**.
- Schema 4, metrics `nba-scout-metrics-v4`; current reconstruction v3.
- Season **start** years 2022, 2023, 2024, 2025: 2022–23 through 2025–26.
- Eligible phases: regular season, in-season tournament, play-in, playoffs.

The source window is not proof of complete NBA coverage. The build discovered
5,588 archives, identified 5,282 official candidates, and included 3,214 after
current reconstruction eligibility checks. Do not describe the output as every
NBA game or every player's complete season. The source warnings remain relevant
even though derived-package validation passes.

| Validated package object | Count | Interpretation |
| --- | ---: | --- |
| Team shards | 30 | Franchise-specific evidence |
| Lineup/co-presence combinations | 228,448 | Exact fives and smaller shared-floor groups, not all exact lineups |
| Player on/off rows | 1,573 | Team-specific; not 1,573 unique players |
| Direct player profiles | 1,573 | Team-specific pooled event totals |
| WOWY pairs | 17,838 | Same-game together/apart observations |
| Players per RAPM model | 869 | One combined fitted window; net and offense/defense models |
| Attributed possessions | 639,640 | Verified possession-start lineups |

The net model selected lambda 2,500 and prior-season weight 0.75; the O/D model
selected lambda 2,500 and prior-season weight 0.5. Both have chronological
tuning/test metadata, and the O/D component calibration passed. These private
parameters describe this build; they are not public game outputs. The reported
O/D held-out MSE improvement against its venue baseline is about **0.838%**—not
an 83.8% gain, win probability, or evidence of calibrated career/game forecasts.

The new package has roughly 34.3 GB of uncompressed team JSON (2.26 GB gzip).
Never load it wholesale into a browser or `JSON.parse` every team at once.

## Important grain and integration findings

1. **Player profiles pool the full window within each team.** A season context
   exists for team and player on/off rows, but the detailed direct-event player
   profile is emitted once per team/player. A UI cannot relabel that profile
   "2025–26" or infer season-by-season skill change from it. Season-keyed direct
   profiles are a follow-up pipeline requirement, not a filter we can invent.
2. **The Supabase compact importer omits detailed shot-zone and shot-label
   profiles.** `compactProfile` retains scalar shooting and rates; the completed
   private JSON contains `shooting.shotZones`, `providerShotTypeProfile`, and
   `providerShotDescriptionProfile`. The new local reader consumes the current
   package directly; production needs an explicit private importer/RPC contract
   extension before those features can be served.
3. **A ready archive selected only by ending year is ambiguous.** The existing
   private RPCs select the latest ready import for `season_end_year`. Multiple
   windows end in 2026. New public wrappers must pin the exact snapshot and full
   season scope, not silently pick a different archive.
4. **Observed WOWY is not causal chemistry.** Different teammates, opponents,
   roles and game situations affect the cells. Raw differences are useful film
   questions, not a learned interaction coefficient.
5. **An unseen lineup has no learned synergy.** Current exact-five projections
   use the five net RAPM values plus possession-shrunk observed residual synergy;
   unseen combinations do not get an invented interaction bonus. Approximate
   descriptive intervals omit some dependence and model uncertainty.
6. **Model training window and game eligibility are different controls.** The
   daily games still retain the user's last explicit 2023–24 through 2025–26
   challenge window. This four-season analysis preview does not broaden those
   games to 2022–23. A combined player-window effect also cannot be labeled as a
   distinct player-season effect without an appropriate model contract.

## All ten requested concepts

| Concept from attachment | Current Scout support | Build direction and unmet evidence |
| --- | --- | --- |
| 3. Optimal lineup construction | Calibrated net and O/D effects, exact-five observations, shrinkage, exposure, context splits; existing Lineup Lab optimizer | Extend the existing optimizer after its integration gate. Offense/defense/two-way objectives have evidence. Shooting/rebounding can use explicit observed production constraints. Usage response, switching, size, salary, age and injury constraints need appropriate inputs; do not invent nonlinear fit bonuses. Bench/stagger/rotation decisions remain in Lineup Lab. |
| 4. Game, series, season simulation | Possession outcomes, team rates/four factors, venue and context, lineup estimates | Start with a transparent one-game **scenario** engine, fixed seed and editable assumptions; train and test a possession-to-score model before claiming predictive odds. Game-grouped chronological validation, score/margin interval coverage, Brier/log loss and calibration curves precede series/season Monte Carlo. Fatigue, injuries, travel, coaching and foul substitution responses are explicit missing inputs, not hidden adjustments. |
| 5. Composite player builder | Observable shot accuracy/frequency, production, disruption, profiles and sample sizes | Build a donor-component recipe (shooting, creation production, rebounding, disruption) with exact donor scope, physical feasibility warnings and reversible local state. A composite is an experimental profile, not the sum of donors' RAPM. Usage, efficiency, role and impact distributions need separately fitted joint-response models. Cognitive/physical sliders cannot be inferred from current events. |
| 6. Duo/trio/lineup chemistry | Co-presence groups, exact fives, WOWY, O/D context, observed exact-five residual | **First implementation: Chemistry Lab.** Select 2–5 players, inspect observed ratings, possession samples and intervals; show four WOWY cells for pairs. Next: calibrated context-adjusted interactions with held-out group tests. No arbitrary 0–100 Synergy Score now. |
| 7. Player tendency analysis | Structured shot distances, optional shot labels, direct counts, role/exposure and team/player on/off context | **First implementation: Player Blueprint.** Shot zone shares/accuracy, missing distance/labels, and explicit per-100 denominators. Next: season-keyed and context-conditioned direct profiles. No claims about ball movement choices, screens, defensive assignments or true half-court play types from absent qualifiers. |
| 8. Career-arc prediction | A recent four-season window, historical on/off context and public identity joins elsewhere | First show observed role/production history once season-level direct profiles are available. Prediction needs substantially longer age-linked career cohorts, out-of-time tests and survivorship/injury handling. Skill-specific aging, breakout/decline probabilities and 10/25/50/75/90th-percentile trajectories remain research, not fabricated outputs. Salary/awards/Hall-of-Fame forecasts need separate data. |
| 9. Player impact/value | Net and separate O/D RAPM, context, exposure and calibration | Keep production, adjusted impact and lineup fit separate. Build an authenticated impact explanation layer with approved public-safe summaries. Wins added, replacement value, playoff translation and floor/ceiling labels need explicit baselines and out-of-sample validation. Do not equate raw plus-minus with impact or simple RAPM sums with wins. |
| 10. Skill decomposition | Scoring/shooting, recorded assists/turnovers/rebounds/steals/blocks, foul pressure and role exposure | **First foundation: the Blueprint metric contract.** Every component retains value/null, unit, numerator, denominator, scope and method. These are observed components, not latent scouting grades. Off-ball gravity, decision speed, screen navigation, physical tools and assignment defense remain unmeasured. |
| 11. Archetype detection | Observable style components; no fitted probabilistic archetype classifier | Fit a multi-label or mixture model on complete, season-keyed, exposure-gated cohorts. Report membership uncertainty and stability across holdout seasons. Start with interpretable style components, not handpicked labels disguised as probabilities. Season and lineup-context changes need the corresponding feature grain. |
| 12. Matchup analytics | Opponent exposure in adjusted models, team context and lineup observations | Start with lineup-v-lineup scenario comparisons and documented assumptions. True player-v-defender or scheme advantage requires assignment/tracking/play-type data. Do not invent contest distance, doubles, switches or likely coverage from box-score stats. A Matchup Advantage Score waits for that evidence and a calibrated definition. |

## Implementation sequence and acceptance gates

### Tranche 1 — Evidence workbenches (implemented locally)

- Player Blueprint: all package teams, player selection, 10 observable components,
  same-team side-by-side comparisons, shot zones and shot descriptions.
- Chemistry Lab: 2–5 distinct players, exact-five/co-presence semantics, observed
  ratings, sample gate, intervals, four WOWY cells and honest unseen-group state.
- Small read-only server, exact package arguments, metadata/hash/season checks,
  streamed single-team parsing, one-team compact cache and row reconciliation.
- No credentials, Supabase calls, raw-archive routes, exports or uploads. Server
  binds only to `127.0.0.1` and rejects cross-origin and rebinding requests.
- Opaque snapshot/team/player handles. No raw RAPM, coefficients, provider IDs,
  raw nested contexts or archive paths in browser responses.
- No public registry promotion: the live storefront continues to advertise only
  released experiences. This preview is not an Edge Function or cPanel backend.

Acceptance: current-package contract tests, real-package one-team spot check,
desktop/mobile browser interactions, no private leakage, correct null/sample
behavior. A full 30-team browser audit and production service remain separate.

### Tranche 2 — Production data bridge and useful depth

1. Extend the **private** query import with bounded shot-zone/label fields;
   preserve exact source hashes and existing immutable import behavior.
2. Pin snapshot/window in service queries; add stable public handle mappings.
3. Confirm rights for public derived-stat display. Review the explicitly
   allowlisted response separately from private-model access.
4. Add a commerce Edge Function boundary through `supabase-client.js`, input
   limits, origin/auth policy, rate/cost controls and privacy tests. Never expose
   private analytics tables directly to the browser.
5. Add season-keyed direct profiles in a future derivation, with count and
   official-box-score reconciliation. Do not mutate the completed package.
6. Add broader cohorts and context filters only at their true aggregation grain.
7. Deploy approved backend first, then exact static asset/page release. Recheck
   live outputs and parity before marking the tools live.

### Tranche 3 — Composite Forge and simulation

Build the donor-component composition UI against the Blueprint contract. Store
only the recipe locally, label it hypothetical, and show missing feasibility
inputs. In parallel *as a product sequence, not a dispatched task*, define and
validate a one-game possession model. Move to playoff series and season brackets
only after the one-game predictive checks pass. Avoid publishing impressive but
uncalibrated probabilities.

### Tranche 4 — Learned chemistry, archetypes, career and matchups

Use season-keyed, complete comparison cohorts for archetypes and skill changes.
Evaluate learned interaction terms versus additive baselines on held-out games
and previously unseen groups. Extend career windows and obtain needed tracking,
contract and availability inputs before implementing claims that depend on them.

## Reproducible local use

Run from the repository root. These variables are local path conveniences, not
credentials. Use the final package explicitly; there is no directory discovery
or older-package fallback.

```powershell
$scoutRoot = '.\outputs\01a0322f-56b6-7e02-8a5b-e31f0f6e3f4e\nba-last-five-seasons'
$scoutPackage = "$scoutRoot\scout-analytics\2022-26-final-20260905-v1-recency-calibrated"
$scoutSourceReport = "$scoutRoot\validation\2022-2025-trial-composed-20260905-v1-source-attested\checkpoint-validation-report.json"

node .\scripts\preview-scout-studio.mjs --manifest "$scoutPackage\nba-scout-analytics-2022-26.json" --package-validation "$scoutPackage\nba-scout-analytics-validation-2022-26.json" --source-validation $scoutSourceReport --seasons 2022,2023,2024,2025
```

Open `http://127.0.0.1:4187/tools/scout-studio/`. A plain static server shows
the unavailable connection state; it cannot read private files.

The preview reuses `scripts/audit-lineup-scout-readiness.mjs` and
`scripts/lib/lineup-scout-readiness.mjs` from the concurrent Lineup Lab work.
Those files were untracked at the start of this task and were not modified here.
They are now present in the concurrent project commit; keep these shared checks
versioned alongside the preview. It also reuses the current validator's streamed
parser. A retained background preview launch was blocked by the environment;
the integration browser checks use a temporary local server and shut it down.

Checks:

```powershell
node --test --test-concurrency=1 .\scripts\tests\scout-studio.test.mjs
node .\scripts\check-scout-studio-package.mjs --manifest "$scoutPackage\nba-scout-analytics-2022-26.json" --package-validation "$scoutPackage\nba-scout-analytics-validation-2022-26.json" --source-validation $scoutSourceReport --seasons 2022,2023,2024,2025
$env:NODE_PATH = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node .\scripts\scout-studio-smoke.mjs
node .\scripts\site-integrity-check.mjs
```

Add `--browser` to `check-scout-studio-package.mjs` (with `NODE_PATH` above) to
run desktop/mobile browser checks against the real selected package. Screenshots
are saved under the ignored `outputs/scout-studio-smoke/` directory; real records
and screenshots are not release assets. Both the synthetic-flow browser suite
and the real Denver browser check passed at 1440px and 390px.

## Validation assessment

**Share with caveats as a local development preview; not a public production
release.** Source and derived metadata are current and hash-bound. Unit tests
recompute source numerators/denominators and exercise profiles from the actual
current derivation function. Browser fixtures are clearly synthetic and do not
prove NBA predictive quality. Package data are never replaced with fixtures in
the real runner. The completed package's all-shard validator and the new
one-team integration spot check serve different purposes.

The real-package spot check used **Denver Nuggets**, the smallest team shard
(823,344,291 bytes). Streaming and hash verification took about 19 seconds.
All 38 profiles reconciled to the manifest's row count; 376 of 380 displayed
component slots had observed values and four remained unavailable. The selected
most-used pair had an observed co-presence result and all four WOWY partitions.
Only **1/38 profiles** reported `complete_and_reconciled` independent box-score
status; 37/38 were not fully reconciled. This is a material limitation for using
those event totals as complete production/workload targets, not a reason to
silently fill their missing evidence or claim the whole package failed.

Blocking promotion issues: public-rights review, production data bridge, complete
window/snapshot pinning, independent player completeness review, and hosted
verification. Analytical caveats: pooled team-window grain, selective game
eligibility, optional shot labels, uneven samples, descriptive intervals, and
non-causal WOWY. These are visible in the tools, not buried in a score tooltip.

### Evidence pointers

- `scripts/derive-local-scout-analytics.mjs`: `playerProfileFromEvents`,
  `comboRow`, `wowyRow`, output scope/definitions and streamed team descriptors.
- `scripts/validate-local-scout-analytics.mjs`: model/coverage validation and
  bounded `streamTeamShardJson` parser.
- `scripts/import-local-scout-analytics.mjs`: `compactProfile` field allowlist.
- `supabase-analytics/supabase/migrations/20260902090058_nba_scout_archive_query_index.sql`:
  existing private query scope and latest-ready ending-year selection.
- `docs/nba-scout-analytics-coaching-guide.md`: source caveats and unsupported
  tracking/medical/contractual claims.
- `docs/scout-daily-games-contract.md`: existing game window and privacy rules.
