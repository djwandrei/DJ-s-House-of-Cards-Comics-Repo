// Parser-blocking first-body bootstrap. An explicit saved light preference is
// the only opt-out from the storefront's dark default.
(() => {
  let theme = 'dark';
  try {
    if (localStorage.getItem('theme') === 'light') theme = 'light';
  } catch {
    // Storage-restricted browsers still receive the default dark presentation.
  }
  document.body.classList.toggle('dark-mode', theme === 'dark');
  document.body.style.colorScheme = theme;
})();
