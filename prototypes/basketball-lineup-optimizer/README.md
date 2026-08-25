# DJ's Lineup Lab prototype

This folder is the source for an unlinked Lineup Lab private beta. Its
deployable release is generated into `lineup-lab/`, which remains outside the
storefront navigation, sitemap, service worker shell, and search discovery.

## What the prototype proves

- Exact five-player lineup and 8-12-player rotation search for normal NBA team
  roster sizes.
- Balanced, defense, offense, shooting, and playmaking presets with custom
  metric weights.
- Locked and excluded players, sample-size filters, position assignments,
  optional production floors, and a turnover ceiling.
- Top alternatives, score contributions, constraint checks, and an optional
  240-minute rotation plan.
- Per-36 rotation ranking with an optional, evidence-gated small-sample
  stability adjustment.
- Historical-aware or open what-if minute plans, plus auditable guard, forward,
  and center role-minute profiles.
- CSV import/export, side-by-side player comparison, and a device-local player
  watchlist.
- A source-neutral player schema and provider adapter that keep the optimizer
  independent from the live-data service.
- Imported Basketball Reference team-season player pools from 1980 forward,
  with team-stint totals normalized to per-game values and a 24-hour device
  cache.
- Historical team identities, such as the San Diego Clippers and New Jersey
  Nets, rather than retroactively mapped current franchises.
- A safe exact-search cap that asks visitors to narrow large rotation pools
  before synchronous browser work could freeze the page.

## Run locally

The page uses ES modules and the storefront's shared Supabase browser adapter,
so use the included dependency-free local server rather than opening the HTML
file directly.

```powershell
node .\prototypes\basketball-lineup-optimizer\dev-server.mjs
```

Then open:

`http://127.0.0.1:4173/prototypes/basketball-lineup-optimizer/`

## Tests

```powershell
node --test .\prototypes\basketball-lineup-optimizer\tests\*.test.mjs
```

The tests cover data normalization and CSV compatibility, the Supabase
Basketball Reference adapter, deterministic optimization, locks/exclusions,
positional assignment, safe search limits, infeasible scenarios, alternative
ordering, 240-minute allocation, historical workload guardrails, sample-rate
stability, custom role-minute proofs, and the legacy local-server safeguards.

## Rotation model contract

The rotation solver separates selection, minute allocation, and descriptive
production so their units do not get mixed:

- Counting-stat profiles and turnovers are compared per 36 source minutes by
  default. Shooting percentages remain rates. `perGame` is an explicit legacy
  comparison mode.
- When same-season evidence exists, `sampleAdjusted` blends each observed rate
  toward the imported league baseline before percentile ranking:
  `baseline + n / (n + k) * (observed - baseline)`. The evidence sample `n` is
  total minutes for counting stats and turnovers, field-goal attempts for
  eFG%, and three-point attempts for 3P%. The current conservative guardrail
  constants are `k=600`, `k=500`, and `k=180`, respectively. These constants
  are transparent model settings, not fitted player-impact coefficients.
- Metric weights are normalized into relative shares. Each candidate's fit is
  the weighted, eligible-pool percentile profile, and rotation fit is then
  weighted by the exact minutes assigned to each selected player.
- `historicalAware` rescales the selected players' recorded team-stint minute
  shares to 240 and builds visible per-player bands around those targets.
  `openWhatIf` deliberately removes that workload prior and uses only the hard
  player bounds.
- Every successful rotation assigns exactly 240 integer player-minutes and the
  selected role profile's exact G/F/C totals. Custom role totals are used in
  both the allocation and every projected-stat feasibility proof.
- Projected box-score totals always use each player's source per-minute rate
  multiplied by assigned minutes. They are descriptive estimates, not game,
  injury, availability, matchup, or betting predictions.

Imported play-by-play, reconstructed lineup stints, and RAPM are not inputs to
this box-score objective yet. The interface must continue to label observed
five-player impact as unavailable until a separately validated, adequately
sampled play-by-play layer is approved for model use.

## Data boundary

The default player pool comes from the approved Basketball Reference import in
Supabase. The browser reads one season, phase, and team at a time through the
read-only `nba_lineup_player_pool` view. This keeps a traded player scoped to
the selected team stint instead of blending in a multi-team aggregate. Counting
stats are converted to per-game values; shooting percentages and eFG% are
derived from makes and attempts. A team-season response is not a current
roster, depth chart, or injury report.

The checked-in fixture remains the 15-player 2021-22 Timberwolves snapshot from
the original course workbook. It is the stable test/demo fallback if the
historical database cannot be reached. The browser also keeps a matching
team-season snapshot for 24 hours and can use an older saved snapshot during an
interruption.

Do not add a browser-side Basketball Reference scraper. The Lineup Lab only
uses the confirmed, server-side import and its browser-safe Supabase reads.
Confirmed player headshots and team logos are optional external media URLs; the
interface hides them if they are unavailable.

## Weekly current-season updater

`scripts/update-nba-basketball-reference-weekly.mjs` is the guarded operator
entry point for ongoing stats maintenance. It resolves the active NBA season
at the October boundary, refreshes only that one season, and requests regular
and postseason totals/advanced tables. It may skip an unavailable current-season
postseason table only before April; after that date, a missing or unparsable
postseason table fails the run for review. The underlying importer performs idempotent upserts keyed by
player, season, team stint, and phase. It does not delete older rows or fetch
player/team media. Each weekly execution starts a new import run so a partial
checkpoint from an earlier attempt cannot suppress a fresh phase download.

The wrapper is dry-run by default and fails closed unless the source automation
confirmation remains valid:

```powershell
$env:BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED = 'confirmed'
node .\scripts\update-nba-basketball-reference-weekly.mjs
Remove-Item Env:\BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED
```

An approved Supabase refresh requires the existing linked Supabase CLI plus a
second write gate:

```powershell
$env:BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED = 'confirmed'
$env:NBA_WEEKLY_UPDATE_ALLOW_WRITE = 'confirmed'
node .\scripts\update-nba-basketball-reference-weekly.mjs --apply
Remove-Item Env:\BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED
Remove-Item Env:\NBA_WEEKLY_UPDATE_ALLOW_WRITE
```

Each run re-reads `https://www.basketball-reference.com/robots.txt`, fails if a
required season page is disallowed, keeps at least the declared crawl delay,
uses a four-second default cadence (15 requests/minute), retries temporary
failures at most three times with exponential/`Retry-After` backoff, and writes
an ignored JSON report to `outputs/nba-weekly-update/report.json`.

The source-policy review for this tool used the official Sports Reference
pages below. Recheck them before enabling the schedule or if the confirmed
permission changes:

- `https://www.sports-reference.com/data_use.html`
- `https://www.sports-reference.com/termsofuse.html`
- `https://www.sports-reference.com/bot-traffic.html`
- `https://www.basketball-reference.com/robots.txt`

`.github/workflows/nba-weekly-update.yml` contains a Tuesday schedule plus a
manual dry-run/apply control. It remains inert outside GitHub and cannot access
the source or write Supabase until the five documented repository secrets are
configured. Before publishing it on the default branch, review the cron time.
Required secrets are
`BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED=confirmed`,
`NBA_WEEKLY_UPDATE_ALLOW_WRITE=confirmed`, `SUPABASE_ACCESS_TOKEN`,
`SUPABASE_PROJECT_REF`, and `SUPABASE_DB_PASSWORD` (five values total).

## Production promotion checklist

Run `node .\scripts\build-lineup-lab-release.mjs` before a private-beta
deployment, then verify it with `--check`. Keep it unlinked until a fan-tools
hub, navigation, sitemap, structured data, and broader discovery are explicitly
approved.
