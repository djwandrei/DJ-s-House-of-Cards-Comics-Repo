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
  const css = await sourceFile("storefront-shell.css");

  // These are intentionally source-relative paths. The release builder changes
  // them by one directory for the deployed /lineup-lab/ page and verifies that
  // generated output separately.
  // The shared storefront shell replaced the former standalone Lab header.
  // Check actual destinations, accessible names, focus and touch contracts;
  // requiring retired class names would fail without identifying a user bug.
  assert.match(html, /<nav aria-label="Primary navigation"/);
  assert.match(html, /href="\.\.\/\.\.\/shop\.html">Shop<\/a>/);
  assert.match(html, /data-fan-tools-link="true" href="\/tools\/">Fan Tools<\/a>/);
  assert.match(html, /href="\.\.\/\.\.\/account\.html">Account<\/a>/);
  assert.match(html, /aria-controls="siteNav" aria-expanded="false"[^>]*id="navToggle"/);
  assert.match(css, /\.site-header :focus-visible\s*\{[^}]*outline:3px/);
  assert.match(css, /@media \(max-width:900px\)[\s\S]*?\.primary-nav__link\s*\{[^}]*min-height:46px/);
});

test("automatic data exclusions remain visible, retryable, and included in copied results", async () => {
  const app = await sourceFile("app.js");
  assert.match(app, /function renderDataEligibilityNotice\(result\)/);
  assert.match(app, /notice\.className = "result-card data-eligibility-notice"/);
  assert.match(app, /item\.textContent = `\$\{player.name\}/);
  assert.match(app, /if \(dataNotice\) fragment\.append\(dataNotice\)/);
  assert.match(app, /replaceChildren\(\.\.\.\(dataNotice \? \[dataNotice, card\] : \[card\]\)\)/);
  assert.match(app, /These exclusions apply only to this run/);
  assert.match(app, /if \(dataExcluded.length\) lines.push\(/);
  assert.doesNotMatch(app, /Every eligible player must have a matched, usable impact row before Scout can run/);
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

test("season-evidence copy separates available samples from hard minute limits", async () => {
  const app = await sourceFile("app.js");
  const html = await sourceFile("index.html");
  assert.match(html, /Visible stats describe games played with this team/);
  assert.match(app, /Available season sample:/);
  assert.match(app, /Each metric needs matching counts/);
  assert.match(app, /Complete source coverage is not independently verified/);
  assert.doesNotMatch(app, /source usage did not affect this result|past team games and total minutes did not affect the roster/);
});

test("Lineup DNA turns the exact result into a source-labeled strength, gap, and one-player test", async () => {
  const [app, html, css] = await Promise.all([
    sourceFile("app.js"),
    sourceFile("index.html"),
    sourceFile("styles.css"),
  ]);

  assert.match(html, /What is its Lineup DNA\?/);
  assert.match(html, /Remove one player and rerun the exact rules/);
  assert.match(app, /function lineupDnaProfile\(roleCoverage = \{\}\)/);
  assert.match(app, /heading\.textContent = "Lineup DNA"/);
  assert.match(app, /Scout objective · historical role context/);
  assert.match(app, /Historical team-season evidence/);
  assert.match(app, /function renderLineupDnaSwapTool\(result, explanation\)/);
  assert.match(app, /The exact solver keeps every other selected player and every current rule/);
  assert.match(app, /function renderLineupDnaReport\(result, explanation\)/);
  assert.match(app, /lineupDnaReport = renderLineupDnaReport\(result, fanExplanation\)/);
  assert.match(app, /roundedMagnitude === 0 \? "±"/);
  assert.match(css, /\.lineup-dna__counts\s*\{/);
  assert.match(css, /\.lineup-dna__swap-controls\s*\{/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.lineup-dna__method/);
});

test("rotation searches expose cancellation, consent, and display-only progress", async () => {
  const [app, html, css, worker] = await Promise.all([
    sourceFile("app.js"),
    sourceFile("index.html"),
    sourceFile("styles.css"),
    sourceFile("optimizer-worker.js"),
  ]);

  assert.match(html, /id="cancelOptimizeButton"[^>]*type="button"[^>]*aria-describedby="solverStatus optimizationProgress"[^>]*hidden/);
  assert.match(html, /id="mobileCancelOptimizeButton"[^>]*type="button"[^>]*aria-describedby="solverStatus optimizationProgress"[^>]*hidden/);
  assert.match(html, /id="optimizationProgress" aria-live="off" hidden/);
  assert.match(css, /\.optimizer-cancel\s*\{/);
  assert.match(css, /\.mobile-solve-bar \.mobile-cancel\s*\{/);

  assert.match(app, /ROTATION_SEARCH_CONFIRMATION_CANDIDATE_THRESHOLD = 1_000_000/);
  assert.match(app, /function confirmLargeRotationSearch\(\)/);
  assert.match(app, /window\.confirm\(/);
  assert.match(app, /function cancelCurrentOptimization\(\)/);
  assert.match(app, /function formatRotationSearchProgress\(progress = \{\}\)/);
  assert.match(app, /message\.type === "progress"/);
  assert.match(app, /elements\.cancelOptimize\.addEventListener\("click", cancelCurrentOptimization\)/);
  assert.match(worker, /type: "progress"/);
  assert.match(worker, /optimizeLineups\(players, config, \{ onProgress \}\)/);
});
