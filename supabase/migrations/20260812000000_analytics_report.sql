-- Private aggregate reporting for the admin-only conversion and performance page.
-- Apply with `supabase db push` before deploying the analytics-report Edge Function.

create index if not exists checkout_orders_status_created_idx
  on public.checkout_orders(status, created_at desc);

create or replace function public.get_site_analytics_report(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  report_days integer := case when p_days in (7, 30, 90) then p_days else 30 end;
  report_start timestamptz := now() - make_interval(days => case when p_days in (7, 30, 90) then p_days else 30 end);
begin
  return jsonb_build_object(
    'windowDays', report_days,
    'eventCounts', coalesce((
      select jsonb_object_agg(event_type, total)
      from (
        select event_type, count(*)::integer as total
        from public.site_analytics_events
        where created_at >= report_start
        group by event_type
      ) counts
    ), '{}'::jsonb),
    'topPages', coalesce((
      select jsonb_agg(jsonb_build_object('path', page_path, 'views', views) order by views desc, page_path)
      from (
        select page_path, count(*)::integer as views
        from public.site_analytics_events
        where created_at >= report_start and event_type = 'page_view'
        group by page_path
        order by views desc, page_path
        limit 8
      ) pages
    ), '[]'::jsonb),
    'daily', coalesce((
      select jsonb_agg(jsonb_build_object(
        'date', day::text,
        'pageViews', page_views,
        'addToCart', add_to_cart,
        'checkoutStarts', checkout_starts
      ) order by day)
      from (
        select
          created_at::date as day,
          count(*) filter (where event_type = 'page_view')::integer as page_views,
          count(*) filter (where event_type = 'add_to_cart')::integer as add_to_cart,
          count(*) filter (where event_type = 'begin_checkout')::integer as checkout_starts
        from public.site_analytics_events
        where created_at >= report_start
        group by created_at::date
        order by day
      ) daily_rows
    ), '[]'::jsonb),
    'sales', (
      select jsonb_build_object(
        'paidOrders', count(*)::integer,
        'revenueCents', coalesce(sum(amount_total), 0),
        'itemsSold', coalesce(sum(item_count), 0)
      )
      from public.checkout_orders
      where created_at >= report_start
        and status in ('paid', 'complete', 'succeeded', 'no_payment_required')
    ),
    'webVitals', (
      select jsonb_strip_nulls(jsonb_build_object(
        'lcp', avg(nullif(payload->>'lcp', '')::numeric),
        'inp', avg(nullif(payload->>'inp', '')::numeric),
        'cls', avg(nullif(payload->>'cls', '')::numeric),
        'ttfb', avg(nullif(payload->>'ttfb', '')::numeric)
      ))
      from public.site_analytics_events
      where created_at >= report_start and event_type = 'web_vitals'
    )
  );
end;
$$;

revoke all on function public.get_site_analytics_report(integer) from public;
grant execute on function public.get_site_analytics_report(integer) to service_role;
