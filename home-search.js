(() => {
  const form = document.getElementById('homeCatalogSearch');
  const input = document.getElementById('homeCatalogSearchInput');
  const submit = document.getElementById('homeCatalogSearchSubmit');
  const scope = document.getElementById('homeSearchScope');
  const term = document.getElementById('homeSearchScopeTerm');
  const status = document.getElementById('homeSearchStatus');
  if (!form || !input || !submit || !scope || !term || !status) return;

  const closeScope = () => {
    scope.hidden = true;
    submit.setAttribute('aria-expanded', 'false');
    status.textContent = '';
  };

  const updateScope = ({ announce = false } = {}) => {
    const query = input.value.trim();
    if (!query) {
      closeScope();
      input.focus();
      status.textContent = 'Enter a search term before choosing a department.';
      return false;
    }

    term.textContent = `“${query}”`;
    scope.querySelectorAll('[data-search-base]').forEach((link) => {
      link.href = `${link.dataset.searchBase}?search=${encodeURIComponent(query)}`;
    });
    scope.hidden = false;
    submit.setAttribute('aria-expanded', 'true');
    if (announce) {
      status.textContent = `Choose a department to search for ${query}.`;
    }
    return true;
  };

  form.addEventListener('submit', (event) => {
    event.preventDefault();
    updateScope({ announce: true });
  });

  input.addEventListener('input', () => {
    if (!scope.hidden) updateScope();
  });

  form.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      updateScope({ announce: true });
      return;
    }

    if (event.key === 'Escape' && !scope.hidden) {
      closeScope();
      input.focus();
    }
  });

  document.addEventListener('click', (event) => {
    if (!form.contains(event.target)) closeScope();
  });
})();
