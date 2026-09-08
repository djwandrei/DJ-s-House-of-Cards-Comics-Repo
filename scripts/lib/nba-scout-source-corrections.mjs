import assert from 'node:assert/strict';
import { BOX_FIELDS } from './nba-summary-completeness.mjs';

export const SOURCE_CORRECTIONS_VERSION = 'nba_user_source_corrections_v1';

/** An operator correction is evidence of a decision, not an official stat.
 * Bind it to exact source bytes and the original rejected value. Never change
 * archived Summary/PBP bytes or implement a global negative-count -> zero rule.
 */
export function validateSourceCorrections(ledger) {
  assert.equal(ledger?.version, SOURCE_CORRECTIONS_VERSION);
  assert.ok(Array.isArray(ledger.entries));
  const seen = new Set();
  for (const row of ledger.entries) {
    assert.ok(typeof row.id === 'string' && row.id && !seen.has(row.id)); seen.add(row.id);
    assert.ok(['gameId', 'playerId', 'teamId', 'reason', 'authorization'].every(key => typeof row[key] === 'string' && row[key].trim()));
    assert.equal(row.authorization, 'explicit-user-request');
    assert.ok(Number.isInteger(row.seasonStartYear) && BOX_FIELDS.includes(row.field));
    assert.ok(Number.isFinite(row.originalValue) && Number.isSafeInteger(row.correctedValue) && row.correctedValue >= 0);
    for (const key of ['sourceGzipSha256', 'summaryOverlaySha256']) assert.match(row[key], /^[a-f0-9]{64}$/);
    const identity = `${row.gameId}~${row.teamId}~${row.playerId}~${row.field}`;
    assert.ok(!seen.has(identity), 'Duplicate field correction.'); seen.add(identity);
  }
  return ledger.entries;
}

export function correctionsForGame(entries, game, sourceGzipSha256, summaryOverlaySha256) {
  return entries.filter(row => row.gameId === game.providerGameId).map(row => {
    assert.equal(row.seasonStartYear, game.seasonStartYear);
    assert.equal(row.sourceGzipSha256, sourceGzipSha256, 'Correction source hash changed.');
    assert.equal(row.summaryOverlaySha256, summaryOverlaySha256, 'Correction Summary hash changed.');
    return row;
  });
}

export function correctedBox(official, summary, corrections, { playerId, teamId }) {
  const applied = corrections.filter(row => row.playerId === playerId && row.teamId === teamId);
  const effective = { ...official };
  for (const row of applied) {
    const source = summary?.officialBoxScore;
    assert.equal(source?.source, 'summary_endpoint');
    const original = Object.hasOwn(source.rejectedValues ?? {}, row.field)
      ? source.rejectedValues[row.field] : source.fields?.[row.field];
    assert.equal(original, row.originalValue, 'Original provider value no longer matches the authorized correction.');
    effective[row.field] = row.correctedValue;
  }
  return { effective, applied: applied.map(row => ({ ...row, independentlyVerified: false })) };
}
