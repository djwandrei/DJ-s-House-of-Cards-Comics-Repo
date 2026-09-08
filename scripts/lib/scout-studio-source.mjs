import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import path from 'node:path';
import { readReadinessMetadata } from '../audit-lineup-scout-readiness.mjs';
import { assessLineupScoutReadiness } from './lineup-scout-readiness.mjs';
import { streamTeamShardJson } from '../validate-local-scout-analytics.mjs';
import { describeScoutPlayer, describeScoutSeasonProfile, describeScoutCombination, describeScoutOnOff, describeScoutTeamContexts, describeScoutWowy } from './scout-studio.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const keyFor = ids => [...ids].sort().join('|');
const inside = (root, target) => { const relative = path.relative(root, target); return relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };

// Read-only, one-team cache; never crawl for a "latest" package or substitute
// v10 when the explicitly selected Scout output is unavailable.
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
    let modelEvidence = null;
    try {
      const modelDir = path.resolve(path.dirname(options.manifest), 'model-evidence');
      const capabilities = await readReadinessMetadata(path.join(modelDir, '..', 'model-evidence-capabilities.json'));
      const evidenceValidation = await readReadinessMetadata(path.join(modelDir, '..', 'model-evidence-validation.json'));
      if (capabilities.data && evidenceValidation.data?.passed === true) {
        modelEvidence = { capabilities: capabilities.data, validation: {
          passed: true, generatedAt: evidenceValidation.data.generatedAt,
          coverage: evidenceValidation.data.coverage,
        } };
      }
    } catch { /* v1 packages have no additive evidence directory */ }
    snapshot = { token, manifest: manifest.data, readiness, modelEvidence,
      descriptors: [...descriptors].sort((a, b) => a.team.localeCompare(b.team)) };
    return { phase: readiness.readyForIntegrationReview ? 'ready' : readiness.status, snapshot: token,
      source: { label: 'Selected Scout package', seasonStartYears: [...options.seasons], seasons: options.seasons.map(year => `${year}–${String(year + 1).slice(-2)}`),
        aggregation: modelEvidence
          ? 'Base player totals are team-specific and pooled across the window; the validated additive table supplies observed season/phase rows and all-team aggregates.'
          : 'Team-specific pooled totals across the entire window; not single-season statistics.',
        phases: readiness.readyForIntegrationReview ? manifest.data.scope.includedPhases : [],
        caveat: 'Validated metadata permits local integration review only. Player coverage and sample gates still apply.' },
      missing: readiness.pending.map(item => item.split(' ')[0]),
      issues: readiness.errors, warnings: readiness.warnings, modelEvidence: snapshot.modelEvidence ? {
        version: snapshot.modelEvidence.capabilities?.version || 'nba_scout_application_evidence_v1',
        added: snapshot.modelEvidence.capabilities?.added || {},
        validation: snapshot.modelEvidence.validation,
      } : null,
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
    // Release the old team's groups before streaming a replacement shard.
    cachedTeam = null;
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
      const players = new Map(), onOff = new Map(), combinations = new Map(), wowy = new Map(), seasonProfiles = new Map();
      let seenTeam = false, items = 0, teamContexts = [];
      const counts = { lineupsAndCombinations: 0, playerOnOff: 0, playerProfiles: 0, wowy: 0 };
      const { seenFields } = await streamTeamShardJson(file, {
        maxBufferedValueBytes: 32 * 1024 * 1024,
        onHeader(field, value) {
          if (field === 'team') {
            if (value.teamId !== descriptor.teamId || value.team !== descriptor.team) throw new Error('Shard team identity differs.');
            teamContexts = describeScoutTeamContexts(value);
            seenTeam = true;
          }
          if (field === 'seasonStartYears' && JSON.stringify(value) !== JSON.stringify(options.seasons)) throw new Error('Shard season scope differs.');
          const expected = { schemaVersion: 4, metricsVersion: 'nba-scout-metrics-v4', seasonStartYear: options.seasons[0],
            seasonEndYear: options.seasons.at(-1) + 1, latestSeasonStartYear: options.seasons.at(-1) };
          if (Object.hasOwn(expected, field) && value !== expected[field]) throw new Error('Shard version or season scope differs.');
        },
        onArrayItem(field, index, row) {
          if (++items > 200000) throw new Error('Team exceeds the bounded preview item limit.');
          if (field in counts) counts[field]++;
          if (row.teamId !== descriptor.teamId) throw new Error('Shard row belongs to a different team.');
          if (field === 'playerOnOff') {
            if (typeof row.playerId !== 'string' || !row.playerId.trim()) throw new Error('Invalid player on/off identity.');
            if (onOff.has(row.playerId)) throw new Error('Duplicate player on/off row.');
            onOff.set(row.playerId, describeScoutOnOff(row));
          } else if (field === 'playerProfiles') {
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
      if (players.size !== onOff.size || [...players.keys()].some(playerId => !onOff.has(playerId))) {
        throw new Error('Player profile and on/off rows do not reconcile.');
      }
      // Read the compact season table only after the base shard has passed its
      // own hash and row checks. The v2 manifest supplies the path, size and
      // digest; a present-but-mismatched additive file is an error, not a
      // reason to silently fall back to pooled profiles.
      const evidenceDescriptor = snapshot.manifest.modelEvidence?.files?.playerSeasonSkillProfiles;
      try {
        const relativeEvidencePath = evidenceDescriptor?.path || 'model-evidence/playerSeasonSkillProfiles.jsonl.gz';
        const evidenceFile = path.resolve(archiveRoot, relativeEvidencePath);
        if (!inside(archiveRoot, evidenceFile)) throw new Error('Model-evidence file is outside the selected package.');
        const evidenceStat = await fs.stat(evidenceFile);
        if (!evidenceStat.isFile() || evidenceStat.size >= 64 * 1024 * 1024) throw new Error('Model-evidence file exceeds the bounded preview limit.');
        if (evidenceDescriptor && (evidenceStat.size !== evidenceDescriptor.gzipBytes || !/^[a-f0-9]{64}$/i.test(evidenceDescriptor.gzipSha256))) {
          throw new Error('Model-evidence file contract is invalid.');
        }
        if (evidenceDescriptor) {
          const evidenceHash = createHash('sha256');
          for await (const chunk of createReadStream(evidenceFile)) evidenceHash.update(chunk);
          if (evidenceHash.digest('hex') !== evidenceDescriptor.gzipSha256.toLowerCase()) throw new Error('Model-evidence digest differs from the validated package.');
        }
        const teamNames = new Map(snapshot.descriptors.map(item => [item.teamId, item.team]));
        const seenProfiles = new Map();
        const input = createReadStream(evidenceFile).pipe(createGunzip());
        const rl = readline.createInterface({ input, crlfDelay: Infinity });
        for await (const line of rl) {
          if (!line.trim()) continue;
          const row = JSON.parse(line);
          if (!players.has(row.playerId) || (row.teamId !== 'ALL_TEAMS' && !teamNames.has(row.teamId))) continue;
          const list = seasonProfiles.get(row.playerId) || [];
          const profile = describeScoutSeasonProfile(row);
          profile.team = row.teamId === 'ALL_TEAMS' ? 'All teams' : teamNames.get(row.teamId);
          profile.playerName = players.get(row.playerId).name;
          const key = `${profile.seasonStartYear}|${profile.phase}|${profile.team}|${profile.scope}`;
          const seen = seenProfiles.get(row.playerId) || new Set();
          if (seen.has(key)) throw new Error('Duplicate player-season profile in model evidence.');
          seen.add(key); seenProfiles.set(row.playerId, seen);
          if (list.length < 240) list.push(profile);
          seasonProfiles.set(row.playerId, list);
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        if (evidenceDescriptor) throw new Error('Validated model-evidence season table is missing.');
        // Older completed packages do not carry the additive table.
      }
      cachedTeam = { id: teamId, token, players, onOff, combinations, wowy, seasonProfiles, teamContexts, file, size: after.size, mtimeMs: after.mtimeMs };
      return cachedTeam;
    } finally { loading = false; }
  }

  return {
    status: inspect,
    // A release-only projection used by the static hosting builder.  It is
    // intentionally assembled from the same bounded maps as the local
    // preview, then rewrites every provider-keyed map to the opaque public
    // player ids before it leaves this module.  Raw shard rows and provider
    // identifiers never cross this boundary.
    async bundle(teamId, token) {
      const team = await loadTeam(teamId, token);
      const publicByProvider = new Map([...team.players].map(([providerId, player]) => [providerId, player.id]));
      const onOff = Object.fromEntries([...team.onOff.entries()].flatMap(([providerId, value]) => {
        const id = publicByProvider.get(providerId); return id ? [[id, value]] : [];
      }));
      const combinations = Object.fromEntries([...team.combinations.entries()].flatMap(([providerKey, value]) => {
        const ids = providerKey.split('|').map(providerId => publicByProvider.get(providerId));
        return ids.every(Boolean) ? [[keyFor(ids), value]] : [];
      }));
      const wowy = Object.fromEntries([...team.wowy.entries()].flatMap(([providerKey, value]) => {
        const ids = [publicByProvider.get(value.first), publicByProvider.get(value.second)];
        return ids.every(Boolean) ? [[keyFor(ids), { first: ids[0], second: ids[1], cells: value.cells }]] : [];
      }));
      const seasonProfiles = Object.fromEntries([...team.seasonProfiles.entries()].flatMap(([providerId, value]) => {
        const id = publicByProvider.get(providerId); return id ? [[id, value]] : [];
      }));
      return { snapshot: token, team: teamId,
        players: [...team.players.values()].sort((a, b) => a.name.localeCompare(b.name)),
        teamContexts: team.teamContexts, onOff, combinations, wowy, seasonProfiles };
    },
    async teamContexts(teamId, token) {
      const team = await loadTeam(teamId, token);
      return { snapshot: token, team: teamId, contexts: team.teamContexts };
    },
    async roster(teamId, token) {
      const team = await loadTeam(teamId, token);
      return { snapshot: token, team: teamId, players: [...team.players.values()].sort((a, b) => a.name.localeCompare(b.name)) };
    },
    async playerContexts(teamId, token, id) {
      if (!/^p\d{1,4}$/.test(id || '')) throw new Error('Choose a player from this team and package.');
      const team = await loadTeam(teamId, token);
      const providerId = [...team.players.entries()].find(([, player]) => player.id === id)?.[0];
      if (!providerId) throw new Error('Choose a player from this team and package.');
      const contexts = team.onOff.get(providerId);
      if (!contexts) return { snapshot: token, team: teamId, player: id, on: [], off: [], note: 'No player on/off context rows are available for this sample.' };
      return { snapshot: token, team: teamId, player: id, ...contexts };
    },
    async playerSeasons(teamId, token, id) {
      if (!/^p\d{1,4}$/.test(id || '')) throw new Error('Choose a player from this team and package.');
      const team = await loadTeam(teamId, token);
      const providerId = [...team.players.entries()].find(([, player]) => player.id === id)?.[0];
      if (!providerId) throw new Error('Choose a player from this team and package.');
      return { snapshot: token, team: teamId, player: id,
        profiles: (team.seasonProfiles.get(providerId) || []).sort((a, b) => (a.seasonStartYear || 0) - (b.seasonStartYear || 0) || String(a.phase).localeCompare(String(b.phase))),
        note: 'Season and phase rows are available only when the selected package includes additive model evidence. Missing seasons are not imputed.' };
    },
    async seasonDonors(teamId, token) {
      const team = await loadTeam(teamId, token);
      const profiles = [];
      for (const [providerId, rows] of team.seasonProfiles) {
        const player = team.players.get(providerId);
        if (!player) continue;
        for (const row of rows) profiles.push({ ...row, player: player.name,
          playerId: player.id,
          key: `${player.id}|${row.seasonStartYear}|${row.phase}|${row.team}|${row.scope}` });
      }
      if (profiles.length > 4000) throw new Error('Season donor catalog exceeds the bounded preview limit.');
      profiles.sort((a, b) => a.player.localeCompare(b.player) || (a.seasonStartYear || 0) - (b.seasonStartYear || 0)
        || String(a.phase).localeCompare(String(b.phase)) || String(a.team).localeCompare(String(b.team)));
      return { snapshot: token, team: teamId, profiles,
        note: 'Season donors are observed rows from this team roster and its all-team aggregates. A recipe combines descriptive components; it does not create a forecast, impact estimate or physically feasible player.' };
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
      const pairs = [];
      // At most ten lookups from the compact team cache; these samples overlap.
      if (ids.length > 2) for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const pair = team.combinations.get(keyFor([selected[a], selected[b]]));
        pairs.push({ selection: [ids[a], ids[b]], combination: pair ? { kind: pair.kind, sample: pair.sample } : null });
      }
      return { snapshot: token, team: teamId, selection: ids, combination: team.combinations.get(keyFor(selected)) || null, wowy, pairs,
        note: 'Observed together/apart samples are not adjusted teammate effects. No invented Synergy Score or unseen-combination bonus is used.' };
    },
  };
}
