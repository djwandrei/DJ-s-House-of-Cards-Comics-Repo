import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { filterPlayableTools } from '../../tools/fan-tools.js';

test('play filters never launch planned or research-gated tools', () => {
  assert.equal(filterPlayableTools().length, 5);
  assert.deepEqual(filterPlayableTools('games').map(tool => tool.id), ['fix-the-five', 'draft-night']);
  assert.equal(filterPlayableTools('tools').length, 3);
  assert.ok(filterPlayableTools().every(tool => tool.status === 'live' && tool.href));
});

test('game progression shares focus and local next-play links without changing scores', async () => {
  const helper = await readFile(new URL('../../tools/fan-journey.js', import.meta.url), 'utf8');
  assert.match(helper, /prefers-reduced-motion/);
  assert.match(helper, /preventScroll: true/);
  assert.doesNotMatch(helper, /fetch\(|localStorage|invokeFunction|innerHTML/);
  for (const [folder, entry] of [['draft-night', 'scout-draft-night.js'], ['fix-the-five', 'scout-fix-the-five.js']]) {
    const source = await readFile(new URL(`../../tools/${folder}/${entry}`, import.meta.url), 'utf8');
    assert.match(source, /createNextPlay\(GAME_KIND\)/);
    assert.match(source, /aria-current', 'step'/);
    assert.match(source, /focusGameStage\(document.getElementById/);
  }
});
