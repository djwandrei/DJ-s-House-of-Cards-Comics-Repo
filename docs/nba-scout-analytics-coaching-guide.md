# NBA Scout Analytics Coaching Guide

## Purpose

This guide explains the local NBA Scout analytics package built from the licensed Sportradar play-by-play archive. It is intended for future Lineup Lab, scouting, roster-construction, game-prep, and player-development tools.

The package is a decision-support system, not a replacement for coaching judgment. It separates direct provider facts, reconstructed lineup facts, model-based estimates, and transparent proxies so a user can see what each number can and cannot establish.

## Data scope and evidence levels

The current package covers the selected 2025-26 official NBA phases in the local archive: regular season, in-season tournament, play-in, and playoffs. It uses non-rescinded structured play-by-play statistics and a current-version reconstruction of lineups, stints, and possessions. It performs no network request or Supabase write while deriving the package.

| Evidence level | What it means | Examples | Correct use |
| --- | --- | --- | --- |
| Direct event fact | A structured provider event reports it. | Shot result, assist, rebound, steal, block, foul, player box-score total. | Describe observed production and style. |
| Reconstructed lineup fact | A verified five-player lineup is attached to a possession or stint. | Exact five-man rating, player on/off exposure, rotation minutes. | Evaluate combinations and rotations with sample context. |
| Regularized model | A ridge regression estimates an adjusted contribution. | Net RAPM, offensive RAPM, defensive RAPM. | Compare players after teammate/opponent context adjustment; retain the reliability tier. |
| Proxy or qualifier absence | A clear rule approximates a concept the archive does not directly label. | Garbage-time proxy, leverage proxy, non-provider-fastbreak context. | Filter film or frame questions; do not treat as ground truth. |

## The core coaching dashboard

Every tool should start with four questions:

1. What is the sample? Show games, possessions, minutes, reliability grade, and the selected phase/context.
2. What unit is being evaluated? Distinguish an exact five-man lineup from a two-, three-, or four-player shared-floor combination.
3. What did it produce? Show offensive rating, defensive rating, net rating, four factors, shot profile, and possession outcomes.
4. What should happen next? Present a film question, rotation option, matchup hypothesis, or player-development action—not an unsupported causal conclusion.

## Team and lineup performance

### Ratings and scoring margin

- **Offensive rating (ORtg):** points scored per 100 offensive possessions. Use it to compare scoring efficiency across uneven minutes or games.
- **Defensive rating (DRtg):** points allowed per 100 defensive possessions. Lower is better.
- **Net rating:** ORtg minus DRtg. It summarizes a unit's possession-level scoring margin.
- **Plus-minus per 100:** score differential scaled by all offense and defense possessions. It is a descriptive companion to net rating.
- **Reliability and 95% intervals:** display sample stability, not proof that a lineup or player caused the result.

Use ratings in rotation planning by comparing a candidate unit’s all-sample output with the same unit’s clutch, opponent-quality, venue, period, and recent-window contexts. Small samples should produce a “test on film” recommendation rather than a hard rotation rule.

### Exact lineups and co-presence groups

- **Five-player lineup:** the exact five players verified at the start of a possession. This is the strongest lineup record in the package.
- **Two-, three-, and four-player combination:** a shared-floor co-presence group. It answers whether a pair, trio, or quartet played together; it is not a complete lineup.
- **Exposure:** games, team possessions, minutes, possessions per game, minutes per game, and pace per 48 minutes.
- **Continuity:** team possession share, team minute share, games used, and—only for exact five-player lineups—starting and closing lineup counts/rates.

Use exact five-man rows to decide which units deserve more testing, which should be protected against certain opponent styles, and which may be running unusually hot or cold. Use pair/trio rows to explore compatibility before selecting a full five-man group.

### On/off and WOWY

- **Player on/off:** compares team performance in a player's on-court and same-game off-court possessions. Same-game scope reduces schedule mix but does not remove role, lineup, opponent, or score-state selection effects.
- **With-or-without-you (WOWY):** partitions a pair’s sample into both on, player A on/player B off, player A off/player B on, and both off.

Use on/off to identify questions such as “Does the team’s turnover rate rise when this primary handler sits?” Use WOWY to investigate whether two players are complementary, redundant, or simply deployed in different contexts. Always pair these views with minutes, lineup mix, and film.

## Adjusted player value

### Regularized adjusted plus-minus

The package fits weighted ridge RAPM on current reconstructed possession-start lineups. The offense/defense model also includes a directional home-court term, so a fixed venue advantage is estimated outside the player coefficients. Player-level home/away exposure-balance diagnostics accompany that estimate; a strongly one-sided schedule can still confound venue and roster effects, so the term is not presented as causal proof.

- **Net RAPM per 100:** regularized adjusted net contribution.
- **Offensive RAPM per 100:** estimated offensive contribution relative to the fitted baseline.
- **Defensive RAPM per 100:** estimated defensive contribution; positive is better defense in this package.
- **Combined O/D RAPM:** the combined adjusted estimate.
- **Teammate and opponent context:** exposure-weighted average teammate and opponent net RAPM values are shown as context, not added a second time as an adjustment.
- **Reliability:** ridge/exposure proxies and sample tiers; they are not confidence intervals.

RAPM is best for choosing which players merit more lineup experiments, estimating an unseen five-man group, and avoiding raw-plus-minus traps. It is not a final player ranking. Ridge regularization shrinks noisy samples, and lineup deployment is not random.

### Lineup projection

For an unseen five-player lineup, the neutral projection starts with the sum of the five players’ net RAPM values. For an observed exact lineup, it adds a possession-shrunk residual synergy after opponent and home-court exposure adjustment. The home-court adjustment uses the net RAPM model's signed home-versus-away term, weighted by that lineup's actual home/away possession exposure, so its context adjustment stays in the same fitted model as its player values.

Use projection to prioritize controlled lineup trials. Present the projected result beside observed net rating, possessions, synergy weight, and a clear note that the model does not capture all role, matchup, or injury effects.

## Possession quality and style

### Four factors and shooting profile

- **Effective field-goal percentage (eFG%):** `(FGM + 0.5 x 3PM) / FGA`; weights made threes correctly.
- **Turnover rate:** `TOV / (FGA + 0.44 x FTA + TOV)`; measures possessions lost before a shot outcome.
- **Offensive rebound percentage:** `ORB / (ORB + opponent DRB)`; measures second-shot access where rebound evidence is structured.
- **Free-throw attempt rate:** `FTA / FGA`; captures rim pressure and foul drawing at a team/unit level.
- **True-shooting percentage:** `points / (2 x (FGA + 0.44 x FTA))`.
- **3PA rate:** `3PA / FGA`.
- **Shot zones:** structured two-point distances split into at-rim (0–4 feet), short mid-range (5–14 feet), and long mid-range (15+ feet). Unknown distances do not enter a zone count.

Use this group to turn a rating difference into an explanation. For example: “The unit’s defensive rating is strong because opponent eFG% and rim frequency fell, but it gives up offensive boards.”

Always show the four-factor coverage status. Missing structured statistics, unknown made/miss results, and nonparticipant or role-inconsistent team attribution make the affected aggregate partial rather than silently treating the event as zero.

### Playmaking, disruption, and possession extensions

- **Playmaking:** assists, assists per 100 possessions, assisted-FG rate, assist-to-turnover ratio, fouls drawn, and fouls drawn per 100.
- **Defensive disruption:** steals, blocks, personal fouls, per-100 rates, block rate, and steal-forced-turnover rate.
- **Second chance:** an offensive possession is flagged only when its structured event slice contains an offensive rebound. The package reports second-chance possessions, points, rate, points per 100 possessions, and points per second-chance possession.
- **Points off turnovers:** a possession is flagged only when its opening event contains a structured opponent turnover. The package reports possession count, points, rate, points per 100 possessions, and points per possession after a turnover.
- **Possession outcomes:** counts and rates for 0, 1, 2, 3, and 4+ points.

These measures are particularly useful for scouting transition defense, offensive glass priorities, pressure packages, end-of-quarter play calls, and player development. The evidence rule matters: absence of a structured event is not treated as a made-up tactical label.

## Game context and situation splits

All team, lineup, player on/off, and WOWY aggregates can be partitioned by the following contexts.

| Split | Definition | Practical question |
| --- | --- | --- |
| Phase | Regular, in-season tournament, play-in, or playoffs. | Does the rotation travel to higher-stakes games? |
| Venue | Home or away team perspective. | Is the performance portable? |
| Period / half | Q1, Q2, Q3, Q4, overtime; first half, second half, overtime. | Which units start, close, or stabilize third-quarter runs? |
| Rolling windows | Last 5, 10, and 20 eligible games at the archive snapshot. | Is the current form different from season-long output? |
| Clutch | Final five minutes of the fourth quarter or overtime, margin five or fewer at possession start; missing period, clock, or score remains `clutch:unclassified`. | What is the trusted late-game lineup and style? |
| Transition | Provider fast-break qualifier, no provider fast-break qualifier, or unclassified. | How does the unit perform in confirmed fast break? |
| Score state | Tied or leading/trailing bands. | Is the unit effective while chasing, protecting, or trading score? |
| Competition proxy | Conservative garbage-time versus competitive context. | Does the headline number depend on low-leverage minutes? |
| Leverage proxy | High, medium, standard, low, or unclassified score-clock bucket. | Which units have been tested when possessions matter most? |

The non-provider-fastbreak split is an absence-of-qualifier proxy. It may be useful for narrowing film, but it must never be relabeled as verified half-court offense.

## Player production and rotation role cards

The direct player profile joins structured event totals to reconstructed on-court exposure for rostered players with a same-game on/off row. Profile-level coverage reports unresolved shot outcomes, shot values, free-throw outcomes, and rebound types. Any percentage or rate that depends on an unresolved provider field is left unavailable instead of treating an unknown shot as a miss or an unknown shot value as a two-pointer.

- **Box-score line:** points, FGA/FGM, 2PA/2PM, 3PA/3PM, FTA/FTM, offensive/defensive/total rebounds, assists, steals, blocks, turnovers, personal fouls, fouls drawn, attempts blocked, technical/flagrant fouls, and ejections.
- **Shooting line:** FG%, 2P%, 3P%, FT%, eFG%, TS%, 3PA rate, blocked-attempt rate, average observed FG distance, structured two-point zones, and provider shot-type/description profiles such as jump shots, layups, dunks, hooks, pull-ups, drives, step-backs, cuts, floaters, putbacks, and fadeaways.
- **Rate line:** per-36 and per-100-possession points, rebounds, assists, steals, blocks, turnovers, foul indicators, attempts blocked, and a possession-ending involvement proxy.
- **Role line:** games appeared, reconstructed minutes, team possessions while on court, starter games/rate, and closer games/rate.

Use player cards to construct development plans: a low-rim-frequency, low-foul-drawn scorer may need rim-pressure work; a high-assist but high-turnover player may need decision-quality film; a strong defensive RAPM player with a modest box score may warrant matchup-focused film study instead of a purely scoring-centric evaluation.

## Recommended future tool patterns

### Rotation planner

1. Filter to an eligible phase and a meaningful minimum possession threshold.
2. Rank exact five-man groups by projected and observed net rating, with reliability visible.
3. Compare continuity, starter/closer usage, and the player availability/role assumptions.
4. Stress-test against clutch, venue, period, and opponent-context views.
5. Produce proposed 48-minute rotations as hypotheses, then review game film and coach constraints.

### Opponent scout

1. Start with team-level last-10 and last-20 windows versus season-wide output.
2. Review eFG%, 3PA rate, free-throw rate, turnover rate, offensive rebound rate, and possession outcomes.
3. Split by periods, clutch, score state, confirmed fast break, and venue.
4. Identify their most-used starting and closing exact lineups.
5. Use pair/trio co-presence and player cards to frame matchup questions for film.

### Player development and recruitment board

1. Start with direct player production and rate stats.
2. Add on/off and RAPM only with reliability/exposure displayed.
3. Compare role usage: starter, closer, minutes, lineup partners, and opponent context.
4. Turn outliers into qualitative review prompts rather than automated evaluations.
5. Keep a separate scout-note layer for video, medical, contract, and character information; those are not in this package.

### Future product architecture

- Query one team shard at a time. The JSON and gzip team shards are designed to avoid loading the entire season into a browser.
- Keep raw archive and derived package separate. Raw play-by-play is provenance; compact derived outputs are product inputs.
- Store source version, reconstruction version, metrics version, filters, and generated timestamp with every downstream snapshot.
- Use stable provider team/player IDs internally. Resolve display names at the presentation layer.
- Preserve null values and coverage fields. Never replace unavailable metrics with zero.
- Treat model estimates, proxies, and direct event facts as different data types in UI copy and color treatment.

## What this package does not provide

The archive does not provide verified defender matchups, screen/action labels, player or ball tracking, contest distance, expected shot quality, video clips, injuries, medical data, contracts, or a true win-probability model. Those features require separately licensed tracking, video, medical, or roster sources and a documented join strategy.

## Release and interpretation checklist

- Confirm the selected season, phase, and rolling-window cutoff.
- Confirm whether the row is an exact lineup, co-presence group, direct event stat, model estimate, or proxy.
- Show possessions, minutes, games, and reliability before ranking.
- Preserve the documented source caveat in all dashboards and exports.
- Use player and lineup outputs to prioritize coaching questions, film review, and controlled experiments.
- Do not make medical, contractual, or character conclusions from basketball play-by-play analytics.
