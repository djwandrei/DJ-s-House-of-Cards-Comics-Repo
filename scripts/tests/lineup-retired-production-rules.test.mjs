import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const SOURCE_ROOT = new URL('../../prototypes/basketball-lineup-optimizer/', import.meta.url);

function functionBody(source, name, nextName) {
  const start = source.indexOf(`function ${name}()`);
  const end = source.indexOf(`function ${nextName}(`, start);
  assert.notEqual(start, -1, `${name} is present`);
  assert.notEqual(end, -1, `${nextName} follows ${name}`);
  return source.slice(start, end);
}

test('Lineup Lab retires group-production rules from every fan-controlled path', async () => {
  const [html, app, workflow] = await Promise.all([
    readFile(new URL('index.html', SOURCE_ROOT), 'utf8'),
    readFile(new URL('app.js', SOURCE_ROOT), 'utf8'),
    readFile(new URL('workflow-state.js', SOURCE_ROOT), 'utf8'),
  ]);

  assert.match(html, /<fieldset class="constraint-group--wide" aria-describedby="productionRulesHelp" hidden>/);
  assert.doesNotMatch(html, /Hard rules<\/h3><p>[^<]*(production floors|turnover ceilings)/);
  assert.doesNotMatch(html, /Locked and excluded players, position assignments, production floors/);
  assert.doesNotMatch(workflow, /minPointsInput|minReboundsInput|minAssistsInput|minStealsInput|minBlocksInput|maxTurnoversInput/);

  const config = functionBody(app, 'buildOptimizerConfig', 'assignedPosition');
  assert.doesNotMatch(config, /statMinimums|maxTurnovers/);
  const shared = functionBody(app, 'sharedScenarioFromControls', 'copyScenarioLink');
  assert.doesNotMatch(shared, /statMinimums|maxTurnovers/);
  assert.match(app, /Production thresholds were retired from the fan workflow/);
  assert.doesNotMatch(app, /loosening the production threshold/);
});
