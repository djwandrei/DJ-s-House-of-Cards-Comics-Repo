export function enhanceCareerLab(root) {
  if (!root || root.dataset.careerEnhanced === 'true') return;
  root.dataset.careerEnhanced = 'true';
  root.classList.add('career-lab-workbench');
  const heading = root.querySelector('#careerLabTitle');
  heading?.classList.add('career-lab-title');
  root.querySelector('form')?.classList.add('career-lab-explorer');
  root.querySelector('form > .studio-roadmap')?.classList.add('career-lab-controls');
  root.querySelector('form > .studio-team-form')?.classList.add('career-lab-actions');
  root.querySelector('#careerResults')?.classList.add('career-lab-results');
  const classify = () => root.querySelectorAll('#careerResults > .studio-panel').forEach(panel => {
    panel.classList.add('career-lab-card');
    if (panel.querySelector('[data-career-result]')) panel.classList.add('career-lab-history');
    if (panel.querySelector('[data-career-replay]')) panel.classList.add('career-lab-replay');
  });
  classify();
  const observer = new MutationObserver(classify);
  observer.observe(root.querySelector('#careerResults') || root, { childList: true });
  return root;
}
