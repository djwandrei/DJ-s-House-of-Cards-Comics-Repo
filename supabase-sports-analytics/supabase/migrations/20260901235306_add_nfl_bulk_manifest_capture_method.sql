-- Preserve accurate provenance when a private analytics URL manifest is
-- imported from an approved bulk data release rather than a source page.
alter table public.nfl_media_assets
  drop constraint if exists nfl_media_assets_capture_method_check;

alter table public.nfl_media_assets
  add constraint nfl_media_assets_capture_method_check
  check (capture_method in ('source_page', 'derived_template', 'browser_cache', 'bulk_manifest'));
