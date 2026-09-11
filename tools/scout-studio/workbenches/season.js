const STYLE_ID = 'scout-season-lab-style';

/**
 * Wiring hook for the existing Scout Studio controller. Call once after
 * createLeagueLab() has mounted #leaguePanel; no data or event behavior is
 * changed by this presentation-only installer.
 */
export function installSeasonLabPresentation(documentRef = document) {
  if (!documentRef?.getElementById('leaguePanel')) return false;
  if (documentRef.getElementById(STYLE_ID)) return true;
  const link = documentRef.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./season.css', import.meta.url).href;
  documentRef.head.append(link);
  return true;
}
