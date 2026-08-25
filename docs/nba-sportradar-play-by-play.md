# NBA play-by-play and lineup analytics

This pipeline uses the licensed Sportradar NBA v8 feed, not Basketball
Reference, for game events and on-court lineups. It is deliberately separate
from the Basketball-Reference player-season importer.

## What is stored

Raw Sportradar Schedule, Game Summary, and Play-by-Play responses are gzipped
into the private `nba-sportradar-raw` Supabase Storage bucket. SQL retains the
response hash, revision headers, retrieval time, and object path for audit.
Raw provider documents, events, on-court snapshots, and unresolved identity
mappings have no anonymous or authenticated read policy.

Only derived, completed, five-on-five-verified analytics are available through
these RPCs:

- `get_nba_lineup_analytics(...)` for a one-to-five-player selection
- `get_nba_lineup_analytics_players(...)` to enumerate verified provider IDs

Five selected players means an exact five-player lineup. Two through four
players means a shared-floor combination: every eligible stint in which those
players appeared together, regardless of the other teammate(s). One player
returns direct on/off partitions; two players also return the four WOWY cells.

## Definitions

| Metric | Definition |
| --- | --- |
| Offensive / defensive rating | `100 * points / offensive or defensive possessions` from reconstructed provider possession transitions. |
| On/off | Direct partitions of eligible team stints, never arithmetic subtraction from an incomplete game. |
| WOWY | `A on/B on`, `A on/B off`, `A off/B on`, `A off/B off` shared-floor cells. It is descriptive, not causal. |
| Clutch v1 | Fourth quarter or overtime, at most 5:00 remaining, and pre-event margin of at most five points. |
| Score state v1 | Team-relative, pre-possession `tied`, `ahead_*`, or `trailing_*` bands. |
| Fast break | `provider_fastbreak_v1` if a provider event in the possession has the `fastbreak` qualifier. |
| Non-fast-break | `non_provider_fastbreak`, explicitly not a claim that the possession was verified half court. |
| RAPM | League-wide, season-scoped, possession-weighted ridge model using both teammates and opponents in paired five-on-five stints. It is reproducible and versioned, not provider-supplied or causal. |

Contextual clutch, score-state, and fast-break results are possession-scoped.
Their `seconds` and `minutes` fields are deliberately `null`: the pipeline does
not invent a time allocation for a subset of possessions within a stint.

Standard NBA v8 play-by-play does not label every possession as half court or
transition. If the account includes the separately entitled Synergy product,
its postgame play-type feed can be added as a distinct, provenance-labelled
enrichment; it must not be silently inferred from the complement of fast-break
events.

## Eligibility and revisions

The importer publishes a game only after all of the following hold:

```text
game status = closed
coverage = full
track_on_court = true
all score-bearing and possession-defining events have valid five-on-five snapshots
administrative period-end markers may omit snapshots, but lineup state resets at every period boundary
derived final score reconciles with the provider final score
```

The Summary response is a validation source for final scores, minutes,
plus/minus, estimated possessions, and team ratings. Summary possessions are a
decimal box-score estimate, so they are retained as a non-gating QA comparison
rather than exact-matched to reconstructed Play-by-Play possession rows. It is
not used as an exact-lineup source. A later Play-by-Play revision replaces that game's derived build
atomically; public RPCs select only the newest eligible completed build.

Sportradar's possession field is post-event state and can be absent on free
throws. The reconstruction uses structured regular-attempt metadata to advance
state after a made final free throw. It also merges an and-one state reversal
only when the made field goal, same-clock shooting foul, `1 of 1` regular free
throw, player/team identities, and the opponent's next offensive action all
reconcile. Unsupported lookalikes remain private and ineligible.

When a period begins without a provider possession state, a first made field
goal may be reconstructed only under the pipeline's strict structural checks.
Its persisted provenance is `inferred_period_opening_made_field_goal`, never
silently rewritten as provider state.

## Install the schema

Apply the PBP/RAPM migrations in the isolated `supabase-analytics-pbp` track
after the NBA base-copy transition is verified. This is a production database
change, so review the migration diff and use the project team's normal release
procedure:

```powershell
supabase db push --workdir .\supabase-analytics-pbp --project-ref <analytics-project-ref>
```

Do not run a root-level `supabase db push` for this pipeline: that directory is
linked to the commerce project and must never receive raw PBP, lineup-stint, or
RAPM tables. The PBP track is also separate from `supabase-analytics` so a
base-data copy can be rerun without applying PBP migrations.

For the split analytics deployment, do this only from the isolated analytics
project migration context, after its NBA base dimensions have been copied. Do
not run a root-level migration push against the commerce project.

The migrations create the private raw-response bucket and tables, the private
atomic ingest/RAPM functions, and the three derived read RPCs. They do not
download data or expose a Sportradar credential.

## Configure and run

Do not commit these values or put them in browser JavaScript. Set them only in
the environment that runs the local importer:

```powershell
$env:SPORTRADAR_NBA_LICENSE_CONFIRMED = 'confirmed'
$env:SPORTRADAR_NBA_LICENSE_REFERENCE = 'your internal license or approval reference'
$env:SPORTRADAR_NBA_API_KEY = '...'
$env:SPORTRADAR_NBA_ACCESS_LEVEL = 'production' # or trial, if entitled

# Required only for --apply, so private source responses can enter Storage.
$env:NBA_SPORTRADAR_IMPORT_ALLOW_WRITE = 'confirmed'
$env:SUPABASE_URL = 'https://your-project.supabase.co'
$env:NBA_ANALYTICS_SUPABASE_URL = 'https://your-analytics-project.supabase.co' # must exactly match SUPABASE_URL
$env:SUPABASE_SERVICE_ROLE_KEY = '...'
```

First make a small read-only provider dry run:

```powershell
node .\scripts\import-nba-sportradar-pbp.mjs --season-start 2024 --season-end 2024 --phase regular --max-games 1
```

Inspect the JSON report. Then make the same small run with `--apply` before a
historical backfill. The importer applies a global request delay, obeys 429
retries, and accepts a game/season/phase limit so an account's actual quota can
be respected.

After the target project migration, confirm the base copy before PBP imports:

```powershell
node .\scripts\check-nba-analytics-target.mjs --scope base
```

After the PBP/RAPM migrations are installed, the following adds private table,
bucket, and RPC checks. It remains read-only:

```powershell
node .\scripts\check-nba-analytics-target.mjs --scope pbp --season-end 2025
```

Fit a model only after eligible league-wide stints are present:

```powershell
node .\scripts\derive-nba-rapm.mjs --season-end 2025 --phase regular --lambda 100
```

Its default is dry-run. `--apply` requires
`NBA_RAPM_DERIVE_ALLOW_WRITE=confirmed` plus the same server-side Supabase
credentials. Every RAPM run, including a dry run, also requires
`NBA_ANALYTICS_SUPABASE_URL` to exactly match `SUPABASE_URL`; this prevents a
stale terminal environment from targeting the commerce project.

## Provider references

- [NBA API basics](https://developer.sportradar.com/basketball/docs/nba-ig-api-basics)
- [NBA Game Play-by-Play](https://developer.sportradar.com/basketball/reference/nba-play-by-play)
- [NBA Game Summary](https://developer.sportradar.com/basketball/reference/nba-game-summary)
- [NBA game status workflow](https://developer.sportradar.com/basketball/docs/nba-ig-game-status-workflow)
- [NBA daily change log](https://developer.sportradar.com/basketball/docs/nba-ig-daily-change-log)
- [Authentication](https://developer.sportradar.com/getting-started/docs/authentication)
