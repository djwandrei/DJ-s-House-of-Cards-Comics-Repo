const STYLE_ID = 'scout-chemistry-lab-style';

function loadStyles(documentRef) {
  if (documentRef.getElementById(STYLE_ID)) return;
  const link = documentRef.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = new URL('./chemistry.css', import.meta.url).href;
  documentRef.head.append(link);
}

function makeSummary(documentRef, content) {
  const table = content.querySelector('.studio-table-wrap table');
  if (!table || !table.tBodies[0] || content.querySelector('.chemistry-summary-grid')) return;
  const headers = [...table.tHead?.rows[0]?.cells || []].map(cell => cell.textContent.trim().toLowerCase());
  const row = table.tBodies[0].rows[0];
  const cells = row ? [...row.cells].map(cell => cell.textContent.trim()) : [];
  const metrics = ['offensive rating', 'defensive rating', 'net rating'];
  const values = metrics.map(label => cells[headers.indexOf(label)] || '—');
  if (values.every(value => value === '—')) return;
  const grid = documentRef.createElement('div');
  grid.className = 'chemistry-summary-grid';
  grid.setAttribute('aria-label', 'Selected group shared-floor summary');
  metrics.forEach((label, index) => {
    const card = documentRef.createElement('div'); card.className = 'chemistry-summary-card';
    const name = documentRef.createElement('span'); name.textContent = label;
    const value = documentRef.createElement('strong'); value.textContent = values[index];
    card.append(name, value); grid.append(card);
  });
  content.insertBefore(grid, table.closest('.studio-table-wrap'));
}

function mountShell(panel) {
  if (panel.dataset.chemistryMounted === 'true') return panel.querySelector('.chemistry-content');
  const heading = panel.querySelector(':scope > .studio-section-heading');
  const layout = panel.querySelector(':scope > .studio-chemistry-layout');
  if (!heading || !layout) return null;
  const selection = layout.querySelector(':scope > fieldset');
  const content = layout.querySelector(':scope > #chemistryContent');
  if (!selection || !content) return null;
  const title = heading.querySelector(':scope > div');
  const main = panel.ownerDocument.createElement('div'); main.className = 'chemistry-main';
  const titlebar = panel.ownerDocument.createElement('div'); titlebar.className = 'chemistry-titlebar';
  if (title) titlebar.append(title);
  main.append(titlebar, content);
  selection.classList.add('chemistry-sidebar');
  layout.className = 'chemistry-layout';
  layout.replaceChildren(selection, main);
  heading.remove();
  content.classList.add('chemistry-content');
  panel.dataset.chemistryMounted = 'true';
  return content;
}

export function mountChemistryWorkbench(documentRef = document) {
  const panel = documentRef.getElementById('chemistryPanel');
  if (!panel) return false;
  loadStyles(documentRef);
  const content = mountShell(panel);
  if (!content || content.dataset.chemistryObserver === 'true') return true;
  content.dataset.chemistryObserver = 'true';
  const observe = () => {
    makeSummary(documentRef, content);
  };
  new MutationObserver(observe).observe(content, { childList: true, subtree: true });
  observe();
  return true;
}
