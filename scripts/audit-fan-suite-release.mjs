import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Narrow fallback for the generic auditor mentioned in CPANEL-DEPLOY.md,
// which is not present in this checkout. This never writes or deploys.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const relativeList = "scripts/cpanel-fan-suite-20260907f-release.txt";
const paths = fs.readFileSync(path.join(root, relativeList), "utf8").split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
const rootPages = new Set("about account admin baseball-cards basketball-cards cart checkout-success collectibles comics contact football-cards inbox index metrics offer offline policies returns sell-trade-want-list shipping shop sports-cards wishlist".split(" ").map(s => s + ".html"));
const toolFiles = new Set([
  "tools/index.html", "tools/fix-the-five/index.html", "tools/draft-night/index.html",
  "tools/player-card-matchups/index.html", "tools/workshop/index.html",
  "tools/fan-tools.css", "tools/fan-tools.js", "tools/registry.js",
  "tools/basketball-branding.css", "tools/basketball-branding.js",
  "tools/basketball-theme.css", "tools/basketball-theme.js", "tools/basketball-palettes.js",
  "tools/fan-journey.js", "tools/fan-telemetry.js",
  "tools/game-decision-history.js", "tools/game-decision-model.js", "tools/game-decision-ui.js",
  "tools/scout-daily-game-client.js",
  "tools/draft-night/draft-night.css", "tools/draft-night/scout-draft-night.js",
  "tools/fix-the-five/fix-the-five.css", "tools/fix-the-five/scout-fix-the-five.js",
  "tools/player-card-matchups/player-card-matchups.css", "tools/player-card-matchups/player-card-matchups.js",
  "tools/workshop/definitions.js", "tools/workshop/tool-workshop.css",
  "tools/workshop/tool-workshop.js", "tools/workshop/workshop-state.js",
]);
const builder = fs.readFileSync(path.join(root, "scripts/build-lineup-lab-release.mjs"), "utf8");
const releaseFiles = [...builder.match(/const releaseFiles = \[([\s\S]*?)\];/)[1].matchAll(/"([^"]+)"/g)].map(m => "lineup-lab/" + m[1]);
const allowed = new Set([...rootPages, ...toolFiles, ...releaseFiles,
  "analytics.js", "core.js", "styles.css", "styles-mobile-overrides.css", "sw.js",
  ...["fix-the-five", "draft-night", "lineup-lab"].flatMap(n => [
    `assets/games/${n}-emblem-20260907.webp`, `assets/games/${n}-icon-20260907.png`]),
  ...["manrope-400.ttf", "manrope-700.ttf", "barlow-condensed-700.ttf", "Manrope-OFL.txt", "BarlowCondensed-OFL.txt"].map(n => "assets/fonts/" + n),
]);
assert.equal(new Set(paths).size, paths.length, "Duplicate release path");
assert.deepEqual([...paths].sort(), [...allowed].sort(), "Release must match the reviewed scope exactly");
assert.equal(paths.at(-1), "sw.js", "Service worker must be last");
const digest = buffer => crypto.createHash("sha256").update(buffer).digest("hex");
const normalize = buffer => buffer.toString("utf8").replace(/\r\n/g, "\n");
const rows = paths.map(file => {
  assert.ok(!file.includes("..") && !path.isAbsolute(file) && !file.includes("\\"), "Non-canonical path");
  const absolute = path.resolve(root, file);
  assert.ok(absolute.startsWith(root + path.sep), "Path escapes repository");
  const bytes = fs.readFileSync(absolute);
  assert.ok(bytes.length > 0, "Empty release file: " + file);
  if (process.argv.includes("--committed")) {
    const committed = execFileSync("git", ["show", "HEAD:" + file], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const binary = /\.(png|webp|ttf)$/.test(file);
    assert.ok(binary ? bytes.equals(committed) : normalize(bytes) === normalize(committed), "Uncommitted release drift: " + file);
  }
  return { file, bytes: bytes.length, sha256: digest(bytes) };
});
assert.match(fs.readFileSync(path.join(root, "core.js"), "utf8"), /PRODUCT_ASSET_VERSION = ['"]20260907f['"]/);
assert.match(fs.readFileSync(path.join(root, "sw.js"), "utf8"), /dj-house-v2026-09-07-4/);
for (const file of [...toolFiles, "lineup-lab/index.html"].filter(n => n.endsWith(".html"))) {
  const html = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(html, /court-themed/);
  assert.match(html, /basketball-theme\.css\?v=20260907f/);
  assert.ok(!/\?v=20260907[a-e]/.test(html), "Stale cache reference: " + file);
}
for (const file of ["tools/fix-the-five/scout-fix-the-five.js", "tools/draft-night/scout-draft-night.js"]) {
  const script = fs.readFileSync(path.join(root, file), "utf8");
  assert.match(script, /fan-telemetry\.js\?v=20260907f/);
  assert.match(script, /game-decision-history\.js\?v=20260907f/);
  assert.match(script, /game-decision-ui\.js\?v=20260907f/);
}
for (const removed of ["tools/fix-the-five/fix-the-five.js", "tools/fix-the-five/fixtures.js", "tools/fix-the-five/game-engine.js", "tools/draft-night/decks.js", "tools/draft-night/draft-night.js"]) {
  assert.ok(!paths.includes(removed), "Legacy runtime must not re-enter the release: " + removed);
}
if (process.argv.includes("--live")) {
  // Public, unauthenticated, read-only verification of each released byte.
  const pending = [...rows];
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (pending.length) {
      const row = pending.shift();
      const response = await fetch("https://djshouseofcards-comics.com/" + row.file + "?releaseAudit=20260907f-" + Date.now(), {
        signal: AbortSignal.timeout(30000), headers: { "Cache-Control": "no-cache" },
      });
      assert.equal(response.status, 200, "Live HTTP failure: " + row.file);
      const bytes = Buffer.from(await response.arrayBuffer());
      assert.equal(digest(bytes), row.sha256, "Live hash mismatch: " + row.file);
    }
  }));
}
console.log(JSON.stringify({
  status: "passed", files: rows.length, bytes: rows.reduce((sum, r) => sum + r.bytes, 0),
  commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  committedParity: process.argv.includes("--committed"), liveByteParity: process.argv.includes("--live"),
  manifestSha256: digest(Buffer.from(rows.map(r => r.file + ":" + r.sha256).join("\n"))),
  deletes: 0, excluded: ["Scout Studio", "backend", "catalog", "credentials", "source-only files"],
}, null, 2));
