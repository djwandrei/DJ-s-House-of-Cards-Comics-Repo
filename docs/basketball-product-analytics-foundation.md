# Basketball product analytics foundation

This document maps the basketball platform concepts to the browser-safe
analytics contracts now shipped with Lineup Lab. The contracts are foundations
for product interfaces, not claims that every proposed model is calibrated.

## Implemented contracts

| Product foundation | API | Current evidence boundary |
| --- | --- | --- |
| Individual player evaluation | `evaluateIndividualPlayers` | Twenty imported advanced box metrics plus offensive, defensive, and total RAPM when separately validated |
| Skill decomposition | `buildPlayerSkillProfiles` | Cohort-relative scoring, creation, spacing proxy, defensive-event proxy, shot blocking, and rebounding |
| Archetype detection | `detectPlayerArchetypes` | Multi-label membership scores; probabilities remain null until a labeled calibration set exists |
| Duo/trio/lineup fit | `analyzeLineupChemistry` | Explainable coverage, usage compatibility, and bounded redundancy; not causal chemistry |
| Player value separation | `buildPlayerValueProfiles` | Production, box-derived impact, possession-adjusted impact, and lineup fit stay in separate branches |
| Game simulation | `simulateGame` | Seeded score and win distributions from caller-supplied matchup rating, pace, variance, and context |
| Series simulation | `simulateSeries` | Seeded best-of-series probabilities using an explicit home schedule |
| Product gating | `assessBasketballProductReadiness` | Machine-readable supported, proxy-only, input-ready, and evidence-gated states |

## Individual advanced-stat model

The individual evaluator currently retains:

- PER and true shooting percentage;
- three-point and free-throw attempt rates;
- offensive, defensive, and total rebound percentages;
- assist, steal, block, turnover, and usage percentages;
- offensive, defensive, total, and per-48 win shares;
- offensive, defensive, and total BPM plus VORP;
- validated offensive, defensive, and total RAPM.

Each available metric returns its raw value, unit, cohort percentile, direction,
metric-specific comparison count and coverage, evidence mode, cumulative/rate
status, and sample confidence. Fewer than five comparable values can still be
shown descriptively but cannot enter a quality index. Usage and attempt rates
are descriptive: a higher value is not automatically better. Cumulative metrics
are explicitly marked because opportunity affects them. An overall index is
created only when a product supplies visible category weights.

RAPM is accepted only when the supplied record has a model version, 0-1
reliability, display eligibility, validated source provenance, and independent
box-score reconciliation. Missing or rejected RAPM never becomes zero.

## What remains gated

- Fine-grained shot, play-type, passing, off-ball, and defensive tendencies
  need validated tracking or tagged event evidence.
- Causal chemistry and adjusted together-vs-apart effects need comparable
  possession evidence with teammate, opponent, and context adjustment.
- Career-arc percentiles need a longitudinal cohort, injury/workload features,
  chronological validation, and skill-specific aging models.
- Matchup ratings and defender assignments need matchup, scheme, screen, and
  shot-quality evidence.
- Composite-player outcome forecasts need physical, cognitive, tendency, and
  interaction models; the skill graph alone is not enough.
- Season, seeding, and title simulations need calibrated team-state transitions
  layered over the game/series engine.

## Simulation interpretation

Simulation inputs must identify their model as `validated` or `exploratory` and
provide a model version. Results return the full assumptions, seeded sampling
configuration, score distributions, win probabilities, Wilson intervals, and
Monte Carlo standard errors. Those intervals describe finite simulation error;
they do not substitute for uncertainty in the underlying basketball model.
