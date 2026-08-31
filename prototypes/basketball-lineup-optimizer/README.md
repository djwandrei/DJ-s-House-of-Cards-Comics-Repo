# DJ's Lineup Lab prototype

This folder is the canonical source for the public Lineup Lab beta. Its
deployable release is generated into `lineup-lab/`. The homepage and eligible
NBA product panels link to the tool, while it intentionally remains outside
the primary navigation, sitemap, service-worker shell, and search index during
the beta.

## What the prototype proves

- Exact five-player lineup and 8-12-player rotation search for normal NBA team
  roster sizes.
- Balanced, defense, offense, shooting, and playmaking presets with custom
  metric weights.
- Locked and excluded players, sample-size filters, position assignments,
  optional production floors, and a turnover ceiling.
- Top alternatives, score contributions, constraint checks, and an optional
  240-minute rotation plan.
- Per-36 rotation ranking with evidence-gated small-sample and larger-role
  projections. Extra assigned minutes beyond a player's established role are
  valued at the same-season baseline, preventing a low-usage spike from being
  repeated as if it were already star-sized production.
- Game-plan-first minute allocation by default, with an optional
  recorded-minutes guardrail and auditable guard, forward, and center
  role-minute profiles.
- CSV import/export, side-by-side player comparison, and a device-local player
  watchlist.
- A source-neutral player schema and provider adapter that keep the optimizer
  independent from the live-data service.
- Imported Basketball Reference team-season player pools from 1980 forward,
  with team-stint totals normalized to per-game values and a 24-hour device
  cache.
- Verified Basketball Reference player-profile positions as extra lineup
  eligibility (for example, a documented PF-C can cover either role). The
  selected season's listed position remains the historical role reference.
- Historical team identities, such as the San Diego Clippers and New Jersey
  Nets, rather than retroactively mapped current franchises.
- Uncapped exact rotation enumeration in a background Worker. Every eligible
  candidate group is checked, even when the pool is broader than a normal NBA
  team roster; changing the scenario cancels the active Worker cleanly.
- A separate candidate-count safeguard remains for five-player lineup mode.

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
positional assignment, uncapped rotation enumeration, the separate lineup-mode
search safeguard, infeasible scenarios, alternative ordering, 240-minute
allocation, optional recorded-minutes guardrails, small-sample and role-expansion
rate projections, custom role-minute proofs, and the legacy local-server
safeguards.

## Rotation model contract

The rotation solver separates selection, minute allocation, and descriptive
production so their units do not get mixed:

- Counting-stat profiles and turnovers are compared per 36 source minutes by
  default. Shooting percentages remain rates. `perGame` is an explicit legacy
  comparison mode.
- When same-season evidence exists, `sampleAdjusted` first blends each observed
  rate toward the imported league baseline before percentile ranking:
  `baseline + n / (n + k) * (observed - baseline)`. The sample `n` uses
  standardized per-appearance opportunity over 50 appearances so a trade or
  short team stint cannot reduce a player's projection. True season-wide totals
  take precedence when available. Metric-specific conservative priors are 750
  minutes for points, 500 for rebounds, 700 for assists and ball security, 900
  for steals and blocks, 500 field-goal attempts for eFG%, 180 three-point
  attempts for 3P%, and 1,200 minutes for OBPM/DBPM. These are transparent model
  settings, not fitted player-impact coefficients.
- The distinct larger-role projection removes only unproven upside beyond an
  established role and never improves a below-baseline player. A shared
  workload-saturation curve begins after `240 / selected roster size` minutes:
  extra minutes still add positive value, but their marginal fit moves smoothly
  toward 35% over an eight-minute transition. This prevents an otherwise linear
  objective from placing most players at their minimum or maximum. It is not a
  historical-minute target, availability rule, or hard cap; a sufficiently
  better player can still reach the visitor's maximum.
- Metric weights are normalized into relative shares. Each candidate's fit is
  the weighted, eligible-pool percentile profile, and rotation fit is then
  weighted by the exact minutes assigned to each selected player.
- The default game-plan plan uses only the visitor's hard player bounds and
  objective. `historicalAware` is an explicit optional recorded-minutes
  guardrail that rescales the selected players' team-stint minute
  shares to 240 and builds visible per-player bands around those targets. It
  never contributes a second roster-ranking score.
- Every successful rotation assigns exactly 240 integer player-minutes and the
  selected role profile's exact G/F/C totals. Custom role totals are used in
  both the allocation and every projected-stat feasibility proof.
- Rotation candidate count never changes the model or causes a fallback. The
  outer exact enumeration has no count or elapsed-time cutoff and remains in a
  background Worker. Optional production thresholds retain a per-candidate
  state guard only for a single unusually difficult proof; that guard cannot be
  consumed merely because the outer search contains more candidate rotations.
- Optional production thresholds preserve the same diminishing-return minute
  objective used by an ordinary rotation. Their feasibility test deliberately
  uses conservative static common-role rates so each hard rule remains a linear,
  auditable inequality; enabling a floor never restores the retired linear
  minute-fill behavior.
- When the exact assigned-role model is available, projected box-score totals
  use the evidence-based role-expansion projection: established minutes use the
  adjusted player rate, while additional expansion minutes move smoothly toward
  the same-season bound. Workload saturation affects allocation utility and the
  search-relative score only; it does not arbitrarily erase projected points or
  change the meaning of 100 in the Plan Fit Index. Otherwise totals retain the
  static conservative rate used by the exact threshold solver. They are
  descriptive estimates, not game, injury, availability, matchup, or betting
  predictions.

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

### Position eligibility

The position constraint has two deliberately separate inputs:

- **Season-listed role** is the `Pos` value supplied with the selected player
  team-season. Lineup Lab uses it to describe the historical rotation and to
  estimate the team's guard/forward/center minute mix.
- **Verified career eligibility** comes only from the player's Basketball
  Reference profile. It lets the exact solver use documented alternate roles
  when satisfying a lineup or rotation constraint. It never treats career
  flexibility as evidence that a player split every season's minutes evenly
  across those roles.

`scripts/import-nba-basketball-reference-positions.mjs` is the guarded,
checkpointed backfill for this evidence. It queries only imported Basketball
Reference player IDs, rechecks robots.txt, keeps the same four-second minimum
source cadence, caches successful profile pages, and records a terminal or
retry status in `nba_player_position_profiles`. A stopped pass therefore
continues with its unfinished profiles on the next run instead of starting
over. The normal pass never guesses from height, box-score statistics, or a
player's name.

Both the profile backfill and the season-stat importer are hard-bound to the
dedicated NBA analytics project. Before a local write, link that exact project
from its separate migration directory; the repository root's Supabase link is
the commerce project and is intentionally rejected for these imports:

```powershell
supabase link --workdir .\supabase-analytics --project-ref fbbmuqbdpgsmvnezowwn
```

After source permission is reconfirmed, a bounded local apply pass is:

```powershell
$env:BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED = 'confirmed'
$env:NBA_WEEKLY_UPDATE_ALLOW_WRITE = 'confirmed'
node .\scripts\import-nba-basketball-reference-positions.mjs --apply --limit 100
Remove-Item Env:\BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED
Remove-Item Env:\NBA_WEEKLY_UPDATE_ALLOW_WRITE
```

`.github/workflows/nba-position-profile-backfill.yml` repeats a bounded,
resumable pass daily after the default branch is published. It uses the same
reviewed secrets and source gates as the weekly stats updater; once coverage
catches up, the pending query returns no candidates until newly imported
players appear.

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

An approved Supabase refresh requires the dedicated analytics-project link
above plus a second write gate. The wrapper supplies the importer's explicit
analytics-target guard automatically:

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
the source or write Supabase until the four documented repository secrets are
configured. Before publishing it on the default branch, review the cron time.
Required secrets are
`BASKETBALL_REFERENCE_AUTOMATION_CONFIRMED=confirmed`,
`NBA_WEEKLY_UPDATE_ALLOW_WRITE=confirmed`, `SUPABASE_ACCESS_TOKEN`,
and `NBA_ANALYTICS_SUPABASE_DB_PASSWORD` (four values total). The workflows
check in the public analytics project reference so a generic commerce-project
secret cannot redirect a Lineup Lab data import.

## Production promotion checklist

Run `node .\scripts\build-lineup-lab-release.mjs` before every deployment, then
verify it with `--check`. The builder owns the deployable cache token and fails
if source files bypass its version placeholder. Keep broader navigation,
sitemap, structured data, and search discovery approval-gated while the page is
labelled public beta.
