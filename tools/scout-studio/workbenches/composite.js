const STYLE_ID = 'scout-composite-forge-style';

/** Parent hook: load Forge presentation after the real #forgePanel exists. */
export function installCompositeForgePresentation(documentRef = document) {
  if (!documentRef?.getElementById('forgePanel')) return false;
  if (documentRef.getElementById(STYLE_ID)) return true;
  const link = documentRef.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./composite.css', import.meta.url).href;
  link.dataset.scoutWorkbench = 'composite-forge';
  (documentRef.head || documentRef.documentElement).append(link);
  return true;
}
