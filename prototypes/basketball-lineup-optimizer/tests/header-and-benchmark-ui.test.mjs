import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const SOURCE_DIRECTORY = path.resolve(TEST_DIRECTORY, "..");

async function sourceFile(name) {
  return readFile(path.join(SOURCE_DIRECTORY, name), "utf8");
}

test("header keeps direct Shop, Fan Tools, and Account destinations with accessible labels", async () => {
  const html = await sourceFile("index.html");
  const css = await sourceFile("styles.css");

  // These are intentionally source-relative paths. The release builder changes
  // them by one directory for the deployed /lineup-lab/ page and verifies that
  // generated output separately.
  assert.match(html, /class="lab-header__link" href="\.\.\/\.\.\/index\.html"[\s\S]*?<span>Shop<\/span>/);
  assert.match(html, /class="lab-header__link lab-header__link--tools" href="\.\.\/\.\.\/tools\/"[\s\S]*?<span>Fan Tools<\/span>/);
  assert.match(html, /class="lab-header__account" href="\.\.\/\.\.\/account\.html" aria-label="Open your account"/);
  assert.match(css, /\.lab-header__account\s*\{[\s\S]*?width:\s*42px/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.lab-header__account\s*\{[\s\S]*?width:\s*44px/);
  assert.match(css, /font-family:\s*"Inter", Arial, sans-serif;/);
});

test("benchmark result copy defines the 100-point index and its limits", async () => {
  const app = await sourceFile("app.js");
  const html = await sourceFile("index.html");

  assert.match(app, /function benchmarkIndexReading\(value\)/);
  assert.match(app, /Game-plan fit \(NBA = 100\)/);
  assert.match(app, /This is a 100-based comparison index, not the exact solver score\./);
  assert.match(app, /It is not a percentage, win forecast, team rating, chemistry measure, or betting signal\./);
  assert.match(app, /Lineup Lab projects each selected player's expected rate from the season you chose\./);
  assert.match(html, /How to read the game-plan fit index/);
  assert.match(html, /not the solver score/);
});

test("fan-first layout keeps the functional optimizer in a clear numbered flow", async () => {
  const html = await sourceFile("index.html");
  const css = await sourceFile("styles.css");
  const app = await sourceFile("app.js");

  // The hero's outcome panel replaces decorative-only court artwork with an
  // explanation of what the exact optimizer can actually answer.
  assert.match(html, /class="hero-outcomes" aria-label="What your Lineup Lab result answers"/);
  assert.match(html, /Which team and season should the model use\?/);
  assert.match(html, /id="runStepNumber" aria-label="Step 4">4/);
  assert.match(html, /Your recommended group will appear here/);

  // CSS changes presentation only: IDs, submit controls, and source order
  // remain stable while the desktop builder becomes a readable vertical flow.
  assert.match(css, /\.builder-grid\s*\{\s*display:\s*block;/);
  assert.match(css, /\.hero-outcomes\s*\{/);
  assert.match(css, /\.simple-result-insights\s*\{/);
  assert.match(css, /@media \(max-width: 520px\)[\s\S]*?\.simple-result-insights/);

  // Simple results place the concise explanation before the individual cards;
  // the exact selected players and detailed audit are still rendered afterward.
  assert.match(app, /const playerStep = detailed \? "4" : "3";/);
  assert.match(app, /const buildStep = detailed \? "5" : "4";/);
  assert.match(app, /insights\.className = "simple-result-insights"/);
  assert.match(app, /fragment\.append\(renderSimpleResultOverview\(result, fanExplanation\), lineup\);/);
  assert.match(app, /\? "Your recommended rotation"\s*:\s*"Your recommended lineup"/);
});
