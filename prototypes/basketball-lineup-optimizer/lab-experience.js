// Presentation prompts route through the existing preset buttons. No separate
// weights, scoring, hidden constraints, data fetches, or automatic solver runs.
const prompts = Object.freeze([
  { preset:'balanced', label:'Balanced', title:'Build a balanced five', question:'Which players stay in the lineup when you ask it to do a little of everything?' },
  { preset:'defense', label:'Defense', title:'Start with the stops', question:'Put defensive strengths first. After the build, read the Lineup DNA: what offensive tradeoff does that introduce?' },
  { preset:'offense', label:'Offense', title:'Give the offense a new look', question:'Prioritize scoring, spacing, and creation. Which players change, and which defensive roles become thinner?' },
]);
const brief = document.querySelector('#coachingBrief');
const apply = document.querySelector('#applyCoachingBrief');
const next = document.querySelector('#nextCoachingBrief');
let current = 0;

if (brief && apply && next) {
  // If the optimizer failed to initialize, do not advertise disconnected UI.
  const presets = prompts.map(prompt => document.querySelector(`#presetGrid [data-preset="${prompt.preset}"]`));
  if (presets.every(Boolean) && document.querySelector('.guided-workflow')) {
    brief.hidden = false;
    next.addEventListener('click', () => {
      current = (current + 1) % prompts.length;
      const prompt = prompts[current];
      document.querySelector('#coachingBriefNumber').textContent = `Practice prompt ${current + 1} of ${prompts.length}`;
      document.querySelector('#coachingBriefTitle').textContent = prompt.title;
      document.querySelector('#coachingBriefQuestion').textContent = prompt.question;
      document.querySelector('#coachingBriefStatus').textContent = '';
      apply.textContent = `Use ${prompt.label} focus`;
    });
    apply.addEventListener('click', () => {
      const preset = presets[current];
      if (preset.disabled || preset.closest('[hidden]')) return;
      preset.click();
      document.querySelector('#coachingBriefStatus').textContent = `${prompts[current].label} focus applied. Review the selected game plan below.`;
      preset.focus({ preventScroll:true });
    });
  }
}
