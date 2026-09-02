import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { requireSiteAdmin, SiteAdminError } from '../_shared/admin-auth.ts';
import { timingSafeEqualText } from '../_shared/constant-time.ts';
import { readJsonBody } from '../_shared/http.ts';

type LeagueCode = 'MLB' | 'NFL';

type MappingRow = {
  product_id: number;
  athlete_id: string;
  league_code: LeagueCode;
  subject_order: number;
  subject_role: string;
  depicted_season_label: string;
  depicted_season_start_year: number | null;
  depicted_season_end_year: number | null;
  season_mapping_method: string;
  review_state: string;
};

type ProductRow = {
  id: number;
  category: string;
  league: string;
  is_deleted: boolean;
  sale_status: string;
};

type AnalyticsProfile = {
  athleteId: string;
  leagueCode: LeagueCode;
  player: Record<string, unknown>;
  seasons: unknown[];
};

type CacheWriteRow = {
  product_id: number;
  league_code: LeagueCode;
  athlete_ids: string[];
  mapping_sha256: string;
  payload: Record<string, unknown>;
  payload_sha256: string;
  analytics_project_ref: string;
  analytics_schema_version: number;
  analytics_refreshed_at: string;
  synced_at: string;
  updated_at: string;
};

type StoredCacheRow = Pick<CacheWriteRow,
  'product_id' | 'league_code' | 'athlete_ids' | 'mapping_sha256'
  | 'payload_sha256' | 'analytics_project_ref' | 'analytics_schema_version'>;

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const analyticsUrl = String(Deno.env.get('PRO_SPORTS_ANALYTICS_SUPABASE_URL') || '').trim().replace(/\/+$/, '');
const analyticsServiceRoleKey = String(Deno.env.get('PRO_SPORTS_ANALYTICS_SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const analyticsProjectRef = String(Deno.env.get('PRO_SPORTS_ANALYTICS_PROJECT_REF') || '').trim();
const workerSecret = String(Deno.env.get('PRO_SPORTS_PRODUCT_SLAB_CACHE_SYNC_SECRET') || '').trim();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
const DEFAULT_CORS_ORIGINS = [
  'https://www.djshouseofcards-comics.com',
  'https://djshouseofcards-comics.com',
];
const LEAGUES: LeagueCode[] = ['MLB', 'NFL'];

// Keep an unconfigured deployment inert. The handler returns its 503 before a
// request can use either placeholder client.
const admin = createClient(supabaseUrl || 'https://unconfigured.invalid', serviceRoleKey || 'unconfigured', {
  auth: { persistSession: false },
});
const analytics = createClient(analyticsUrl || 'https://unconfigured.invalid', analyticsServiceRoleKey || 'unconfigured', {
  auth: { persistSession: false },
});

function normalizeOrigin(value: string) {
  const trimmed = String(value || '').trim().replace(/\/+$/, '');
  if (!trimmed) return '';
  try {
    return new URL(trimmed).origin;
  } catch {
    return trimmed;
  }
}

const allowedOrigins = [...new Set([
  ...DEFAULT_CORS_ORIGINS,
  normalizeOrigin(siteUrl),
].filter(Boolean))];

function corsHeadersFor(request: Request) {
  const origin = normalizeOrigin(request.headers.get('origin') || '');
  const allowedOrigin = origin && allowedOrigins.includes(origin) ? origin : allowedOrigins[0];
  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-djhc-pro-sports-cache-secret',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    Vary: 'Origin',
  };
}

function jsonResponse(body: Record<string, unknown>, status: number, request: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersFor(request), 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function allowedOrigin(request: Request) {
  const origin = normalizeOrigin(request.headers.get('origin') || '');
  return !origin || allowedOrigins.includes(origin);
}

function analyticsUrlMatchesProjectRef() {
  try {
    return new URL(analyticsUrl).hostname === analyticsProjectRef + '.supabase.co';
  } catch {
    return false;
  }
}

function isLeagueCode(value: unknown): value is LeagueCode {
  return LEAGUES.includes(String(value || '').trim().toUpperCase() as LeagueCode);
}

function chunks<T>(items: T[], size: number) {
  const output: T[][] = [];
  for (let index = 0; index < items.length; index += size) output.push(items.slice(index, index + size));
  return output;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(object[key])}`).join(',')}}`;
}

async function sha256(value: unknown) {
  const bytes = new TextEncoder().encode(stableStringify(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function profileKey(leagueCode: LeagueCode, athleteId: string) {
  return `${leagueCode}:${String(athleteId || '').trim()}`;
}

function validAnalyticsProfile(value: unknown, expectedLeague: LeagueCode): value is AnalyticsProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const player = candidate.player;
  const playerRecord = player && typeof player === 'object' && !Array.isArray(player)
    ? player as Record<string, unknown>
    : null;
  return typeof candidate.athleteId === 'string'
    && candidate.athleteId.trim().length > 0
    && String(candidate.leagueCode || '').trim().toUpperCase() === expectedLeague
    && playerRecord !== null
    && String(playerRecord.athleteId || '').trim() === candidate.athleteId.trim()
    && String(playerRecord.leagueCode || '').trim().toUpperCase() === expectedLeague
    && typeof playerRecord.name === 'string'
    && playerRecord.name.trim().length > 0
    && Array.isArray(candidate.seasons);
}

function visibleLeague(product: ProductRow | undefined): LeagueCode | null {
  if (!product || product.is_deleted || ['hidden', 'archived', 'sold'].includes(String(product.sale_status || '').trim().toLowerCase())) {
    return null;
  }
  const category = String(product.category || '').trim().toLowerCase();
  const league = String(product.league || '').trim().toUpperCase();
  if (category === 'baseball' && league === 'MLB') return 'MLB';
  if (category === 'football' && league === 'NFL') return 'NFL';
  return null;
}

async function listMappings() {
  const rows: MappingRow[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await admin
      .from('product_athlete_mappings')
      .select('product_id,athlete_id,league_code,subject_order,subject_role,depicted_season_label,depicted_season_start_year,depicted_season_end_year,season_mapping_method,review_state')
      .in('league_code', LEAGUES)
      .in('review_state', ['auto_verified', 'human_verified'])
      .order('league_code', { ascending: true })
      .order('product_id', { ascending: true })
      .order('subject_order', { ascending: true })
      .order('athlete_id', { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(`Could not load verified MLB/NFL product mappings: ${error.message}`);
    // Page termination must be based on the database response rather than the
    // post-validation subset. Otherwise one malformed row in a full page could
    // silently skip every later verified mapping.
    const rawPage = (data || []) as MappingRow[];
    rows.push(...rawPage.filter((row) => isLeagueCode(row.league_code)));
    if (rawPage.length < 500) break;
  }
  return rows;
}

async function visibleProducts(productIds: number[]) {
  const byId = new Map<number, LeagueCode>();
  for (const ids of chunks([...new Set(productIds)].sort((left, right) => left - right), 250)) {
    const { data, error } = await admin
      .from('products')
      .select('id,category,league,is_deleted,sale_status')
      .in('id', ids);
    if (error) throw new Error(`Could not verify mapped product visibility: ${error.message}`);
    for (const product of (data || []) as ProductRow[]) {
      const leagueCode = visibleLeague(product);
      if (leagueCode) byId.set(Number(product.id), leagueCode);
    }
  }
  return byId;
}

async function analyticsProfiles(leagueCode: LeagueCode, athleteIds: string[]) {
  const byAthleteId = new Map<string, AnalyticsProfile>();
  for (const ids of chunks([...new Set(athleteIds)].sort(), 150)) {
    const { data, error } = await analytics.rpc('get_pro_sports_athlete_slab_stats_batch', {
      p_league_code: leagueCode,
      p_athlete_ids: ids,
    });
    if (error) throw new Error(`Could not read the dedicated ${leagueCode} analytics payload: ${error.message}`);
    if (!Array.isArray(data)) throw new Error(`The dedicated ${leagueCode} analytics project returned an invalid profile batch.`);
    for (const profile of data) {
      if (!validAnalyticsProfile(profile, leagueCode)) {
        throw new Error(`The dedicated ${leagueCode} analytics project returned a malformed profile.`);
      }
      byAthleteId.set(profile.athleteId, profile);
    }
  }
  return byAthleteId;
}

async function authorize(request: Request) {
  const suppliedWorkerSecret = String(request.headers.get('x-djhc-pro-sports-cache-secret') || '').trim();
  if (workerSecret && timingSafeEqualText(suppliedWorkerSecret, workerSecret)) return;
  await requireSiteAdmin(request, admin);
}

function cachePayload(productId: number, leagueCode: LeagueCode, mappings: MappingRow[], profiles: Map<string, AnalyticsProfile>) {
  const players = mappings
    .slice()
    .sort((left, right) => left.subject_order - right.subject_order || left.athlete_id.localeCompare(right.athlete_id))
    .map((mapping) => {
      const profile = profiles.get(profileKey(leagueCode, mapping.athlete_id));
      if (!profile) throw new Error(`The analytics project does not contain an active ${leagueCode} profile for one verified product mapping.`);
      return {
        mapping: {
          subjectOrder: mapping.subject_order,
          subjectRole: mapping.subject_role,
          depictedSeasonLabel: mapping.depicted_season_label,
          depictedSeasonStartYear: mapping.depicted_season_start_year,
          depictedSeasonEndYear: mapping.depicted_season_end_year,
          seasonMappingMethod: mapping.season_mapping_method,
          reviewState: mapping.review_state,
        },
        player: profile.player,
        seasons: profile.seasons,
      };
    });
  return { schemaVersion: 1, provider: leagueCode, productId, players };
}

async function createRun() {
  const { data, error } = await admin
    .from('pro_sports_product_slab_stats_cache_runs')
    .insert({ status: 'running', analytics_project_ref: analyticsProjectRef, league_code: 'BOTH' })
    .select('id')
    .single();
  if (error || !data?.id) throw new Error(`Could not start the pro-sports cache synchronization audit: ${error?.message || 'missing run ID'}`);
  return String(data.id);
}

async function finishRun(runId: string, values: Record<string, unknown>) {
  const { error } = await admin
    .from('pro_sports_product_slab_stats_cache_runs')
    .update(values)
    .eq('id', runId);
  if (error) throw new Error(`Could not finish the pro-sports cache synchronization audit: ${error.message}`);
}

function sameOrderedStrings(left: unknown, right: unknown) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => String(value) === String(right[index]));
}

async function verifyStoredCache(expectedRows: CacheWriteRow[]) {
  let checked = 0;
  let mismatches = 0;
  const expectedByProductId = new Map(expectedRows.map((row) => [row.product_id, row]));

  for (const ids of chunks([...expectedByProductId.keys()].sort((left, right) => left - right), 200)) {
    const { data, error } = await admin
      .from('pro_sports_product_slab_stats_cache')
      .select('product_id,league_code,athlete_ids,mapping_sha256,payload_sha256,analytics_project_ref,analytics_schema_version')
      .in('product_id', ids);
    if (error) throw new Error(`Could not verify stored pro-sports product stats cache rows: ${error.message}`);

    const actualByProductId = new Map(
      ((data || []) as StoredCacheRow[]).map((row) => [Number(row.product_id), row]),
    );
    for (const productId of ids) {
      const expected = expectedByProductId.get(productId);
      const actual = actualByProductId.get(productId);
      checked += 1;
      if (!expected || !actual
        || actual.league_code !== expected.league_code
        || !sameOrderedStrings(actual.athlete_ids, expected.athlete_ids)
        || actual.mapping_sha256 !== expected.mapping_sha256
        || actual.payload_sha256 !== expected.payload_sha256
        || actual.analytics_project_ref !== expected.analytics_project_ref
        || Number(actual.analytics_schema_version) !== expected.analytics_schema_version) {
        mismatches += 1;
      }
    }
  }
  return { checked, mismatches };
}

// Cache rows are intentionally not deleted here. If a product becomes hidden,
// sold, unmapped, or changes leagues, the public RPC rejects its old row. Keep
// any obsolete cache rows for audit/recovery until an explicitly authorized
// cleanup reviews them.
async function countStaleCacheRows(eligibleProductIds: number[]) {
  const { data, error } = await admin
    .from('pro_sports_product_slab_stats_cache')
    .select('product_id')
    .order('product_id', { ascending: true });
  if (error) throw new Error(`Could not inspect stale pro-sports cache rows: ${error.message}`);
  const eligible = new Set(eligibleProductIds);
  return ((data || []) as Array<{ product_id?: number }>)
    .map((row) => Number(row.product_id))
    .filter((productId) => Number.isSafeInteger(productId) && !eligible.has(productId)).length;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(request) });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, request);
  if (!allowedOrigin(request)) return jsonResponse({ error: 'This request origin is not allowed.' }, 403, request);
  if (!supabaseUrl || !serviceRoleKey || !analyticsUrl || !analyticsServiceRoleKey
    || !/^[a-z0-9]{20}$/.test(analyticsProjectRef) || !analyticsUrlMatchesProjectRef()) {
    return jsonResponse({ error: 'MLB/NFL analytics cache synchronization is not configured.' }, 503, request);
  }

  try {
    await readJsonBody<Record<string, unknown>>(request, 2 * 1024);
  } catch {
    return jsonResponse({ error: 'Invalid cache synchronization request.' }, 400, request);
  }

  try {
    await authorize(request);
  } catch (error) {
    return jsonResponse(
      { error: error instanceof Error ? error.message : 'Admin authorization failed.' },
      error instanceof SiteAdminError ? error.status : 403,
      request,
    );
  }

  let runId = '';
  try {
    runId = await createRun();
    const mappings = await listMappings();
    const products = await visibleProducts(mappings.map((row) => row.product_id));
    const grouped = new Map<number, MappingRow[]>();
    for (const mapping of mappings) {
      if (products.get(mapping.product_id) !== mapping.league_code) continue;
      const current = grouped.get(mapping.product_id) || [];
      current.push(mapping);
      grouped.set(mapping.product_id, current);
    }

    const eligibleProducts = [...grouped.keys()].sort((left, right) => left - right);
    const profiles = new Map<string, AnalyticsProfile>();
    for (const leagueCode of LEAGUES) {
      const athleteIds = eligibleProducts.flatMap((productId) => (grouped.get(productId) || [])
        .filter((mapping) => mapping.league_code === leagueCode)
        .map((mapping) => mapping.athlete_id));
      if (!athleteIds.length) continue;
      const leagueProfiles = await analyticsProfiles(leagueCode, athleteIds);
      for (const [athleteId, profile] of leagueProfiles) profiles.set(profileKey(leagueCode, athleteId), profile);
    }

    const missingProfiles = [...new Set(eligibleProducts.flatMap((productId) => (grouped.get(productId) || [])
      .filter((mapping) => !profiles.has(profileKey(mapping.league_code, mapping.athlete_id)))
      .map((mapping) => profileKey(mapping.league_code, mapping.athlete_id))))];
    if (missingProfiles.length) throw new Error(`${missingProfiles.length} verified product mappings have no active dedicated-analytics profile.`);

    const synchronizedAt = new Date().toISOString();
    const cacheRows: CacheWriteRow[] = [];
    for (const productId of eligibleProducts) {
      const productMappings = grouped.get(productId) || [];
      const leagueCode = products.get(productId);
      if (!leagueCode || productMappings.some((mapping) => mapping.league_code !== leagueCode)) {
        throw new Error(`Verified mapping league drift blocks cache publication for product ${productId}.`);
      }
      const orderedProductMappings = productMappings.slice().sort((left, right) => (
        left.subject_order - right.subject_order || left.athlete_id.localeCompare(right.athlete_id)
      ));
      const payload = cachePayload(productId, leagueCode, orderedProductMappings, profiles);
      cacheRows.push({
        product_id: productId,
        league_code: leagueCode,
        athlete_ids: orderedProductMappings.map((mapping) => mapping.athlete_id).sort(),
        mapping_sha256: await sha256(orderedProductMappings.map((mapping) => ({
          athleteId: mapping.athlete_id,
          leagueCode: mapping.league_code,
          subjectOrder: mapping.subject_order,
          subjectRole: mapping.subject_role,
          depictedSeasonLabel: mapping.depicted_season_label,
          depictedSeasonStartYear: mapping.depicted_season_start_year,
          depictedSeasonEndYear: mapping.depicted_season_end_year,
          seasonMappingMethod: mapping.season_mapping_method,
          reviewState: mapping.review_state,
        }))),
        payload,
        payload_sha256: await sha256(payload),
        analytics_project_ref: analyticsProjectRef,
        analytics_schema_version: 1,
        analytics_refreshed_at: synchronizedAt,
        synced_at: synchronizedAt,
        updated_at: synchronizedAt,
      });
    }

    for (const rows of chunks(cacheRows, 200)) {
      const { error } = await admin
        .from('pro_sports_product_slab_stats_cache')
        .upsert(rows, { onConflict: 'product_id' });
      if (error) throw new Error(`Could not update the pro-sports product stats cache: ${error.message}`);
    }

    const verification = await verifyStoredCache(cacheRows);
    const staleCacheRows = verification.mismatches ? 0 : await countStaleCacheRows(eligibleProducts);
    await finishRun(runId, {
      status: verification.mismatches ? 'failed' : 'completed',
      mapped_product_count: eligibleProducts.length,
      cache_upsert_count: cacheRows.length,
      cache_checked_count: verification.checked,
      mismatch_count: verification.mismatches,
      stale_cache_count: staleCacheRows,
      error_summary: verification.mismatches ? 'Stored cache validation found a payload mismatch.' : '',
      completed_at: new Date().toISOString(),
    });
    return jsonResponse({
      ok: verification.mismatches === 0,
      mappedProducts: eligibleProducts.length,
      cacheUpserts: cacheRows.length,
      cacheChecked: verification.checked,
      staleCacheRows,
      mismatches: verification.mismatches,
    }, verification.mismatches ? 409 : 200, request);
  } catch (error) {
    if (runId) {
      try {
        await finishRun(runId, {
          status: 'failed',
          error_summary: String(error instanceof Error ? error.message : error).slice(0, 1000),
          completed_at: new Date().toISOString(),
        });
      } catch (finishError) {
        console.error('[sync-pro-sports-product-slab-stats-cache] could not record failure', finishError);
      }
    }
    console.error('[sync-pro-sports-product-slab-stats-cache]', error);
    return jsonResponse({ error: 'The MLB/NFL product stats cache could not be synchronized.' }, 500, request);
  }
});
