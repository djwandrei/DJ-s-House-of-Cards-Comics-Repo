import { createFanMilestones } from '../../tools/fan-telemetry.js?v=__LINEUP_LAB_ASSET_VERSION__';

// Observe the public workflow rather than importing optimizer state. This
// keeps measurement one-way: it can time the experience but cannot affect the
// selected roster, constraints, worker, or result.
const milestones = createFanMilestones('lineup-lab');
const form = document.getElementById('optimizerForm');
const datasetCount = document.getElementById('datasetCount');
const results = document.getElementById('results');
const solverStatus = document.getElementById('solverStatus');

function markGameStart() {
  if (Number.parseInt(datasetCount?.textContent || '0', 10) > 0) milestones.mark('game_start');
}

function markResultMilestones() {
  const resultIsReady = results && !results.hidden
    && Boolean(results.querySelector('.lineup-grid'))
    && solverStatus?.textContent.trim() === 'Exact result ready';
  if (!resultIsReady) return;
  milestones.mark('reveal');
  milestones.mark('completion');
}

function markFirstInteraction(event) {
  // Restrict this to events initiated on the optimizer form; initialization
  // does not dispatch any of these interaction events.
  if (!event.target?.closest?.('#optimizerForm')) return;
  milestones.mark('first_interaction');
}

if (datasetCount) {
  new MutationObserver(markGameStart).observe(datasetCount, { childList: true, characterData: true, subtree: true });
  markGameStart();
}
if (results && solverStatus) {
  const resultObserver = new MutationObserver(markResultMilestones);
  resultObserver.observe(results, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true });
  resultObserver.observe(solverStatus, { childList: true, characterData: true, subtree: true });
  markResultMilestones();
}
if (form) {
  form.addEventListener('pointerdown', markFirstInteraction, { capture: true });
  form.addEventListener('click', markFirstInteraction, { capture: true });
  form.addEventListener('keydown', markFirstInteraction, { capture: true });
  form.addEventListener('input', markFirstInteraction, { capture: true });
}
