// Shared presentation helpers. No scores, game records, or backend calls.
export function focusGameStage(element) {
  if (!element) return;
  element.tabIndex = -1;
  element.focus({ preventScroll: true });
  element.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
}

export function createNextPlay(game) {
  const section = document.createElement('section');
  section.className = 'fan-next-play';
  section.setAttribute('aria-label', 'Choose your next play');
  const title = document.createElement('h3');
  title.textContent = 'Keep the coaching streak going.';
  const copy = document.createElement('p');
  copy.textContent = 'Try a different kind of decision, or return to this run and explore your choices.';
  section.append(title, copy);
  const destinations = [
    game === 'draft-night' ? ['Try one-swap challenges', '../fix-the-five/'] : ['Draft your own five', '../draft-night/'],
    ['Build a full game plan', '../../lineup-lab/'],
  ];
  const links = document.createElement('div');
  for (const [label, href] of destinations) {
    const link = document.createElement('a');
    link.className = 'button-secondary';
    link.href = href;
    link.textContent = label + ' →';
    links.append(link);
  }
  section.append(links);
  return section;
}
