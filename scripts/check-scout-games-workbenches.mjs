import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Focused local suite; no package mutation, backend write or release side effect.
const tests = [
  'scout-studio', 'scout-studio-analysis', 'scout-style-matches', 'scout-context-lens',
  'scout-possession-simulator', 'scout-season-simulator', 'scout-league-comparisons',
  'scout-workbench-comparisons', 'game-decision-history', 'game-decision-model',
  'scout-daily-game-client', 'scout-daily-games', 'lineup-dna',
];
const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', '--test-concurrency=1',
  ...tests.map(name => `scripts/tests/${name}.test.mjs`)],
{ cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: 'inherit', shell: false });
if (result.error) console.error(result.error.message);
process.exitCode = result.status ?? 1;
