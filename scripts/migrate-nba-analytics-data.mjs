#!/usr/bin/env node
/**
 * Copy the NBA analytics domain from the commerce-adjacent Supabase project
 * into the dedicated NBA Analytics project.
 *
 * The copier is deliberately one-way and insert/update-only:
 * - It never mutates the source project.
 * - It never reads or writes product, customer, payment, offer, or catalog
 *   tables.
 * - It preserves source IDs, including the stat IDs referenced by metric rows.
 * - It does not delete target rows. An unexpected target row is a verification
 *   failure that needs review, never an automatic cleanup decision.
 *
 * Credentials are supplied only through process environment variables by the
 * PowerShell launcher. They are never written to a report or printed.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DEFAULT_BATCH_SIZE = 500;
const DEFAULT_REPORT_DIRECTORY = path.resolve('outputs', 'nba-analytics-transition');
const SOURCE_PROJECT_REF = 'gkqdymnmczabcggvigce';
const TARGET_PROJECT_REF = 'fbbmuqbdpgsmvnezowwn';
const NBA_LEAGUE = 'NBA';

/**
 * Parent tables must arrive before every foreign-key consumer. The target
 * intentionally remains NBA-only: sports/identity records are filtered to the
 * Basketball/NBA subset and product_athlete_mappings is not present here.
 */
export const analyticsTableSpecs = Object.freeze([
  Object.freeze({ table: 'sports', conflict: 'sport_code', order: 'sport_code.asc', filters: Object.freeze({ sport_code: 'eq.basketball' }) }),
  Object.freeze({ table: 'sports_leagues', conflict: 'league_code', order: 'league_code.asc', filters: Object.freeze({ league_code: 'eq.NBA' }) }),
  Object.freeze({ table: 'athletes', conflict: 'id', order: 'id.asc', sourceScope: 'nbaAthletes', athleteDependencyOrder: true }),
  Object.freeze({ table: 'athlete_league_memberships', conflict: 'athlete_id,league_code', order: 'athlete_id.asc,league_code.asc', filters: Object.freeze({ league_code: 'eq.NBA' }) }),
  Object.freeze({ table: 'athlete_aliases', conflict: 'athlete_id,league_code,normalized_alias', order: 'athlete_id.asc,league_code.asc,normalized_alias.asc', filters: Object.freeze({ league_code: 'eq.NBA' }) }),
  Object.freeze({ table: 'athlete_external_ids', conflict: 'league_code,source_name,external_id', order: 'league_code.asc,source_name.asc,external_id.asc', filters: Object.freeze({ league_code: 'eq.NBA' }) }),
  Object.freeze({ table: 'nba_seasons', conflict: 'season_end_year', order: 'season_end_year.asc' }),
  Object.freeze({ table: 'nba_franchises', conflict: 'id', order: 'id.asc' }),
  Object.freeze({ table: 'nba_team_seasons', conflict: 'id', order: 'id.asc' }),
  Object.freeze({ table: 'nba_players', conflict: 'id', order: 'id.asc', sourceScope: 'nbaPlayers' }),
  Object.freeze({ table: 'nba_player_external_ids', conflict: 'source_name,external_id', order: 'source_name.asc,external_id.asc' }),
  Object.freeze({ table: 'nba_media_assets', conflict: 'id', order: 'id.asc' }),
  Object.freeze({ table: 'nba_stat_import_runs', conflict: 'id', order: 'id.asc' }),
  Object.freeze({ table: 'nba_stat_metric_definitions', conflict: 'metric_code', order: 'metric_code.asc' }),
  Object.freeze({ table: 'nba_player_team_season_stats', conflict: 'id', order: 'id.asc', batchSize: 250 }),
  Object.freeze({ table: 'nba_player_team_season_metric_values', conflict: 'stat_id,metric_code', order: 'stat_id.asc,metric_code.asc', batchSize: 500 }),
  Object.freeze({ table: 'nba_stat_source_records', conflict: 'id', order: 'id.asc', batchSize: 100 }),
]);

export function parseContentRange(value) {
  const match = String(value || '').match(/\/(\d+)$/);
  if (!match) throw new Error(`Supabase did not provide an exact content range: ${value || '(missing)'}.`);
  return Number(match[1]);
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

export function orderAthletesByMergeDependency(rows) {
  const pending = new Map(rows.map((row) => [String(row.id), row]));
  const completed = new Set();
  const ordered = [];
  while (pending.size) {
    const ready = [...pending.values()]
      .filter((row) => !row.merged_into_athlete_id || completed.has(String(row.merged_into_athlete_id)))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (!ready.length) {
      throw new Error('Athlete merge dependencies contain a cycle or reference an unavailable identity.');
    }
    for (const row of ready) {
      pending.delete(String(row.id));
      completed.add(String(row.id));
      ordered.push(row);
    }
  }
  return ordered;
}

function parseArguments(argv) {
  const options = {
    apply: false,
    reportDirectory: DEFAULT_REPORT_DIRECTORY,
    skipHash: false,
    verifyOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--apply') options.apply = true;
    else if (argument === '--verify-only') options.verifyOnly = true;
    else if (argument === '--skip-hash') options.skipHash = true;
    else if (argument === '--report-directory') options.reportDirectory = path.resolve(String(argv[++index] || ''));
    else if (argument === '--help') {
      console.log('Usage: node scripts/migrate-nba-analytics-data.mjs [--apply] [--verify-only] [--skip-hash] [--report-directory path]');
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (options.apply && options.verifyOnly) throw new Error('--apply and --verify-only cannot be used together.');
  return options;
}

function requiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

function projectUrl(projectRef) {
  return `https://${projectRef}.supabase.co`;
}

function isRetryableStatus(status) {
  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

class SupabaseRestClient {
  constructor({ label, url, key }) {
    this.label = label;
    this.url = String(url).replace(/\/$/, '');
    this.key = key;
  }

  async request(relativePath, options = {}, attempt = 0) {
    const response = await fetch(`${this.url}${relativePath}`, {
      ...options,
      headers: {
        apikey: this.key,
        authorization: `Bearer ${this.key}`,
        accept: 'application/json',
        ...options.headers,
      },
    });
    if (response.ok || response.status === 416) return response;
    if (attempt < 5 && isRetryableStatus(response.status)) {
      await delay(250 * (2 ** attempt));
      return this.request(relativePath, options, attempt + 1);
    }
    const body = (await response.text()).slice(0, 700);
    throw new Error(`${this.label} ${options.method || 'GET'} ${relativePath} failed (${response.status}): ${body}`);
  }

  async page(spec, { from = 0, to = DEFAULT_BATCH_SIZE - 1, filters = spec.filters || {}, select = '*' } = {}) {
    const parameters = new URLSearchParams({ select, order: spec.order });
    for (const [key, value] of Object.entries(filters || {})) parameters.set(key, value);
    const response = await this.request(`/rest/v1/${spec.table}?${parameters.toString()}`, {
      headers: {
        Prefer: 'count=exact',
        Range: `${from}-${to}`,
        'Range-Unit': 'items',
      },
    });
    if (response.status === 416) return { rows: [], total: 0 };
    const total = parseContentRange(response.headers.get('content-range'));
    return { rows: await response.json(), total };
  }

  async upsert(spec, rows) {
    if (!rows.length) return;
    const response = await this.request(`/rest/v1/${spec.table}?on_conflict=${encodeURIComponent(spec.conflict)}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify(rows),
    });
    await response.arrayBuffer();
  }

  async count(spec, filters = spec.filters || {}) {
    return (await this.page(spec, { from: 0, to: 0, filters })).total;
  }
}

async function allRows(client, spec, { filters = spec.filters || {}, select = '*' } = {}) {
  const batchSize = spec.batchSize || DEFAULT_BATCH_SIZE;
  const output = [];
  let offset = 0;
  let total = null;
  while (total === null || offset < total) {
    const page = await client.page(spec, { from: offset, to: offset + batchSize - 1, filters, select });
    total = page.total;
    output.push(...page.rows);
    if (!page.rows.length) break;
    offset += page.rows.length;
  }
  if (total !== output.length) {
    throw new Error(`${client.label} ${spec.table} changed while its scoped rows were being read (${output.length}/${total}). Retry the migration once source imports are paused.`);
  }
  return output;
}

async function rowsByIds(client, table, ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean).map(String))].sort();
  const spec = { table, order: 'id.asc', batchSize: 120 };
  const rows = [];
  for (let index = 0; index < uniqueIds.length; index += 120) {
    const values = uniqueIds.slice(index, index + 120).join(',');
    rows.push(...await allRows(client, spec, { filters: { id: `in.(${values})` } }));
  }
  return rows;
}

async function collectNbaScope(source) {
  const nbaPlayerSpec = analyticsTableSpecs.find((spec) => spec.table === 'nba_players');
  const nbaPlayers = await allRows(source, nbaPlayerSpec);
  const athleteIds = new Set(nbaPlayers.map((row) => row.athlete_id).filter(Boolean).map(String));
  const athletesById = new Map();
  let frontier = [...athleteIds];
  while (frontier.length) {
    const rows = await rowsByIds(source, 'athletes', frontier);
    frontier = [];
    for (const row of rows) {
      const id = String(row.id);
      if (athletesById.has(id)) continue;
      athletesById.set(id, row);
      if (row.merged_into_athlete_id && !athletesById.has(String(row.merged_into_athlete_id))) {
        frontier.push(String(row.merged_into_athlete_id));
      }
    }
  }
  const nbaAthletes = orderAthletesByMergeDependency([...athletesById.values()]);
  if (nbaPlayers.some((row) => !athletesById.has(String(row.athlete_id)))) {
    throw new Error('An NBA player references an athlete identity outside the copied NBA scope.');
  }
  return { nbaAthletes, nbaPlayers };
}

async function iterateSourceRows(source, spec, scope, onRows) {
  if (spec.sourceScope) {
    const rows = scope[spec.sourceScope];
    if (!Array.isArray(rows)) throw new Error(`No source scope named ${spec.sourceScope}.`);
    const batchSize = spec.batchSize || DEFAULT_BATCH_SIZE;
    for (let index = 0; index < rows.length; index += batchSize) await onRows(rows.slice(index, index + batchSize));
    return rows.length;
  }

  const batchSize = spec.batchSize || DEFAULT_BATCH_SIZE;
  let offset = 0;
  let copied = 0;
  let total = null;
  while (total === null || offset < total) {
    const page = await source.page(spec, { from: offset, to: offset + batchSize - 1 });
    total = page.total;
    if (!page.rows.length) break;
    await onRows(page.rows);
    copied += page.rows.length;
    offset += page.rows.length;
  }
  if (total !== copied) {
    throw new Error(`Source ${spec.table} changed while copying (${copied}/${total}). Retry the idempotent copier after its import has settled.`);
  }
  return copied;
}

async function copyTable(source, target, spec, scope) {
  let completed = 0;
  const sourceCount = await iterateSourceRows(source, spec, scope, async (rows) => {
    await target.upsert(spec, rows);
    completed += rows.length;
    console.log(`Copied ${spec.table}: ${completed}`);
  });
  const targetCount = await target.count(spec, {});
  if (sourceCount !== targetCount) {
    throw new Error(`Row-count mismatch after ${spec.table}: source ${sourceCount}, target ${targetCount}. No target deletion was attempted.`);
  }
  return { sourceCount, targetCount };
}

async function hashSourceRows(source, spec, scope) {
  const hash = createHash('sha256');
  let count = 0;
  if (spec.sourceScope) {
    const rows = [...scope[spec.sourceScope]].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    for (const row of rows) {
      hash.update(stableStringify(row));
      hash.update('\n');
      count += 1;
    }
    return { count, sha256: hash.digest('hex') };
  }
  await iterateSourceRows(source, spec, scope, async (rows) => {
    for (const row of rows) {
      hash.update(stableStringify(row));
      hash.update('\n');
      count += 1;
    }
  });
  return { count, sha256: hash.digest('hex') };
}

async function hashTargetRows(target, spec) {
  const hash = createHash('sha256');
  const batchSize = spec.batchSize || DEFAULT_BATCH_SIZE;
  let offset = 0;
  let total = null;
  let count = 0;
  while (total === null || offset < total) {
    const page = await target.page(spec, { from: offset, to: offset + batchSize - 1, filters: {} });
    total = page.total;
    if (!page.rows.length) break;
    for (const row of page.rows) {
      hash.update(stableStringify(row));
      hash.update('\n');
      count += 1;
    }
    offset += page.rows.length;
  }
  if (total !== count) throw new Error(`Target ${spec.table} changed while hashing (${count}/${total}).`);
  return { count, sha256: hash.digest('hex') };
}

async function verifyParity(source, target, scope, { skipHash }) {
  const tables = [];
  for (const spec of analyticsTableSpecs) {
    const sourceSummary = skipHash
      ? { count: await sourceCountForSpec(source, spec, scope), sha256: null }
      : await hashSourceRows(source, spec, scope);
    const targetSummary = skipHash
      ? { count: await target.count(spec, {}), sha256: null }
      : await hashTargetRows(target, spec);
    const matches = sourceSummary.count === targetSummary.count
      && (skipHash || sourceSummary.sha256 === targetSummary.sha256);
    tables.push({ table: spec.table, source: sourceSummary, target: targetSummary, matches });
    console.log(`${matches ? 'Verified' : 'Mismatch'} ${spec.table}: ${sourceSummary.count} rows`);
  }
  return tables;
}

async function sourceCountForSpec(source, spec, scope) {
  if (spec.sourceScope) return scope[spec.sourceScope].length;
  return source.count(spec);
}

function writeReport(reportDirectory, report) {
  mkdirSync(reportDirectory, { recursive: true });
  const filename = `nba-analytics-transition-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  const finalPath = path.join(reportDirectory, filename);
  const temporaryPath = `${finalPath}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  renameSync(temporaryPath, finalPath);
  return finalPath;
}

function buildClients() {
  return {
    source: new SupabaseRestClient({
      label: 'source',
      url: process.env.DJHC_NBA_ANALYTICS_SOURCE_URL || projectUrl(SOURCE_PROJECT_REF),
      key: requiredEnvironment('DJHC_NBA_ANALYTICS_SOURCE_SERVICE_ROLE_KEY'),
    }),
    target: new SupabaseRestClient({
      label: 'target',
      url: process.env.DJHC_NBA_ANALYTICS_TARGET_URL || projectUrl(TARGET_PROJECT_REF),
      key: requiredEnvironment('DJHC_NBA_ANALYTICS_TARGET_SERVICE_ROLE_KEY'),
    }),
  };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const { source, target } = buildClients();
  const startedAt = new Date().toISOString();
  const scope = await collectNbaScope(source);
  const copied = [];

  if (options.apply) {
    for (const spec of analyticsTableSpecs) {
      copied.push({ table: spec.table, ...(await copyTable(source, target, spec, scope)) });
    }
  }

  const verification = await verifyParity(source, target, scope, options);
  const report = {
    schemaVersion: 1,
    startedAt,
    completedAt: new Date().toISOString(),
    mode: options.apply ? 'apply' : (options.verifyOnly ? 'verify-only' : 'read-only'),
    sourceProjectRef: SOURCE_PROJECT_REF,
    targetProjectRef: TARGET_PROJECT_REF,
    copied,
    verification,
    passed: verification.every((entry) => entry.matches),
    scope: {
      leagueCode: NBA_LEAGUE,
      nbaPlayers: scope.nbaPlayers.length,
      athleteIdentities: scope.nbaAthletes.length,
      excludedTables: ['products', 'product_athlete_mappings', 'orders', 'customers', 'offers', 'payments', 'storage.objects'],
    },
  };
  const reportPath = writeReport(options.reportDirectory, report);
  console.log(`Transition report: ${reportPath}`);
  if (!report.passed) process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
