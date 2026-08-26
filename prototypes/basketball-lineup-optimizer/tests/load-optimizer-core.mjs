import { readFile } from "node:fs/promises";

const OPTIMIZER_CONFIG_SPECIFIER =
  "./optimizer-config.js?v=__LINEUP_LAB_ASSET_VERSION__";

function javascriptDataUrl(source) {
  return `data:text/javascript;base64,${Buffer.from(source, "utf8").toString("base64")}`;
}

/**
 * The prototype intentionally ships package-free browser ES modules. Node can
 * execute their source through data URLs, but a data URL cannot resolve a
 * relative child import. Inline the small config module URL so tests continue
 * exercising the exact optimizer source without adding a package boundary.
 */
export async function loadOptimizerCore() {
  const optimizerUrl = new URL("../optimizer-core.js", import.meta.url);
  const configSource = await readFile(
    new URL("../optimizer-config.js", import.meta.url),
    "utf8",
  );
  const optimizerSource = await readFile(optimizerUrl, "utf8");

  if (!optimizerSource.includes(OPTIMIZER_CONFIG_SPECIFIER)) {
    throw new Error("Optimizer config import contract changed; update the test loader.");
  }

  return import(
    javascriptDataUrl(
      optimizerSource.replaceAll(
        OPTIMIZER_CONFIG_SPECIFIER,
        javascriptDataUrl(configSource),
      ),
    )
  );
}
