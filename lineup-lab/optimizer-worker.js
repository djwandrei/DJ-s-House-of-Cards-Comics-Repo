// Match the app shell's revision so the worker cannot run an older solver from
// an existing browser cache after a targeted cPanel release.
import { optimizeLineups } from "./optimizer-core.js?v=20260826c";

self.addEventListener("message", (event) => {
  const { requestId, players, config } = event.data || {};
  if (typeof requestId !== "string" || !Array.isArray(players)) {
    if (typeof requestId === "string") {
      self.postMessage({
        requestId,
        error: "The optimizer received an invalid background request.",
      });
    }
    return;
  }
  try {
    self.postMessage({
      requestId,
      result: optimizeLineups(players, config),
    });
  } catch (error) {
    self.postMessage({
      requestId,
      error: error instanceof Error ? error.message : "The optimizer could not finish.",
    });
  }
});
