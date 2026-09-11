/**
 * Activates the presentation-only Superdesign adapter for Lineup Lab.
 *
 * The function is intentionally idempotent: it only adds CSS marker classes
 * already understood by the shared basketball theme. It never reads, writes,
 * resets, or submits optimizer state.
 */
export function mountLineupLabSuperdesign(root = typeof document === "undefined" ? null : document) {
  const body = root?.body || (root?.ownerDocument ? root.ownerDocument.body : null);
  if (!body) return false;
  if (!body.classList.contains("lineup-superdesign") && !body.classList.contains("lab-guided")) return false;

  body.classList.add("lineup-superdesign", "court-themed", "superdesign-mounted");
  body.dataset.superdesignMounted = "true";
  return true;
}

if (typeof document !== "undefined") {
  mountLineupLabSuperdesign(document);
}

export default mountLineupLabSuperdesign;
