# Private NBA Scout archive query index

This layer makes a validated local NBA Scout package queryable without making
the archive, raw play-by-play, or any analytics endpoint public.

The full derived package remains the immutable source record in the private
`nba-scout-analytics-archive` Storage bucket. The query index contains only
compact, allowlisted summaries needed for private service-to-service queries.
It never imports uncompressed team JSON, raw provider payloads, archive object
paths, or full nested lineup/WOWY context trees.

If a package was produced by the separate boundary-role repair utility, its
small repair-provenance report is retained with the private archive. A directly
derived package is valid without that optional repair-only artifact.

## Boundary and target

- Use only `supabase-analytics/` and its dedicated linked project
  `fbbmuqbdpgsmvnezowwn`.
- Never run this migration or importer against root `supabase/`, commerce
  Supabase, cPanel, or a browser client.
- Provider team/player UUIDs are deliberately self-contained within a snapshot.
  The index does not depend on the separate PBP identity tables being present,
  so an immutable archive can be imported independently of raw-PBP retention.
- Tables have RLS and revoke all direct table privileges from browser roles and
  `service_role`. The only supported access path is the private RPC surface.

## Snapshot semantics

Each import is immutable and identified by its manifest SHA-256 plus its private
Storage bucket/prefix. Every compact shard and the two RAPM models have a
canonical payload hash. A retry can resume an identical staging import; a
different payload, archive prefix, or metadata collision fails closed.

The current validated 2025–26 package produces:

| Summary | Rows |
| --- | ---: |
| Teams | 30 |
| Lineup/co-presence summaries | 72,249 |
| Player on/off summaries | 656 |
| Player profiles | 656 |
| WOWY pairs | 5,889 |
| RAPM player-model rows | 1,158 |
| Team context summaries | 1,073 |
| Player on/off context summaries | 42,507 |

Five-player rows are exact possession-start lineups. Two-to-four-player rows
are shared-floor co-presence, not exact lineups. Lineup and WOWY queries retain
only the validated `all` context; team and player on/off queries retain all
validated source contexts. `transition:non_provider_fastbreak` remains a
non-provider proxy and must not be relabeled as verified half-court data.

The compact lineup projection retains its model label, player count, RAPM sum,
observed context, raw and prior-shrunk synergy, projected rating, and compact
reliability/caveat fields. It deliberately omits raw possession contexts,
archive paths, and nested calculation diagnostics. A non-publishable projection
may be stored for provenance, but it must not become an exact-five model bonus.

Newly derived offense/defense RAPM metadata also retains a compact held-out
calibration summary: venue-baseline error, full-model error, offense/defense
ablation comparisons, fold coverage, and the status gate. It omits per-game
predictions, player lineups, raw PBP, and fold identities. A legacy archive may
be imported for private provenance, but a Scout optimizer must not use its O/D
player effects until the private RPC's `model.calibration` is `validated` and
reports that both components passed the held-out check.

## Deploy and import

First apply the dedicated analytics migration after authenticating the Supabase
CLI for the dedicated project:

```powershell
pnpm dlx supabase db push --workdir .\supabase-analytics --project-ref fbbmuqbdpgsmvnezowwn --include-all
```

Run an offline validation/import plan before any remote call:

```powershell
node --expose-gc .\scripts\import-local-scout-analytics.mjs `
  --archive .\outputs\<task-id>\nba-last-five-seasons\scout-analytics\<validated-package>
```

Verify the existing immutable private archive before writing query tables:

```powershell
$env:SUPABASE_URL = 'https://<dedicated-analytics-project>.supabase.co'
$env:NBA_ANALYTICS_SUPABASE_URL = $env:SUPABASE_URL
$env:SUPABASE_SERVICE_ROLE_KEY = '<process-scoped-service-role-key>'

node --expose-gc .\scripts\import-local-scout-analytics.mjs `
  --archive .\outputs\<task-id>\nba-last-five-seasons\scout-analytics\<validated-package> `
  --verify-remote
```

Only after the migration and remote verification both pass, apply the private
query import:

```powershell
$env:NBA_SCOUT_QUERY_IMPORT_ALLOW_WRITE = 'confirmed'

node --expose-gc .\scripts\import-local-scout-analytics.mjs `
  --archive .\outputs\<task-id>\nba-last-five-seasons\scout-analytics\<validated-package> `
  --verify-remote --apply
```

Do not place these values in a committed `.env` file. The importer requires
`SUPABASE_URL` to exactly equal `NBA_ANALYTICS_SUPABASE_URL`, so a stale
commerce environment is rejected before any remote operation.

The importer registers each immutable team artifact once, then writes its
already-sanitized compact sections in sub-megabyte batches. Gateway failures
such as HTTP 520 are retried with backoff; rerunning the same guarded command
also resumes the staging import without duplicating rows. Finalization refuses
to mark an archive ready unless every team and every expected compact row count
matches the validated manifest.

## Private RPC surface

All functions below are granted only to `service_role`:

- `get_nba_scout_archive_overview(season_end_year)`
- `get_nba_scout_team_context_analytics(season_end_year, team_id, context_key)`
- `get_nba_scout_lineup_analytics(season_end_year, team_id, player_ids)`
- `get_nba_scout_player_analytics(season_end_year, team_id, player_id, context_key)`
- `get_nba_scout_wowy(season_end_year, team_id, player_a_id, player_b_id)`
- `get_nba_scout_rapm(season_end_year, model_kind, player_id, limit)`

Each result includes the manifest/provenance descriptor. The RPCs never return
Storage paths, raw PBP, or unrestricted nested archive data. A future public
derived-read wrapper would require a separate scope, privacy review, and an
explicitly bounded data contract; it is not part of this importer.

## cPanel and GitHub

This feature has no shopper-facing static artifact. Nothing from the private
archive or query layer is eligible for cPanel deployment. GitHub receives only
the migration, importer, tests, and this documentation; it does not receive the
archive or credentials.
