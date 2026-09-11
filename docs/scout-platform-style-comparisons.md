# Scout platform attachment: first expansion slice

September 7, 2026. Local implementation only; not committed or deployed by this
pass. The controlling feature request is the user's attached `pasted-text.txt`
(sections 3–12). Its ideas are product requirements, not authorization to invent
missing evidence, expose private model inputs, or publish unfinished tools.

## Implemented

Player Blueprint and Composite Forge now share an observed-profile proximity
engine. This advances the attachment's component decomposition and stylistic
comparison ideas (sections 5, 7, 10 and the foundation for 11). It does **not**
implement a probabilistic archetype classifier.

- Blueprint excludes the selected player from candidates and shows up to three
  nearby profiles from the loaded team and exact snapshot.
- Forge requires all five donor blocks, compares the hypothetical component
  recipe with actual profiles, and explicitly identifies matches that are donors.
- Each suggestion shows nearby components, the largest normalized gap with its
  original units, and incomplete independent-reconciliation warnings.
- Comparison buttons open the existing Blueprint comparison or change only the
  Forge baseline. They do not change donors, save a recipe, or add an undo step.
- Results are collapsed by default and work with keyboard input. The existing
  layout and styling are reused; there is no visual redesign or new dependency.

## Method and evidence boundaries

Use `metricEvidence` to recompute the ten supported components from their source
numerators and denominators. The existing 25-attempt / 200-estimated-possession
review thresholds remain descriptive policy, not statistical confidence levels.

1. Retain target components that pass those checks.
2. Require each candidate to support **every** retained target component, using
   a fixed basis rather than easier subsets for players with missing data.
3. Require at least three eligible candidates. Drop constant components from
   ordering and require six varying components spanning at least three blocks.
4. Divide each absolute component difference by its eligible-cohort range.
   Average within each block, then average equally across blocks. This prevents
   a three-component block from automatically outweighing a one-component block.
5. Treat distances tied at eight decimal places equally; stable public handles
   decide display order only. Show at most three results.

This is an explicit, uncalibrated descriptive heuristic. Range scaling is
sensitive to cohort composition and outliers. A different target or recipe can
change the eligible basis, so distances are not comparable across searches.
There is no league percentile, match probability, talent grade, causal chemistry,
latent ability, or projected performance. A nearest profile can still differ
substantially. Donor proximity is expected by construction and is not external
validation. Physical and cognitive traits remain unmeasured.

Missing, duplicated, inconsistent, low-exposure, and non-finite evidence cannot
improve a candidate's ranking. Insufficient cohorts or variation produce an
explicit unavailable result. Every successful result retains the exact team and
snapshot, component basis, source denominators, and reconciliation flags.

Game Studio's foundations kept the calculations separate from rendering and
persistence. Its playtest workflow covered keyboard use, focus recovery,
collapsed secondary information, and both viewport sizes. The data-quality
workflow drove the fixed-grain, missingness, denominator, and scope checks.

## Historical source status — initial comparison pass

The intended four-season rebuild directory
`2022-26-final-20260906-v2-model-evidence.building` had no completed package
manifest. A newer single-season cache-smoke package existed and passed its own
package validation; it is not the completed four-season release. No automatic
fallback, source-package rewrite, fit, or import was performed.

Compatibility testing explicitly selected the completed
`2022-26-final-20260905-v1-recency-calibrated` package using the hash-bound command
in `scout-studio-roadmap.md`. This tests the presentation contract, not readiness
of the incoming rebuild. The current daily-game source contract is now
2017–18 through 2025–26; the pooled four-season preview described in this
historical comparison is not relabeled as player-season evidence.

The read-only Denver check loaded 38 profiles. Style matching had 17 eligible
other-player candidates and 18 composite candidates on ten varying components.
Only 1/38 source profiles was fully independently reconciled; 37/38 retain their
warning. Results are suitable for local descriptive review with those caveats,
not verified workload targets or predictive model training.

## Verification

September 7 follow-up: the completed six-season base package now passes the
explicit readiness gate. New York's real roster produces 24 eligible player
comparison peers and 25 composite candidates over ten components. Its 21/67
fully reconciled profiles remain distinct from the 46 with incomplete coverage.
Updated commands and package identity are in `scout-studio-roadmap.md`.

```powershell
node --test --test-concurrency=1 scripts/tests/scout-studio.test.mjs scripts/tests/scout-studio-analysis.test.mjs scripts/tests/scout-style-matches.test.mjs scripts/tests/scout-context-lens.test.mjs scripts/tests/scout-possession-simulator.test.mjs
$env:NODE_PATH = 'C:\Users\djwan\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
node scripts/scout-studio-smoke.mjs
node scripts/site-integrity-check.mjs
git diff --check
```

- 77 focused tests passed, including context, source-route and Game Lab coverage.
- Synthetic and six-season real-package browser checks passed at 1440px and
  390px, including player/composite style comparisons.
- Light/dark screenshots were inspected. Output remains ignored under
  `outputs/scout-studio-smoke/`.
- A synthetic maximum-size roster of 1,000 profiles returned three matches in
  21 ms in one local run. This is a spot check, not a performance guarantee.
- New and modified JavaScript passed syntax checks; site integrity passed.
- No extra team-shard reads or persistent data copies are required for matching.

## Next implementation sequence

The full feature/evidence matrix remains in `scout-studio-roadmap.md`.

1. **Source integration:** accept the completed new snapshot only after its
   validation and real profile grain are confirmed. Add season/context filters
   and cross-team donor joins only when the source contract supports them.
2. **Chemistry depth:** compare pinned observed groups and explain their shared
   players, exposures, and differences. Context-adjusted or unseen-group synergy
   needs separately trained and validated interactions.
3. **Simulation:** implement a seeded one-game scenario contract with explicit
   assumptions before predictive game, series, and season odds. Keep model
   uncertainty separate from Monte Carlo sampling variability.
4. **Learned features:** archetype membership, career arcs, assignment-based
   matchups, physical/cognitive traits, and nonlinear composite forecasts require
   their own data, fit, and held-out validation gates.

Existing optimizer work stays in Lineup Lab. None of the retired tool concepts
is restored. Public hosting still needs the approved private-to-public data
bridge, rights review, and live verification; uploading static Studio files
alone is insufficient.
