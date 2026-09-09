import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { countRegistryByStatus, filterRegistry, formatToolsStatus } from '../../tools/fan-tools.js';
import { TOOL_REGISTRY, TOOL_STATUSES } from '../../tools/registry.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

test('fan tool registry has unique, complete metadata', () => {
  const ids = TOOL_REGISTRY.map((tool) => tool.id);
  assert.equal(new Set(ids).size, ids.length);

  TOOL_REGISTRY.forEach((tool) => {
    assert.match(tool.id, /^[a-z0-9-]+$/);
    assert.ok(['tool', 'game'].includes(tool.kind));
    assert.match(tool.marker, /^[A-Za-z0-9 ]{2,8}$/);
    assert.ok(Object.values(TOOL_STATUSES).includes(tool.status));
    assert.ok(tool.summary.length > 20);
    assert.ok(tool.capabilities.length > 0);
    assert.ok(tool.dependencies.length > 0);
    assert.ok(tool.implementationNotes.length > 20);

    if (tool.href) {
      const routeUrl = new URL(tool.href, 'https://local.djhc.test/tools/');
      assert.equal(routeUrl.origin, 'https://local.djhc.test', `${tool.id} route must remain local`);
      const routePath = path.resolve(root, decodeURIComponent(routeUrl.pathname).replace(/^\/+/, ''));
      const relativeRoute = path.relative(root, routePath);
      assert.ok(relativeRoute && !relativeRoute.startsWith('..') && !path.isAbsolute(relativeRoute), `${tool.id} route escapes the site root`);
      const routeEntry = fs.statSync(routePath).isDirectory() ? path.join(routePath, 'index.html') : routePath;
      assert.ok(fs.existsSync(routeEntry) && fs.statSync(routeEntry).isFile(), `${tool.id} route has no page entry file`);

      if (routeUrl.pathname === '/tools/workshop/') {
        assert.equal(routeUrl.searchParams.get('experience'), tool.id, `${tool.id} workshop route must identify its experience`);
        assert.equal(tool.launchLabel, 'Preview setup', `${tool.id} workshop route needs an honest launch label`);
      }
      if (tool.status !== TOOL_STATUSES.LIVE) {
        assert.equal(tool.status, TOOL_STATUSES.PLANNED, `${tool.id} non-live route must be a planned framework`);
        assert.equal(routeUrl.pathname, '/tools/workshop/', `${tool.id} planned route must use the local workshop`);
        assert.equal(tool.launchLabel, 'Preview setup', `${tool.id} planned route needs an honest launch label`);
      }
    } else if (tool.status === TOOL_STATUSES.LIVE) {
      assert.fail(`${tool.id} is live but has no route`);
    } else {
      assert.equal(tool.href, null, `${tool.id} is not live but exposes a route`);
    }
  });
});

test('fan tools page keeps the roadmap isolated and accessible', () => {
  const html = fs.readFileSync(path.join(root, 'tools', 'index.html'), 'utf8');
  assert.match(html, /data-page="fan-tools"/);
  assert.match(html, /(?:name="robots"[^>]+content="noindex,follow|content="noindex,follow[^>]+name="robots")/i);
  assert.match(html, /id="toolsFeatured"/);
  assert.match(html, /id="playNow"/);
  assert.match(html, /id="toolsLiveSpotlight"/);
  assert.match(html, /type="module"[^>]+fan-tools\.js/);
  assert.match(html, /href="\/tools\/"[^>]+data-fan-tools-link="true"|data-fan-tools-link="true"[^>]+href="\/tools\/"/);
});

test('fan tools stylesheet asset URLs resolve from the nested tools directory', () => {
  const stylesheetPath = path.join(root, 'tools', 'fan-tools.css');
  const stylesheet = fs.readFileSync(stylesheetPath, 'utf8');
  const localAssetUrls = Array.from(stylesheet.matchAll(/url\(["']?([^"')]+)["']?\)/g), (match) => match[1])
    .filter((url) => !/^(?:data:|https?:|#)/i.test(url));

  assert.ok(localAssetUrls.length > 0, 'fan tools stylesheet has no local asset URLs to verify');
  localAssetUrls.forEach((url) => {
    const assetPath = path.resolve(path.dirname(stylesheetPath), url.split(/[?#]/, 1)[0]);
    assert.ok(fs.existsSync(assetPath), `fan tools stylesheet asset does not exist: ${url}`);
  });
});

test('fan tool filters preserve registry order and status boundaries', () => {
  assert.deepEqual(filterRegistry('all'), TOOL_REGISTRY);
  assert.deepEqual(
    filterRegistry(TOOL_STATUSES.LIVE).map((tool) => tool.id),
    ['lineup-lab', 'lineup-dna', 'fix-the-five', 'draft-night', 'card-matchup-explorer', 'scout-studio']
  );
  assert.equal(filterRegistry(TOOL_STATUSES.PLANNED).length, 6);
  assert.equal(filterRegistry(TOOL_STATUSES.RESEARCH).length, 4);
  assert.equal(formatToolsStatus('all', TOOL_REGISTRY.length), `Showing ${TOOL_REGISTRY.length} fan tools.`);
  assert.equal(formatToolsStatus(TOOL_STATUSES.LIVE, 1), 'Showing 1 live fan tool.');
  assert.equal(formatToolsStatus(TOOL_STATUSES.PLANNED, 6), 'Showing 6 planned fan tools.');
});

test('fan tool status summary is derived from the registry', () => {
  assert.deepEqual(countRegistryByStatus(), {
    [TOOL_STATUSES.LIVE]: 6,
    [TOOL_STATUSES.PLANNED]: 6,
    [TOOL_STATUSES.RESEARCH]: 4
  });
});

test('retired tool definitions and registry dependencies use the current cache revision', () => {
  const core = fs.readFileSync(path.join(root, 'core.js'), 'utf8');
  const version = core.match(/PRODUCT_ASSET_VERSION\s*=\s*'([^']+)'/)[1];
  for (const [file, dependencies] of [
    ['tools/fan-tools.js', ['./registry.js']],
    ['tools/workshop/tool-workshop.js', ['../registry.js', './definitions.js', './workshop-state.js']],
    ['tools/workshop/workshop-state.js', ['./definitions.js']]
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    for (const dependency of dependencies) assert.ok(source.includes(`'${dependency}?v=${version}'`), `${file}: stale ${dependency}`);
  }
});
