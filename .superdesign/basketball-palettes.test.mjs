import test from 'node:test';
import assert from 'node:assert/strict';
import { palettes, paletteForTeam, themeFor, auditPalettes } from './basketball-palettes.mjs';

test('DJHC default and all 30 teams have unique stable identifiers and scheme names', () => {
  assert.equal(palettes.length, 31);
  assert.equal(palettes[0].id, 'djhc');
  for (const key of ['id', 'team', 'name']) assert.equal(new Set(palettes.map(row => row[key])).size, 31);
  assert.deepEqual(palettes.slice(1).map(row => row.id).sort(), 'atl bkn bos cha chi cle dal den det gsw hou ind lac lal mem mia mil min nop nyk okc orl phi phx por sac sas tor uta was'.split(' ').sort());
});

test('62 light/dark combinations meet the documented role-contrast policy', () => {
  const results = auditPalettes();
  assert.equal(results.length, 62);
  assert.deepEqual(results.filter(row => !row.passed), []);
});

test('all CSS tokens are valid hex, without mutating seed colors', () => {
  const snapshot = JSON.stringify(palettes);
  for (const palette of palettes) for (const mode of ['dark', 'light']) {
    for (const value of Object.values(themeFor(palette, mode))) assert.match(value, /^#[0-9A-F]{6}$/);
  }
  assert.equal(JSON.stringify(palettes), snapshot);
});

test('defaults are dark and changing the palette cannot change the dataset', () => {
  for (const palette of palettes) {
    assert.deepEqual(themeFor(palette), themeFor(palette, 'dark'));
    assert.deepEqual(Object.keys(themeFor(palette)), Object.keys(themeFor(palettes[0])));
    assert.ok(!('roster' in themeFor(palette)));
    assert.ok(!('score' in themeFor(palette)));
  }
});

test('every selected team maps to its scheme; missing or unsupported teams use DJHC', () => {
  for (const palette of palettes.slice(1)) {
    assert.equal(paletteForTeam(palette.id), palette);
    assert.equal(paletteForTeam(` ${palette.id.toUpperCase()} `), palette);
  }
  for (const missing of ['', null, undefined, 'unknown', 'SEA', {}, 42]) {
    assert.equal(paletteForTeam(missing).id, 'djhc');
  }
});
