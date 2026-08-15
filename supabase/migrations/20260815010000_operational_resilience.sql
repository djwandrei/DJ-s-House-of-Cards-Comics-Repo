-- Keep time-window reporting and maintenance bounded as operational history grows.
create index if not exists site_analytics_events_created_idx
  on public.site_analytics_events(created_at desc);

create index if not exists public_submission_rate_limits_window_idx
  on public.public_submission_rate_limits(window_started_at);

-- Public submission endpoints call this RPC through the server-only client.
-- The original migration revoked PUBLIC but omitted the service-role grant.
revoke all on function public.take_public_submission_slot(text, text, integer, integer) from public;
grant execute on function public.take_public_submission_slot(text, text, integer, integer) to service_role;

create or replace function public.prune_operational_history(p_processed_days integer default 90)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  processed_days integer := greatest(30, coalesce(p_processed_days, 90));
  analytics_days integer := greatest(90, coalesce(p_processed_days, 90));
  stripe_count integer;
  marketplace_count integer;
  notification_count integer;
  analytics_count integer;
  rate_limit_count integer;
begin
  delete from public.webhook_events
  where processing_status in ('processed', 'ignored')
    and coalesce(processed_at, created_at) < now() - make_interval(days => processed_days);
  get diagnostics stripe_count = row_count;

  delete from public.marketplace_webhook_events
  where processing_status in ('processed', 'ignored')
    and coalesce(processed_at, created_at) < now() - make_interval(days => processed_days);
  get diagnostics marketplace_count = row_count;

  delete from public.notification_outbox
  where status = 'sent'
    and sent_at < now() - make_interval(days => processed_days);
  get diagnostics notification_count = row_count;

  delete from public.site_analytics_events
  where created_at < now() - make_interval(days => analytics_days);
  get diagnostics analytics_count = row_count;

  -- Current public windows are one hour. Two days preserves active windows
  -- while removing fingerprints that no longer participate in throttling.
  delete from public.public_submission_rate_limits
  where window_started_at < now() - interval '2 days';
  get diagnostics rate_limit_count = row_count;

  return jsonb_build_object(
    'stripe', stripe_count,
    'marketplace', marketplace_count,
    'notifications', notification_count,
    'analytics', analytics_count,
    'rateLimits', rate_limit_count
  );
end;
$$;

revoke all on function public.prune_operational_history(integer) from public;
grant execute on function public.prune_operational_history(integer) to service_role;
