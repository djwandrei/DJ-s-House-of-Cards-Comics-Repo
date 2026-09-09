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
// A follow-up model fix must also invalidate already loaded Lab modules.
// Lineup Lab has its own revision; storefront cache values remain untouched.
const RELEASE_ASSET_VERSION = "20260909g";
const releaseFiles = [
  "index.html",
  "app.js",
  "workflow-state.js",
  "workflow-view.js",
  "workflow.css",
  "lab-telemetry.js",
  "lab-experience.js",
  "lab-experience.css",
  "lab-theme.css",
  "storefront-shell.css",
  "optimizer-config.js",
  "projection-parameters.js",
  "workload-calibration.js",
  "workload-model.js",
  "projection-evidence.js",
  "player-projection.js",
  "lineup-role-model.js",
  "scout-impact.js",
  "rotation-unit-planner.js",
  "optimizer-core.js",
  "optimizer-worker.js",
  "player-data.js",
  "supabase-nba-data.js",
  "fan-analytics.js",
  "individual-player-evaluation.js",
  "product-analytics.js",
  "basketball-simulation.js",
  "opponent-gameplan.js",
  "scenario-url.js",
  "lineup-cache.js",
  "styles.css",
  "fixtures/timberwolves-2021-22.json",
];
const checkOnly = process.argv.includes("--check");
// Shared worktrees can contain generated-only page edits owned by another
// task. A scoped model build must not overwrite those changes. The default
// remains a FULL release/parity check; --only is an explicit local subset,
// never sufficient evidence that the entire deployable page is synchronized.
const onlyIndex = process.argv.indexOf("--only");
const requestedFiles = onlyIndex < 0 ? releaseFiles : (process.argv[onlyIndex + 1] || "").split(",");
if (!requestedFiles.length || requestedFiles.some(file => !releaseFiles.includes(file))
  || new Set(requestedFiles).size !== requestedFiles.length) {
  throw new Error("--only requires unique, comma-separated files from the Lineup release allowlist.");
}

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
    .replaceAll(SOURCE_ASSET_VERSION_TOKEN, RELEASE_ASSET_VERSION)
    .replaceAll("../../tools/", "../tools/");
  if (["index.html", "styles.css", "workflow-view.js"].includes(relativePath)) {
    // The source prototype is nested two directories deep; the deployable page
    // is nested once. Keep all storefront references local to the public page.
    output = output.replaceAll("../../assets/", "../assets/");
  }
  if (relativePath === "index.html") {
    output = output
      .replaceAll("../../backend-config.js", "../backend-config.js")
      .replaceAll("../../theme-init.js", "../theme-init.js")
      .replaceAll("../../core.js", "../core.js")
      .replaceAll("../../nav.js", "../nav.js")
      .replaceAll("../../shop.html", "../shop.html")
      .replaceAll("../../sports-cards.html", "../sports-cards.html")
      .replaceAll("../../baseball-cards.html", "../baseball-cards.html")
      .replaceAll("../../basketball-cards.html", "../basketball-cards.html")
      .replaceAll("../../football-cards.html", "../football-cards.html")
      .replaceAll("../../comics.html", "../comics.html")
      .replaceAll("../../collectibles.html", "../collectibles.html")
      .replaceAll("../../about.html", "../about.html")
      .replaceAll("../../wishlist.html", "../wishlist.html")
      .replaceAll("../../cart.html", "../cart.html")
      .replaceAll("../../supabase-client.js", "../supabase-client.js")
      .replaceAll("../../index.html", "../index.html")
      // Header navigation is written relative to the nested prototype. Keep
      // those same destinations one level up from the deployable /lineup-lab/
      // page so the links stay correct both locally and on cPanel.
      .replaceAll("../../tools/", "../tools/")
      .replaceAll("../../account.html", "../account.html");
  }
  if (relativePath === "storefront-shell.css") output = output.replaceAll("../../", "../");
  return Buffer.from(output, "utf8");
}

const results = [];
for (const relativePath of requestedFiles) {
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
  files: requestedFiles.length,
  scope: onlyIndex < 0 ? "full-release" : "explicit-subset-not-full-release-parity",
  updated: checkOnly ? 0 : stale.length,
  assetVersion: RELEASE_ASSET_VERSION,
  status: "ok",
}, null, 2));
