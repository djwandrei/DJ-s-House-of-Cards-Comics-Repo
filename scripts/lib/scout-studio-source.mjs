import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readReadinessMetadata } from '../audit-lineup-scout-readiness.mjs';
import { assessLineupScoutReadiness } from './lineup-scout-readiness.mjs';
import { streamTeamShardJson } from '../validate-local-scout-analytics.mjs';
import { describeScoutPlayer, describeScoutCombination, describeScoutWowy } from './scout-studio.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const keyFor = ids => [...ids].sort().join('|');
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

// Read-only, one-team cache; never crawl for a "latest" package or substitute
// v10 while the explicitly requested four-season output is still being built.
export function createScoutStudioSource(options) {
  let snapshot = null, cachedTeam = null, loading = false;
  async function inspect() {
    const [manifest, validation, source] = await Promise.all([
      readReadinessMetadata(options.manifest), readReadinessMetadata(options.packageValidation),
      readReadinessMetadata(options.sourceValidation),
    ]);
    const readiness = assessLineupScoutReadiness({ manifest: manifest.data, manifestSha256: manifest.sha256,
      packageValidation: validation.data, sourceValidation: source.data, sourceValidationSha256: source.sha256,
      expectedSeasonStartYears: options.seasons });
    const token = manifest.sha256 ? `s${digest(`studio-v1:${manifest.sha256}`).slice(0, 24)}` : null;
    if (snapshot?.token !== token || !readiness.readyForIntegrationReview) cachedTeam = null;
    const descriptors = readiness.readyForIntegrationReview ? manifest.data.dataShards : [];
    if (!Array.isArray(descriptors) || (readiness.readyForIntegrationReview && descriptors.length !== 30)) {
      throw new Error('The validated package does not have its expected team shards.');
    }
    snapshot = { token, manifest: manifest.data, readiness,
      descriptors: [...descriptors].sort((a, b) => a.team.localeCompare(b.team)) };
    return { phase: readiness.readyForIntegrationReview ? 'ready' : readiness.status, snapshot: token,
      source: { label: 'Incoming four-season Scout package', seasons: options.seasons.map(year => `${year}–${String(year + 1).slice(-2)}`),
        aggregation: 'Team-specific pooled totals across the entire window; not single-season statistics.',
        phases: readiness.readyForIntegrationReview ? manifest.data.scope.includedPhases : [],
        caveat: 'Validated metadata permits local integration review only. Player coverage and sample gates still apply.' },
      missing: readiness.pending.map(item => item.split(' ')[0]),
      issues: readiness.errors, warnings: readiness.warnings,
      teams: snapshot.descriptors.map((descriptor, index) => ({ id: `t${index}`, name: descriptor.team })) };
  }

  async function loadTeam(teamId, token) {
    const state = await inspect();
    if (state.phase !== 'ready' || token !== state.snapshot) throw new Error('Refresh the validated package selection.');
    if (!/^t\d+$/.test(teamId)) throw new Error('Choose a listed team.');
    const descriptor = snapshot.descriptors[Number(teamId.slice(1))];
    if (!descriptor) throw new Error('Choose a listed team.');
    if (cachedTeam?.id === teamId && cachedTeam.token === token) {
      const currentPath = await fs.realpath(cachedTeam.file);
      const current = await fs.stat(currentPath);
      if (currentPath !== cachedTeam.file || current.size !== cachedTeam.size || current.mtimeMs !== cachedTeam.mtimeMs) {
        cachedTeam = null;
        throw new Error('Previously read shard changed. Revalidate before using it.');
      }
      return cachedTeam;
    }
    if (loading) throw new Error('A team is already being read. Try again when it finishes.');
    loading = true;
    try {
      const archiveRoot = await fs.realpath(path.dirname(options.manifest));
      const file = await fs.realpath(path.resolve(archiveRoot, descriptor.jsonPath));
      if (!inside(archiveRoot, file)) throw new Error('Shard is outside the selected package.');
      const before = await fs.stat(file);
      if (!before.isFile() || before.size !== descriptor.jsonBytes || !/^[a-f0-9]{64}$/.test(descriptor.jsonSha256)) {
        throw new Error('Shard size or digest contract differs from the validated package.');
      }
      const hash = createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      if (hash.digest('hex') !== descriptor.jsonSha256) throw new Error('Shard digest differs from the validated package.');
      const players = new Map(), combinations = new Map(), wowy = new Map();
      let seenTeam = false, items = 0;
      const counts = { lineupsAndCombinations: 0, playerOnOff: 0, playerProfiles: 0, wowy: 0 };
      const { seenFields } = await streamTeamShardJson(file, {
        maxBufferedValueBytes: 32 * 1024 * 1024,
        onHeader(field, value) {
          if (field === 'team') {
            if (value.teamId !== descriptor.teamId || value.team !== descriptor.team) throw new Error('Shard team identity differs.');
            seenTeam = true;
          }
          if (field === 'seasonStartYears' && JSON.stringify(value) !== JSON.stringify(options.seasons)) throw new Error('Shard season scope differs.');
          const expected = { schemaVersion: 4, metricsVersion: 'nba-scout-metrics-v4', seasonStartYear: 2022, seasonEndYear: 2026, latestSeasonStartYear: 2025 };
          if (Object.hasOwn(expected, field) && value !== expected[field]) throw new Error('Shard version or season scope differs.');
        },
        onArrayItem(field, index, row) {
          if (++items > 200000) throw new Error('Team exceeds the bounded preview item limit.');
          if (field in counts) counts[field]++;
          if (row.teamId !== descriptor.teamId) throw new Error('Shard row belongs to a different team.');
          if (field === 'playerProfiles') {
            if (players.has(row.playerId)) throw new Error('Duplicate player profile.');
            players.set(row.playerId, describeScoutPlayer(row, `p${index}`));
          } else if (field === 'lineupsAndCombinations' && row.size >= 2 && row.size <= 5) {
            if (!Array.isArray(row.playerIds) || row.playerIds.length !== row.size || new Set(row.playerIds).size !== row.size) throw new Error('Invalid combination membership.');
            const key = keyFor(row.playerIds);
            if (combinations.has(key)) throw new Error('Duplicate combination.');
            combinations.set(key, describeScoutCombination(row));
          } else if (field === 'wowy') {
            const key = keyFor([row.playerAId, row.playerBId]);
            if (wowy.has(key)) throw new Error('Duplicate WOWY pair.');
            wowy.set(key, { first: row.playerAId, second: row.playerBId, cells: describeScoutWowy(row) });
          }
        },
      });
      const after = await fs.stat(file);
      const requiredFields = ['schemaVersion', 'metricsVersion', 'seasonStartYear', 'seasonEndYear', 'seasonStartYears', 'latestSeasonStartYear', 'team', ...Object.keys(counts)];
      if (!seenTeam || requiredFields.some(field => !seenFields.includes(field)) || before.size !== after.size || before.mtimeMs !== after.mtimeMs
        || Object.entries(counts).some(([field, count]) => count !== descriptor.rows[field])) {
        throw new Error('Shard changed or row reconciliation failed during preview read.');
      }
      // Only compact, allowlisted views survive the stream; raw rows do not.
      cachedTeam = { id: teamId, token, players, combinations, wowy, file, size: after.size, mtimeMs: after.mtimeMs };
      return cachedTeam;
    } finally { loading = false; }
  }

  return {
    status: inspect,
    async roster(teamId, token) {
      const team = await loadTeam(teamId, token);
      return { snapshot: token, team: teamId, players: [...team.players.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    async chemistry(teamId, token, ids) {
      if (!Array.isArray(ids) || ids.length < 2 || ids.length > 5 || new Set(ids).size !== ids.length) throw new Error('Choose two through five distinct players.');
      const team = await loadTeam(teamId, token);
      const providerByPublic = new Map([...team.players].map(([providerId, player]) => [player.id, providerId]));
      const selected = ids.map(id => providerByPublic.get(id));
      if (selected.some(id => !id)) throw new Error('Choose players from this team and package.');
      const pair = ids.length === 2 ? team.wowy.get(keyFor(selected)) : null;
      const wowy = pair ? pair.cells.map(cell => ({ ...cell,
        label: cell.key === 'a_on_b_off' ? `${team.players.get(pair.first).name} only`
          : cell.key === 'a_off_b_on' ? `${team.players.get(pair.second).name} only` : cell.label })) : [];
      return { snapshot: token, selection: ids, combination: team.combinations.get(keyFor(selected)) || null, wowy,
        note: 'Observed together/apart samples are not adjusted teammate effects. No invented Synergy Score or unseen-combination bonus is used.' };
    },
  };
}
