import { createClient } from 'jsr:@supabase/supabase-js@2.105.1';
import { requireSiteAdmin, SiteAdminError } from '../_shared/admin-auth.ts';
import { timingSafeEqualText } from '../_shared/constant-time.ts';
import { readJsonBody } from '../_shared/http.ts';

type MappingRow = {
  product_id: number;
  athlete_id: string;
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
  player: Record<string, unknown>;
  seasons: unknown[];
};

type CacheWriteRow = {
  product_id: number;
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
  'product_id' | 'athlete_ids' | 'mapping_sha256' | 'payload_sha256'
  | 'analytics_project_ref' | 'analytics_schema_version'>;

const supabaseUrl = String(Deno.env.get('SUPABASE_URL') || '').trim();
const serviceRoleKey = String(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const analyticsUrl = String(Deno.env.get('ANALYTICS_SUPABASE_URL') || '').trim().replace(/\/+$/, '');
const analyticsServiceRoleKey = String(Deno.env.get('ANALYTICS_SUPABASE_SERVICE_ROLE_KEY') || '').trim();
const analyticsProjectRef = String(Deno.env.get('ANALYTICS_SUPABASE_PROJECT_REF') || '').trim();
const workerSecret = String(Deno.env.get('NBA_PRODUCT_SLAB_CACHE_SYNC_SECRET') || '').trim();
const siteUrl = String(Deno.env.get('SITE_URL') || 'https://www.djshouseofcards-comics.com').replace(/\/+$/, '');
// Keep an unconfigured deployment inert: the handler returns its 503 before a
// network request can use either placeholder. This avoids module-load failure
// while a newly deployed function is waiting for its production secrets.
const admin = createClient(supabaseUrl || 'https://unconfigured.invalid', serviceRoleKey || 'unconfigured', { auth: { persistSession: false } });
const analytics = createClient(analyticsUrl || 'https://unconfigured.invalid', analyticsServiceRoleKey || 'unconfigured', { auth: { persistSession: false } });
const DEFAULT_CORS_ORIGINS = [
  'https://www.djshouseofcards-comics.com',
  'https://djshouseofcards-comics.com',
];

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
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-djhc-analytics-cache-secret',
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

function validAnalyticsProfile(value: unknown): value is AnalyticsProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.athleteId === 'string'
    && candidate.player !== null
    && typeof candidate.player === 'object'
    && Array.isArray(candidate.seasons);
}

function visibleNbaProduct(product: ProductRow | undefined) {
  return Boolean(product)
    && String(product.category || '').trim().toLowerCase() === 'basketball'
    && String(product.league || '').trim().toUpperCase() === 'NBA'
    && !product.is_deleted
    && !['hidden', 'archived', 'sold'].includes(String(product.sale_status || '').trim().toLowerCase());
}

async function listMappings() {
  const rows: MappingRow[] = [];
  for (let from = 0; ; from += 500) {
    const { data, error } = await admin
      .from('product_athlete_mappings')
      .select('product_id,athlete_id,subject_order,subject_role,depicted_season_label,depicted_season_start_year,depicted_season_end_year,season_mapping_method,review_state')
      .eq('league_code', 'NBA')
      .in('review_state', ['auto_verified', 'human_verified'])
      .order('product_id', { ascending: true })
      .order('subject_order', { ascending: true })
      .order('athlete_id', { ascending: true })
      .range(from, from + 499);
    if (error) throw new Error(`Could not load verified NBA product mappings: ${error.message}`);
    const page = (data || []) as MappingRow[];
    rows.push(...page);
    if (page.length < 500) break;
  }
  return rows;
}

async function visibleProducts(productIds: number[]) {
  const byId = new Map<number, ProductRow>();
  for (const ids of chunks([...new Set(productIds)].sort((left, right) => left - right), 250)) {
    const { data, error } = await admin
      .from('products')
      .select('id,category,league,is_deleted,sale_status')
      .in('id', ids);
    if (error) throw new Error(`Could not verify mapped product visibility: ${error.message}`);
    for (const product of (data || []) as ProductRow[]) {
      if (visibleNbaProduct(product)) byId.set(product.id, product);
    }
  }
  return byId;
}

async function analyticsProfiles(athleteIds: string[]) {
  const byAthleteId = new Map<string, AnalyticsProfile>();
  for (const ids of chunks([...new Set(athleteIds)].sort(), 150)) {
    const { data, error } = await analytics.rpc('get_nba_athlete_slab_stats_batch', {
      p_athlete_ids: ids,
    });
    if (error) throw new Error(`Could not read the dedicated NBA analytics project: ${error.message}`);
    if (!Array.isArray(data)) throw new Error('The dedicated NBA analytics project returned an invalid profile batch.');
    for (const profile of data) {
      if (!validAnalyticsProfile(profile)) throw new Error('The dedicated NBA analytics project returned a malformed profile.');
      byAthleteId.set(profile.athleteId, profile);
    }
  }
  return byAthleteId;
}

async function authorize(request: Request) {
  const suppliedWorkerSecret = String(request.headers.get('x-djhc-analytics-cache-secret') || '').trim();
  if (workerSecret && timingSafeEqualText(suppliedWorkerSecret, workerSecret)) return;
  await requireSiteAdmin(request, admin);
}

function cachePayload(productId: number, mappings: MappingRow[], profiles: Map<string, AnalyticsProfile>) {
  const players = mappings
    .slice()
    .sort((left, right) => left.subject_order - right.subject_order || left.athlete_id.localeCompare(right.athlete_id))
    .map((mapping) => {
      const profile = profiles.get(mapping.athlete_id);
      if (!profile) throw new Error(`The analytics project does not contain a verified NBA profile for one mapped athlete.`);
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
  return { schemaVersion: 1, provider: 'NBA', productId, players };
}

async function createRun() {
  const { data, error } = await admin
    .from('nba_product_slab_stats_cache_runs')
    .insert({ status: 'running', analytics_project_ref: analyticsProjectRef })
    .select('id')
    .single();
  if (error || !data?.id) throw new Error(`Could not start the cache synchronization audit: ${error?.message || 'missing run ID'}`);
  return String(data.id);
}

async function finishRun(runId: string, values: Record<string, unknown>) {
  const { error } = await admin
    .from('nba_product_slab_stats_cache_runs')
    .update(values)
    .eq('id', runId);
  if (error) throw new Error(`Could not finish the cache synchronization audit: ${error.message}`);
}

function sameOrderedStrings(left: unknown, right: unknown) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => String(value) === String(right[index]));
}

// The original commerce database intentionally stops carrying the full NBA
// fact tables after the analytics-project migration.  Validate the stored
// compact payload against the rows just calculated from the dedicated project,
// rather than calling a legacy in-database stats query as a shadow source.
async function verifyStoredCache(expectedRows: CacheWriteRow[]) {
  let checked = 0;
  let mismatches = 0;
  const expectedByProductId = new Map(expectedRows.map((row) => [row.product_id, row]));

  for (const ids of chunks([...expectedByProductId.keys()].sort((left, right) => left - right), 200)) {
    const { data, error } = await admin
      .from('nba_product_slab_stats_cache')
      .select('product_id,athlete_ids,mapping_sha256,payload_sha256,analytics_project_ref,analytics_schema_version')
      .in('product_id', ids);
    if (error) throw new Error(`Could not verify stored product stats cache rows: ${error.message}`);

    const actualByProductId = new Map(
      ((data || []) as StoredCacheRow[]).map((row) => [Number(row.product_id), row]),
    );
    for (const productId of ids) {
      const expected = expectedByProductId.get(productId);
      const actual = actualByProductId.get(productId);
      checked += 1;
      if (!expected || !actual
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

async function pruneObsoleteCache(eligibleProductIds: number[]) {
  const { data, error } = await admin
    .from('nba_product_slab_stats_cache')
    .select('product_id')
    .order('product_id', { ascending: true });
  if (error) throw new Error(`Could not inspect obsolete product stats cache rows: ${error.message}`);

  const eligible = new Set(eligibleProductIds);
  const staleProductIds = ((data || []) as Array<{ product_id?: number }>)
    .map((row) => Number(row.product_id))
    .filter((productId) => Number.isSafeInteger(productId) && !eligible.has(productId));
  for (const ids of chunks(staleProductIds, 200)) {
    const { error: deleteError } = await admin
      .from('nba_product_slab_stats_cache')
      .delete()
      .in('product_id', ids);
    if (deleteError) throw new Error(`Could not remove obsolete product stats cache rows: ${deleteError.message}`);
  }
  return staleProductIds.length;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeadersFor(request) });
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed.' }, 405, request);
  if (!allowedOrigin(request)) return jsonResponse({ error: 'This request origin is not allowed.' }, 403, request);
  if (!supabaseUrl || !serviceRoleKey || !analyticsUrl || !analyticsServiceRoleKey || !/^[a-z0-9]{20}$/.test(analyticsProjectRef)) {
    return jsonResponse({ error: 'NBA analytics cache synchronization is not configured.' }, 503, request);
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
      if (!products.has(mapping.product_id)) continue;
      const current = grouped.get(mapping.product_id) || [];
      current.push(mapping);
      grouped.set(mapping.product_id, current);
    }

    const eligibleProducts = [...grouped.keys()].sort((left, right) => left - right);
    const profiles = await analyticsProfiles(
      eligibleProducts.flatMap((productId) => (grouped.get(productId) || []).map((mapping) => mapping.athlete_id)),
    );
    const missingProfiles = [...new Set(eligibleProducts.flatMap((productId) => (grouped.get(productId) || [])
      .map((mapping) => mapping.athlete_id)
      .filter((athleteId) => !profiles.has(athleteId))))];
    if (missingProfiles.length) throw new Error(`${missingProfiles.length} verified product mappings have no active dedicated-analytics profile.`);

    const synchronizedAt = new Date().toISOString();
    const cacheRows: CacheWriteRow[] = [];
    for (const productId of eligibleProducts) {
      const productMappings = grouped.get(productId) || [];
      const payload = cachePayload(productId, productMappings, profiles);
      cacheRows.push({
        product_id: productId,
        athlete_ids: productMappings.map((mapping) => mapping.athlete_id).sort(),
        mapping_sha256: await sha256(productMappings.map((mapping) => ({
          athleteId: mapping.athlete_id,
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
        .from('nba_product_slab_stats_cache')
        .upsert(rows, { onConflict: 'product_id' });
      if (error) throw new Error(`Could not update the product stats cache: ${error.message}`);
    }

    const verification = await verifyStoredCache(cacheRows);
    const cachePrunes = verification.mismatches ? 0 : await pruneObsoleteCache(eligibleProducts);
    await finishRun(runId, {
      status: verification.mismatches ? 'failed' : 'completed',
      mapped_product_count: eligibleProducts.length,
      cache_upsert_count: cacheRows.length,
      // The persisted column name predates the dedicated-project cutover.
      // It now records direct stored-cache verification, not a legacy shadow
      // query, and stays unchanged for historical audit compatibility.
      shadow_checked_count: verification.checked,
      mismatch_count: verification.mismatches,
      error_summary: verification.mismatches ? 'Stored cache validation found a payload mismatch.' : '',
      completed_at: new Date().toISOString(),
    });
    return jsonResponse({
      ok: verification.mismatches === 0,
      mappedProducts: eligibleProducts.length,
      cacheUpserts: cacheRows.length,
      cachePrunes,
      cacheChecked: verification.checked,
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
        console.error('[sync-nba-product-slab-stats-cache] could not record failure', finishError);
      }
    }
    console.error('[sync-nba-product-slab-stats-cache]', error);
    return jsonResponse({ error: 'The NBA product stats cache could not be synchronized.' }, 500, request);
  }
});
