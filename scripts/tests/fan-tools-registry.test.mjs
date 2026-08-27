import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { filterRegistry } from '../../tools/fan-tools.js';
import { TOOL_REGISTRY, TOOL_STATUSES } from '../../tools/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('fan tool registry has unique, complete metadata', () => {
  const ids = TOOL_REGISTRY.map((tool) => tool.id);
  assert.equal(new Set(ids).size, ids.length);

  TOOL_REGISTRY.forEach((tool) => {
    assert.match(tool.id, /^[a-z0-9-]+$/);
    assert.ok(['tool', 'game'].includes(tool.kind));
    assert.ok(Object.values(TOOL_STATUSES).includes(tool.status));
    assert.ok(tool.summary.length > 20);
    assert.ok(tool.capabilities.length > 0);
    assert.ok(tool.dependencies.length > 0);
    assert.ok(tool.implementationNotes.length > 20);

    if (tool.status === TOOL_STATUSES.LIVE) {
      assert.ok(tool.href, `${tool.id} is live but has no route`);
      assert.ok(fs.existsSync(path.resolve(root, 'tools', tool.href)), `${tool.id} route does not exist`);
    } else {
      assert.equal(tool.href, null, `${tool.id} is not live but exposes a route`);
    }
  });
});

test('fan tools page keeps the roadmap isolated and accessible', () => {
  const html = fs.readFileSync(path.join(root, 'tools', 'index.html'), 'utf8');
  assert.match(html, /data-page="fan-tools"/);
  assert.match(html, /(?:name="robots"[^>]+content="noindex,follow|content="noindex,follow[^>]+name="robots")/i);
  assert.match(html, /id="toolsGrid"/);
  assert.match(html, /type="module"[^>]+fan-tools\.js/);
  assert.match(html, /href="\/tools\/"[^>]+data-fan-tools-link="true"|data-fan-tools-link="true"[^>]+href="\/tools\/"/);
});

test('fan tool filters preserve registry order and status boundaries', () => {
  assert.deepEqual(filterRegistry('all'), TOOL_REGISTRY);
  assert.deepEqual(
    filterRegistry(TOOL_STATUSES.LIVE).map((tool) => tool.id),
    ['lineup-lab']
  );
  assert.equal(filterRegistry(TOOL_STATUSES.PLANNED).length, 4);
  assert.equal(filterRegistry(TOOL_STATUSES.RESEARCH).length, 1);
});
