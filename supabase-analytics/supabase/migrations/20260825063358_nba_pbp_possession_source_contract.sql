-- Preserve the provenance of a strict period-opening reconstruction.
--
-- The base PBP migration initially allowed only provider state and a staging
-- inference. The reconstruction can also publish a fully validated first made
-- field goal after a period boundary when no prior possession state exists.
-- Keep that distinct rather than rewriting it as provider state.

alter table public.nba_game_possessions
  drop constraint if exists nba_game_possessions_possession_source_check;

alter table public.nba_game_possessions
  add constraint nba_game_possessions_possession_source_check
  check (possession_source in (
    'provider_post_event_state',
    'inferred_staging_only',
    'inferred_period_opening_made_field_goal'
  ));

comment on column public.nba_game_possessions.possession_source is
  'Provider-state provenance, or a narrowly validated reconstruction inference. Period-opening made-field-goal inference is never represented as provider state.';

comment on column public.nba_pbp_import_runs.requested_season_start is
  'First requested NBA season ending year; the provider CLI accepts start years but this domain keys seasons by end year.';

comment on column public.nba_pbp_import_runs.requested_season_end is
  'Last requested NBA season ending year; the provider CLI accepts start years but this domain keys seasons by end year.';
