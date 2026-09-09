# Scout Game and Season Labs

September 7, 2026. Implemented locally in Scout Studio; not a public release.
This advances item 4 (game/series simulation) from the user's latest attachment
and provides an initial team-matchup experiment for item 12. Season Lab adds a
custom mini-league, not an authentic NBA season forecast. Career prediction and
learned matchup analytics remain separate, unimplemented models.

## Playable loop

1. Choose two different franchises and a season from 2023–24 through 2025–26,
   or use today's reproducible matchup. The date uses America/Chicago.
2. Optionally call the winner of the first seeded draw. No leaderboard or
   competitive score is attached to this editable experiment.
3. Run one game or a best-of-seven series, alongside repeated experiments.
   Inspect the first draw, cumulative quarter scores, win frequencies, score
   quantiles, margin histogram and completed-series lengths.
4. Change pace or the offense/defense blend and rerun. The previous-run panel
   compares expected margin and simulated win frequency for the same matchup.
   Changed settings or picks clear stale results; a run can be cancelled.

The source includes all 30 franchises. Missing or below-gate team-season data
stays unavailable; this slice spot-checks two teams, not all 90 team/seasons.
Daily setup is stable for a date, snapshot and experiment version. The model
version, seed and snapshot are visible in the evidence panel. Reproduction also
requires the same settings and versioned implementation.

## Experiment contract

`scout-possession-scenario-v1` uses recorded Scout team-season possessions:

- Require observed sample gates and at least 200 verified offensive and 200
  defensive possessions for each team. Both teams must share one exact snapshot.
- Independently reconcile outcome counts (0, 1, 2, 3, 4+ points), possession
  totals and points scored/allowed. Recomputed mean points per 100 must match
  the published rating within its rounding tolerance.
- Scout stores a single 4+ bucket. Infer its observed mean from the recorded
  point total, then allocate its mass to the two neighboring integer scores.
  This preserves the mean, not the unknown shape or variance of that tail.
  Inconsistent counts or a tail mean outside 4–20 points are rejected.
- A's scoring distribution is `w * A offense + (1-w) * B defense`; B's is
  symmetric. Default `w=0.5` is an editable assumption, not a fitted parameter.
- Draw independent possessions with a deterministic seeded stream. Regulation
  pace is 60–140 possessions per team; repeated experiments are bounded at
  100–5,000. Fixed distributions are reused for each game in a series.
- Ties get at most six overtime periods, each using approximately 5/48 of the
  regulation possession count. An unresolved game stays unresolved and stops
  its series; no invented coin-flip winner or scored prediction is assigned.
- Yield every 100 experiments to keep the browser responsive and allow cancel.
- Show empirical 10th/50th/90th percentiles and Monte Carlo repetition error.
  The latter does not quantify uncertainty in an NBA forecast.

No opponent-strength adjustment, possession dependence, lineup substitutions,
home-court effect, injury, fatigue, coaching, travel or parameter uncertainty
is fitted. The engine does not consume private RAPM coefficients or sum player
effects into a made-up score. Real-game calibration, chronological holdouts,
interval coverage and forecast scoring are prerequisites for predictive claims.
Player-versus-defender assignments and an authentic NBA calendar are not modeled.

## Season Lab: composing the same experiment

The UI accepts four different franchises from one snapshot and a 2023–2025
season start year. One, two or four meetings per pair yield three, six or twelve
regular games per team. Users can omit playoffs, take the top two into a final,
or seed all four into semifinals. Best-of-one/three/seven UI choices reuse the
same scoring kernel; nothing adds a hidden playoff-strength adjustment.

The pure engine supports 2–30 teams with odd-team byes, one through four cycles,
50–500 season experiments and optional power-of-two brackets up to 16 teams.
The conservative upper-bound workload must not exceed 100,000 simulated games.
Pair schedules are deterministic and balance home/away across paired cycles;
each team appears no more than once per round. Home/away carry no scoring effect.

Custom table points are wins plus half an unresolved tie, then point differential,
then a disclosed seeded lottery for exact ties. These are not NBA tiebreakers.
Playoff slots follow standard seed pairing. An unresolved playoff match propagates
an unresolved slot instead of granting its next opponent a bye or a title.

The first example retains schedule scores, standings and bracket. Repeated
seasons retain only per-team wins, seed frequencies, qualification/title counts
and unresolved titles. The engine checks cancellation per game and yields every
50 games in the UI. Inputs are compiled before yielding, so later caller mutation
cannot change the scoring distributions in an active run.

Pin a compact completed result, change one assumption and compare. Exact teams,
season, snapshot and engine versions must match. Result counts reconcile before
pinning. Changes to schedule/playoff structure and seed/repetition are separately
disclosed. Different schedule lengths suppress raw-win deltas and show wins per
scheduled game instead. Omitting playoffs means title/qualification comparisons
are unavailable, not zero. Identical settings producing different results are
rejected; the same seed alone is not a paired inference or significance test.

## Data and memory boundary

The current read-only integration explicitly selects the completed six-season
`2020-26-final-20260907-v2-comprehensive-model-evidence` base package. The
earlier v1 directory was superseded and removed after v2 validation. Exact paths, hashes and
commands are in [the roadmap](scout-studio-roadmap.md). A wider package does not
broaden the game's three-season eligibility window. Player profiles elsewhere
in the workbench remain pooled team/window evidence.

`/api/scout-studio/team-contexts` projects allowlisted sample/outcome fields only.
No provider IDs, coefficients, raw nested source metrics, archive paths or
credentials are returned. The same localhost, origin, snapshot and validated
shard gates apply as the other preview routes.

The server streams and hashes one team shard at a time, releasing its previous
team cache before reading a replacement. Internal chemistry pairs omit unused
context arrays. Game Lab keeps at most four compact team-context responses in
browser memory; refreshing the source clears them. Repeated experiments reuse
those responses rather than rereading gigabyte shards. No Game Lab evidence or
results are persisted to localStorage. A cancelled client request may leave the
single bounded server read finishing in the background.
Season Lab has a separate four-response compact cache and one pinned aggregate
result. Neither simulation stores source evidence or results in localStorage.

## Verification

- 77 focused tests pass across presentation, analysis, style matches, contexts
  and the possession engine. The 12 simulator tests cover reconciliation,
  deterministic runs, analytic means, real zeros, tail handling, overtime,
  series totals, cancellation, scope/input limits and daily-season diversity.
- Synthetic browser checks pass at 1440px and 390px, including daily setup,
  winner calls, repeatability, four-panel navigation, compact-cache reuse,
  changed settings, series, cancellation, context tables and pending states.
- Real-package check: New York loaded 67 profiles and 41 player context rows;
  648 components were observed, 22 unavailable. Only 21 profiles were fully
  independently reconciled; the other 46 retain their coverage warning.
- New York and Minnesota team samples passed outcome/rating checks for 2023,
  2024 and 2025. A 1,000-series experiment conserved all result counts. The two
  initial shard reads and integration assertions took 31 seconds in one run.
- Real-package desktop/mobile checks passed for Blueprint, Chemistry, Forge
  and New York versus Minnesota in Game Lab. These are integration checks,
  not a 30-team audit or statistical predictive validation.
- Site integrity reports zero issues. Screenshots remain ignored local output
  under `outputs/scout-studio-smoke/`; they are not release assets.

### September 7 league/comparison expansion

- Eight additional engine tests cover schedules, standings, seed lotteries,
  bracket construction, deterministic conservation, missing samples/work limits
  and cancellation. Eight comparison tests cover compact references, exact
  deltas, structural/repetition changes, unavailable playoffs, scope invalidation,
  inconsistent repeat outcomes and malformed aggregate rejection.
- Synthetic mobile/desktop coverage includes four-team loading/cache reuse,
  duplicate preflight, schedule/bracket displays, pin/replace/clear comparison,
  season invalidation and cancellation.
- Real-package four-team check passed: New York, Minnesota, Denver and Houston;
  100 seasons, 1,947 simulated games, about 97 seconds including streamed source
  validation. Run the existing package-check command with `--league` to include
  this integration path. This is not forecast validation or a full-league audit.
- The extended real check also passed pinned Chemistry/Forge comparisons on
  New York's roster, identical league replay and a pace-only league change. The
  repeated integration took about 70 seconds with the same fixed baseline result.
- The combined current workbench and daily-game regression list is in
  `scripts/check-scout-games-workbenches.mjs`.

Public hosting still requires a reviewed private data bridge, display-rights
review, backend deployment and live verification. A cPanel static upload alone
cannot serve this local API. No Supabase, GitHub or cPanel write is part of this
implementation slice.
