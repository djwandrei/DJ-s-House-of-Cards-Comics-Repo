// Optional badge delight. Never touches the board, storage, scores, or network.
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const activeAnimations = new Set();
const badges = [...document.querySelectorAll('[data-badge-replay]')];

function syncMotionPreference() {
  for (const animation of activeAnimations) animation.cancel();
  activeAnimations.clear();
  for (const badge of badges) {
    const available = !reducedMotion.matches && typeof badge.querySelector('img')?.animate === 'function';
    badge.disabled = !available;
    badge.setAttribute('aria-label', available ? badge.dataset.badgeReplay : badge.dataset.badgeName);
  }
}

for (const badge of badges) {
  badge.addEventListener('click', () => {
    if (reducedMotion.matches || badge.disabled) return;
    const image = badge.querySelector('img');
    for (const animation of image.getAnimations()) { animation.cancel(); activeAnimations.delete(animation); }
    const animation = image.animate([
      { transform:'translateY(0) rotate(0)', offset:0 },
      { transform:'translateY(-12px) rotate(-9deg)', offset:.28 },
      { transform:'translateY(0) rotate(5deg)', offset:.58 },
      { transform:'translateY(-4px) rotate(-3deg)', offset:.78 },
      { transform:'translateY(0) rotate(0)', offset:1 },
    ], { duration:620, easing:'ease-out' });
    activeAnimations.add(animation);
    animation.finished.catch(() => {}).finally(() => activeAnimations.delete(animation));
  });
}
reducedMotion.addEventListener('change', syncMotionPreference);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { for (const animation of activeAnimations) animation.cancel(); activeAnimations.clear(); }
});
syncMotionPreference();
