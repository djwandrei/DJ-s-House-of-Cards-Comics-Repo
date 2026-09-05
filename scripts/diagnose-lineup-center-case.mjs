import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { createSupabaseNbaTeamDataset } from '../prototypes/basketball-lineup-optimizer/supabase-nba-data.js';
import { DEFAULT_PRESETS } from '../prototypes/basketball-lineup-optimizer/optimizer-config.js';
import { loadOptimizerCore } from '../prototypes/basketball-lineup-optimizer/tests/load-optimizer-core.mjs';

// Read-only, opt-in reproduction for the Gobert/Beringer report. It uses the
// same public SDK, shared reader, adapter, and optimizer as the page. No env
// credentials, commerce session, Scout archive, or database mutations are used.
if (!process.argv.includes('--live')) throw new Error('Use --live to read the public 2025-26 MIN pool.');
const document = { currentScript: { src: 'http://127.0.0.1/vendor/supabase.min.js', tagName: 'SCRIPT' },
  scripts: [], getElementsByTagName: () => [], addEventListener() {} };
// The bundled browser SDK's webpack loader needs a script URL, even though
// this diagnostic does not fetch chunks or initialize an authenticated user.
globalThis.self = globalThis;
globalThis.document = document;
const sdk = createRequire(import.meta.url)('../vendor/supabase.min.js');
delete globalThis.document;
delete globalThis.self;
const window = { DJ: {}, location: { origin: 'http://127.0.0.1', href: 'http://127.0.0.1/lineup-lab/' },
  addEventListener() {}, setTimeout, clearTimeout };
const context = vm.createContext({ window, document, URL, console, setTimeout, clearTimeout });
vm.runInContext(fs.readFileSync(new URL('../backend-config.js', import.meta.url), 'utf8'), context);
const nbaOrigin = new URL(window.DJ_BACKEND_CONFIG.analyticsSupabaseUrl).origin;
const allowedTables = new Set(['/rest/v1/nba_lineup_player_pool', '/rest/v1/nba_player_team_season_stats']);
const requests = [];
window.supabase = { createClient(url, key, options) {
  if (url !== nbaOrigin) throw new Error('Diagnostic cannot connect to the commerce project.');
  return sdk.createClient(url, key, { ...options, global: { fetch: async (input, init = {}) => {
    const target = new URL(input);
    if ((init.method || 'GET') !== 'GET' || target.origin !== nbaOrigin
        || !allowedTables.has(target.pathname)) throw new Error('Only the two reviewed public NBA SELECTs are allowed.');
    const response = await fetch(input, { ...init, signal: AbortSignal.timeout(20000) });
    requests.push({ path: target.pathname, status: response.status });
    return response;
  } } });
} };
document.currentScript = { src: 'http://127.0.0.1/supabase-client.js', tagName: 'SCRIPT' };
vm.runInContext(fs.readFileSync(new URL('../supabase-client.js', import.meta.url), 'utf8'), context);
const scope = { seasonEndYear: 2026, seasonPhase: 'regular' };
const catalog = window.DJ.remoteCatalog;
const rows = await catalog.listNbaTeamSeasonPlayers({ ...scope, teamCode: 'MIN' });
const seasonEvidenceRows = await catalog.listNbaPlayerSeasonEvidence({ ...scope, playerIds: rows.map(row => row.player_id) });
const dataset = evidence => createSupabaseNbaTeamDataset(rows, {
  team: 'MIN', season: 2026, seasonPhase: 'regular', seasonEvidenceRows: evidence,
});
const actual = dataset(seasonEvidenceRows), fallback = dataset([]);
const { optimizeLineups } = await loadOptimizerCore();
const centers = actual.players.filter(player => ['Rudy Gobert', 'Joan Beringer'].includes(player.name));
if (centers.length !== 2) throw new Error('The expected center pair was not found.');
const teammates = ['Anthony Edwards', 'Donte DiVincenzo', 'Julius Randle', 'Jaden McDaniels',
  'Bones Hyland', 'Ayo Dosunmu', 'Kyle Anderson'];
const rosterNames = [...teammates, ...centers.map(player => player.name)];
const lockedIds = actual.players.filter(player => rosterNames.includes(player.name)).map(player => player.id);
if (lockedIds.length !== 9) throw new Error('The controlled nine-player roster is incomplete.');
const cases = [];
const centersOnly = process.argv.includes('--centers-only');
const objectives = { balanced: DEFAULT_PRESETS.balanced, offense: DEFAULT_PRESETS.scoring,
  defense: DEFAULT_PRESETS.defense, rebounding: DEFAULT_PRESETS.rebounding,
  reboundsOnly: { rebounds: 100 }, blocksOnly: { blocks: 100 }, defenseImpactOnly: { defensiveImpact: 100 } };
for (const variant of ['raw', 'approximate-samples', 'actual-samples', 'uncalibrated-assumptions']) {
  for (const [objective, weights] of Object.entries(objectives)) {
    const inputPlayers = variant === 'approximate-samples' ? fallback.players : actual.players;
    // Optional counterfactual: give both players the same C-only eligibility.
    // This isolates rate valuation from Beringer's imported F/C flexibility;
    // it is diagnostic input only and never edits the database position record.
    const players = centersOnly ? inputPlayers.map(player => centers.some(center => center.id === player.id)
      ? { ...player, positions: ['C'] } : player) : inputPlayers;
    // Holding the same nine players fixed isolates minute valuation from the
    // combinatorial choice of teammates. Percentiles still use the full pool.
    // Eligibility is deliberately opened to include Beringer's sub-8 MPG row.
    const result = optimizeLineups(players, { mode: 'rotation', size: 9, alternatives: 1,
      minGames: 0, minMinutes: 0, lockedIds, weights,
      sourceScope: variant === 'uncalibrated-assumptions' ? null : scope,
      rotationOptions: { minMinutes: 8, maxMinutes: 40, minutePlan: 'openWhatIf',
        scoringBasis: 'per36', rateStability: variant === 'raw' ? 'raw' : 'sampleAdjusted',
        roleBalance: 'off', positionMinuteRequirements: { G: 96, F: 96, C: 48 } } });
    if (!result.ok) throw new Error(`${variant}/${objective}: ${JSON.stringify(result.reasons)}`);
    cases.push({ variant, objective, minutes: Object.fromEntries(centers.map(player =>
      [player.name, result.best.rotation.byId[player.id]])),
      weights: result.weights,
      contributions: Object.fromEntries(centers.map(player => [player.name, result.best.playerContributions[player.id]])),
      totalMinutes: result.best.rotation.totalMinutes });
  }
}
const source = centers.map(player => ({ name: player.name, id: player.id, positions: player.positions,
  seasonListed: player.positionEvidence?.seasonListed, games: player.games, mpg: player.minutes,
  totals: player.analytics.totals, seasonTotals: player.analytics.seasonTotals,
  per36: Object.fromEntries(['points','rebounds','assists','steals','blocks','turnovers'].map(metric =>
    [metric, player[metric] * 36 / player.minutes])),
  foulsPer36: player.analytics.totals.personalFouls * 36 / player.analytics.totals.minutes,
  efgPct: player.efgPct, advanced: player.analytics.advanced,
}));
console.log(JSON.stringify({ centersOnly, source, requests, cases: process.argv.includes('--details') ? cases :
  cases.map(({variant,objective,minutes,totalMinutes}) => ({variant,objective,minutes,totalMinutes})),
  caveats: ['Controlled fixed roster, not a reconstruction of the user\'s unknown prior settings.',
    'Uncalibrated assumptions are a sensitivity check, not an exact historical release.',
    'Current default 8-MPG eligibility excludes Beringer; this reproduction explicitly includes him.',
    'Historical model only. No private Scout coefficient was loaded.'] }, null, 2));
