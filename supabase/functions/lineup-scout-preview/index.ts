import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { requireSiteAdmin, SiteAdminError } from '../_shared/admin-auth.ts';
import { readJsonBody } from '../_shared/http.ts';

// Authorization belongs to commerce Auth; the derived data belongs ONLY to
// the dedicated NBA project. Never accept a project URL or key from a caller.
const nbaUrl = 'https://fbbmuqbdpgsmvnezowwn.supabase.co';
const configuredUrl = String(Deno.env.get('ANALYTICS_SUPABASE_URL') || '').replace(/\/+$/, '');
const nbaKey = Deno.env.get('ANALYTICS_SUPABASE_SERVICE_ROLE_KEY') || '';
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const nba = createClient(nbaUrl, nbaKey || 'unconfigured', { auth: { persistSession: false } });
const origins = new Set(['https://www.djshouseofcards-comics.com', 'https://djshouseofcards-comics.com']);

Deno.serve(async (request) => {
  const origin = request.headers.get('origin') || '';
  const headers = {
    'Access-Control-Allow-Origin': origins.has(origin) ? origin : 'https://www.djshouseofcards-comics.com',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin', 'Cache-Control': 'private, no-store', 'Content-Type': 'application/json',
  };
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
  if (origin && !origins.has(origin)) return reply({ error: 'Origin not allowed.' }, 403);
  if (request.method === 'OPTIONS') return new Response(null, { headers });
  if (request.method !== 'POST') return reply({ error: 'Use POST.' }, 405);
  try {
    // getUser validates the token with Auth; the registry is checked on EVERY
    // request. A shopper account or user-editable metadata cannot grant access.
    await requireSiteAdmin(request, admin);
    if (!nbaKey || configuredUrl !== nbaUrl) return reply({ error: 'Private NBA connection is not configured.' }, 503);
    const body = await readJsonBody(request, 48 * 1024);
    const ids = body.playerIds;
    if (!Number.isInteger(body.seasonEndYear) || Number(body.seasonEndYear) < 1980 || Number(body.seasonEndYear) > 2200
      || !/^[A-Z0-9]{2,8}$/.test(String(body.team || ''))
      || !Array.isArray(ids) || !ids.length || ids.length > 1000
      || ids.some(id => typeof id !== 'string' || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
      return reply({ error: 'Choose a saved NBA team-season and valid player IDs.' }, 400);
    }
    const { data, error } = await nba.rpc('get_nba_lineup_scout_preview', {
      p_season_end_year: body.seasonEndYear, p_team_code: body.team, p_player_ids: [...new Set(ids)],
    });
    if (error) return reply({ error: 'Validated Scout evidence is unavailable for this selection. Use Historical mode.' }, 422);
    return reply(data);
  } catch (error) {
    if (error instanceof SiteAdminError) return reply({ error: error.message }, error.status);
    // Never forward provider errors, credentials, or archive descriptors in logs.
    return reply({ error: 'Scout preview could not be loaded.' }, 400);
  }
});
