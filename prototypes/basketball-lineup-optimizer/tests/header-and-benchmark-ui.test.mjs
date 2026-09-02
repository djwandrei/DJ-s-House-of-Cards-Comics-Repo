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
