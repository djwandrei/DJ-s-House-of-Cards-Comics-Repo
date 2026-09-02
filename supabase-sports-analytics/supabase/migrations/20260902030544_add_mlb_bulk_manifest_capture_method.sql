-- Preserve accurate provenance when a private analytics URL manifest is
-- imported from an approved bulk data release rather than a source page.
alter table public.mlb_media_assets
  drop constraint if exists mlb_media_assets_capture_method_check;

alter table public.mlb_media_assets
  add constraint mlb_media_assets_capture_method_check
  check (capture_method in ('source_page', 'derived_template', 'browser_cache', 'bulk_manifest'));
