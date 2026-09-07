import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('Draft Night live page uses the validation-gated Scout client and source disclosures', () => {
  const html = fs.readFileSync(path.join(root, 'tools', 'draft-night', 'index.html'), 'utf8');
  assert.match(html, /data-page="fan-tools"/);
  assert.match(html, /id="draftPanel"/);
  assert.match(html, /id="draftProgress"/);
  assert.match(html, /Board terms and scoring boundary/);
  assert.match(html, /243 legal paths/);
  assert.match(html, /supabase-client\.js/);
  assert.match(html, /type="module"[^>]+scout-draft-night\.js/);
  assert.doesNotMatch(html, /type="module"[^>]+src="\.\/draft-night\.js/);
});
