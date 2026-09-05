import { readFile } from "node:fs/promises";

const MODULE_SPECIFIERS = Object.freeze({
  optimizerConfig: "./optimizer-config.js?v=__LINEUP_LAB_ASSET_VERSION__",
  projectionParameters: "./projection-parameters.js?v=__LINEUP_LAB_ASSET_VERSION__",
  playerProjection: "./player-projection.js?v=__LINEUP_LAB_ASSET_VERSION__",
  workloadModel: "./workload-model.js?v=__LINEUP_LAB_ASSET_VERSION__",
  lineupRoleModel: "./lineup-role-model.js?v=__LINEUP_LAB_ASSET_VERSION__",
  scoutImpact: "./scout-impact.js?v=__LINEUP_LAB_ASSET_VERSION__",
  rotationUnitPlanner: "./rotation-unit-planner.js?v=__LINEUP_LAB_ASSET_VERSION__",
});

function javascriptDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

/**
 * The prototype intentionally ships package-free browser ES modules. Node can
 * execute their source through data URLs, but a data URL cannot resolve a
 * relative child import. Inline the browser-safe dependency graph so tests
 * continue exercising the exact optimizer source without adding a package
 * boundary or changing production import URLs.
 */
export async function loadOptimizerCore() {
  const optimizerUrl = new URL("../optimizer-core.js", import.meta.url);
  const sources = Object.fromEntries(await Promise.all([
    ["optimizerConfig", "optimizer-config.js"],
    ["projectionParameters", "projection-parameters.js"],
    ["workloadCalibration", "workload-calibration.js"],
    ["workloadModel", "workload-model.js"],
    ["playerProjection", "player-projection.js"],
    ["lineupRoleModel", "lineup-role-model.js"],
    ["scoutImpact", "scout-impact.js"],
    ["rotationUnitPlanner", "rotation-unit-planner.js"],
  ].map(async ([key, filename]) => [
    key,
    await readFile(new URL(`../${filename}`, import.meta.url), "utf8"),
  ])));
  const optimizerSource = await readFile(optimizerUrl, "utf8");

  for (const specifier of Object.values(MODULE_SPECIFIERS)) {
    if (!optimizerSource.includes(specifier)) {
      throw new Error(`Optimizer import contract changed for ${specifier}; update the test loader.`);
    }
  }

  const playerProjectionUrl = javascriptDataUrl(sources.playerProjection.replaceAll(
    "./workload-model.js?v=__LINEUP_LAB_ASSET_VERSION__", javascriptDataUrl(sources.workloadModel),
  ));
  const lineupRoleUrl = javascriptDataUrl(
    sources.lineupRoleModel.replaceAll(
      MODULE_SPECIFIERS.playerProjection,
      playerProjectionUrl,
    ),
  );
  const moduleUrls = {
    optimizerConfig: javascriptDataUrl(sources.optimizerConfig),
    projectionParameters: javascriptDataUrl(sources.projectionParameters.replaceAll(
      "./workload-calibration.js?v=__LINEUP_LAB_ASSET_VERSION__", javascriptDataUrl(sources.workloadCalibration),
    )),
    playerProjection: playerProjectionUrl,
    workloadModel: javascriptDataUrl(sources.workloadModel),
    lineupRoleModel: lineupRoleUrl,
    scoutImpact: javascriptDataUrl(sources.scoutImpact),
    rotationUnitPlanner: javascriptDataUrl(sources.rotationUnitPlanner),
  };
  let inlinedOptimizer = optimizerSource;
  for (const [key, specifier] of Object.entries(MODULE_SPECIFIERS)) {
    inlinedOptimizer = inlinedOptimizer.replaceAll(specifier, moduleUrls[key]);
  }

  return import(javascriptDataUrl(inlinedOptimizer));
}
