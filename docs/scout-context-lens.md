# Scout Studio context lens

September 7, 2026. Local implementation only; this is not a production release.

The context lens is the next evidence layer for Player Blueprint and Chemistry
Lab. It reads the already-derived `playerOnOff` and combination context maps
from one validated team shard and presents only bounded, descriptive rows.

## What it shows

- Player Blueprint can lazily load on-court and same-game off-court rows for the
  selected player.
- Chemistry Lab can open season, phase, venue, period, half, rolling-window,
  score-state, competition, transition, leverage and clutch-proxy rows for an
  observed shared-floor group.
- Each row keeps its own games, offensive/defensive possessions, ratings,
  net rating, sample status and optional reliability grade. An all-sample row
  is the only comparison baseline.
- Player rows show on minus off differences only when both sides pass the same
  published observation gate. Group rows show net versus all only when the
  baseline is observed.

The current package's direct player profile remains a pooled team-window
profile. A `season:2022` or `season:2025` context row is a possession partition,
not a season-keyed direct player profile and not evidence of year-over-year
skill change.

## Contract and safety

`tools/scout-studio/context-contract.js` is shared by the Node source adapter
and the browser analysis module so their allowlists cannot drift. Unknown
context keys, duplicate rows, invalid scopes, unsupported samples and oversized
requests fail closed. The source adapter reconciles one `playerOnOff` row for
every player profile before caching a team.

The read-only `/api/scout-studio/player-contexts` route accepts only opaque team,
snapshot and player handles. It never returns provider IDs, fitted coefficients,
RAPM, archive paths, raw nested metrics or source notes. The browser requests
rows on demand and keeps no persistent copy; only Composite Forge donor handles
remain eligible for local draft storage.

These are descriptive same-game partitions. Teammate mix, opponents, roles,
venue, schedule and other unmeasured conditions can differ between rows. The
display does not infer a causal player effect, chemistry score, forecast,
workload target or tactical assignment. Missing and below-gate rows remain
unavailable rather than being imputed.

## Verification

The context contract is covered by `scripts/tests/scout-context-lens.test.mjs`,
the streamed source/route tests, and the synthetic browser smoke at 1440px and
390px. The real-package checker passed against the completed six-season base
package with its exact hash-bound source report: 67 New York profiles, 41 context
rows and rendered player/group tables at both viewport sizes. The season
allowlist now explicitly covers start years 2020–2025; Game Lab separately
limits game samples to 2023–2025. No Supabase, catalog, deployment or model-fit
state changes are part of this slice.
