import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const sourceRoot = path.join(root, "prototypes", "basketball-lineup-optimizer");
const outputRoot = path.join(root, "lineup-lab");
const SOURCE_ASSET_VERSION_TOKEN = "__LINEUP_LAB_ASSET_VERSION__";
// Keep Lineup Lab's self-contained assets cache-busted independently of the
// storefront's shared cache contract. Bump this only when the generated Lab
// files change so a later reviewed path-list release cannot serve stale model
// logic or interface copy from a browser cache.
const RELEASE_ASSET_VERSION = "20260902f";
const releaseFiles = [
  "index.html",
  "app.js",
  "optimizer-config.js",
  "projection-parameters.js",
  "player-projection.js",
  "lineup-role-model.js",
  "scout-impact.js",
  "rotation-unit-planner.js",
  "optimizer-core.js",
  "optimizer-worker.js",
  "player-data.js",
  "supabase-nba-data.js",
  "fan-analytics.js",
  "opponent-gameplan.js",
  "scenario-url.js",
  "lineup-cache.js",
  "styles.css",
  "fixtures/timberwolves-2021-22.json",
];
const checkOnly = process.argv.includes("--check");

function readSource(relativePath) {
  const sourcePath = path.join(sourceRoot, relativePath);
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    throw new Error(`Missing Lineup Lab source file: ${relativePath}`);
  }
  return fs.readFileSync(sourcePath);
}

function transform(relativePath, source) {
  if (path.extname(relativePath) === ".json") return source;
  const sourceText = source.toString("utf8");
  if (/\?v=\d{8}[a-z0-9]+/i.test(sourceText)) {
    throw new Error(`Hard-coded Lineup Lab asset revision in source file: ${relativePath}`);
  }
  let output = sourceText
    .replaceAll(SOURCE_ASSET_VERSION_TOKEN, RELEASE_ASSET_VERSION);
  if (relativePath === "index.html" || relativePath === "styles.css") {
    // The source prototype is nested two directories deep; the deployable page
    // is nested once. Keep all storefront references local to the public page.
    output = output.replaceAll("../../assets/", "../assets/");
  }
  if (relativePath === "index.html") {
    output = output
      .replaceAll("../../backend-config.js", "../backend-config.js")
      .replaceAll("../../supabase-client.js", "../supabase-client.js")
      .replaceAll("../../index.html", "../index.html")
      // Header navigation is written relative to the nested prototype. Keep
      // those same destinations one level up from the deployable /lineup-lab/
      // page so the links stay correct both locally and on cPanel.
      .replaceAll("../../tools/", "../tools/")
      .replaceAll("../../account.html", "../account.html");
  }
  return Buffer.from(output, "utf8");
}

const results = [];
for (const relativePath of releaseFiles) {
  const expected = transform(relativePath, readSource(relativePath));
  const outputPath = path.join(outputRoot, relativePath);
  const current = fs.existsSync(outputPath) ? fs.readFileSync(outputPath) : null;
  const matches = Boolean(current?.equals(expected));
  results.push({ relativePath, matches });

  if (!checkOnly && !matches) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, expected);
  }
}

const stale = results.filter((result) => !result.matches);
if (checkOnly && stale.length) {
  throw new Error(`Lineup Lab release files are out of date: ${stale.map((result) => result.relativePath).join(", ")}`);
}

console.log(JSON.stringify({
  mode: checkOnly ? "check" : "build",
  files: releaseFiles.length,
  updated: checkOnly ? 0 : stale.length,
  assetVersion: RELEASE_ASSET_VERSION,
  status: "ok",
}, null, 2));
