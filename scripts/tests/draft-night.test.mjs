import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildDraftNightDeck,
  hasLegalPositionAssignment,
  validateDraftNightDecks,
} from '../../tools/fix-the-five/game-engine.js';
import { DRAFT_NIGHT_DECKS } from '../../tools/draft-night/decks.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const roster = JSON.parse(fs.readFileSync(
  path.join(root, 'lineup-lab', 'fixtures', 'timberwolves-2021-22.json'),
  'utf8',
)).players;

test('Draft Night ships five reviewed decks with fully legal published boards', () => {
  const results = validateDraftNightDecks(DRAFT_NIGHT_DECKS, roster);
  assert.equal(results.length, 5);

  results.forEach((result) => {
    assert.equal(result.combinations.length, 243);
    assert.equal(result.best.roundScore, 100);
    assert.equal(result.best.isBest, true);
    assert.match(result.evidence, /published historical draft board/i);
    result.combinations.forEach((outcome) => {
      assert.equal(outcome.legal, true);
      assert.equal(outcome.selectionIds.length, 5);
      assert.equal(new Set(outcome.selectionIds).size, 5);
      assert.ok(outcome.roundScore >= 0 && outcome.roundScore <= 100);
      assert.equal(
        hasLegalPositionAssignment(outcome.selected, result.deck.positionMinimums),
        true,
      );
    });
  });
});

test('Draft Night seeds select a stable reviewed board and explicit deck IDs remain valid', () => {
  const first = buildDraftNightDeck(DRAFT_NIGHT_DECKS, '2026-09-05');
  const repeat = buildDraftNightDeck(DRAFT_NIGHT_DECKS, '2026-09-05');
  assert.equal(first.id, repeat.id);
  assert.ok(DRAFT_NIGHT_DECKS.some((deck) => deck.id === first.id));
});

test('Draft Night page retains its source and scoring disclosures', () => {
  const html = fs.readFileSync(path.join(root, 'tools', 'draft-night', 'index.html'), 'utf8');
  assert.match(html, /data-page="fan-tools"/);
  assert.match(html, /id="draftPanel"/);
  assert.match(html, /id="draftProgress"/);
  assert.match(html, /Read the full scoring contract/);
  assert.match(html, /243-path board/);
  assert.match(html, /type="module"[^>]+draft-night\.js/);
});
