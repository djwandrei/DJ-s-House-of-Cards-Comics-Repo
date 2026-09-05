import { TOOL_REGISTRY, TOOL_STATUSES } from '../registry.js?v=20260905g';
import { WORKSHOP_DEFINITIONS, getWorkshopDefinition } from './definitions.js?v=20260905g';
import {
  clearWorkshopDraft,
  defaultWorkshopValues,
  loadWorkshopDraft,
  saveWorkshopDraft
} from './workshop-state.js';

const FALLBACK_EXPERIENCE_ID = WORKSHOP_DEFINITIONS[0]?.id || '';

function getToolForDefinition(definition) {
  const tool = TOOL_REGISTRY.find((entry) => entry.id === definition.id);
  return tool?.status === TOOL_STATUSES.PLANNED ? tool : null;
}

export function resolveWorkshopExperience(search = '', definitions = WORKSHOP_DEFINITIONS) {
  const requestedId = new URLSearchParams(search).get('experience');
  return definitions.find((definition) => definition.id === requestedId)
    || definitions.find((definition) => definition.id === FALLBACK_EXPERIENCE_ID)
    || definitions[0]
    || null;
}

function appendText(parent, tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  element.textContent = text;
  parent.append(element);
  return element;
}

function updateText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function renderTagList(id, values, className = '') {
  const container = document.getElementById(id);
  if (!container) return;
  container.replaceChildren();
  values.forEach((value) => appendText(container, 'span', className, value));
}

function renderStageList(definition) {
  const container = document.getElementById('workshopStages');
  if (!container) return;
  container.replaceChildren();
  definition.stages.forEach((stage, index) => {
    const item = document.createElement('li');
    item.className = 'workshop-stage-card';
    appendText(item, 'span', 'workshop-stage-number', String(index + 2).padStart(2, '0'));
    appendText(item, 'h3', '', stage.title);
    appendText(item, 'p', '', stage.summary);
    container.append(item);
  });
}

function renderDetailList(id, values) {
  const container = document.getElementById(id);
  if (!container) return;
  container.replaceChildren();
  values.forEach((value) => {
    const item = document.createElement('li');
    appendText(item, 'span', 'workshop-detail-icon', '•');
    appendText(item, 'span', '', value);
    container.append(item);
  });
}

function renderFields(definition, values) {
  const container = document.getElementById('workshopFields');
  if (!container) return;
  container.replaceChildren();

  definition.fields.forEach((field) => {
    const fieldId = `workshop-field-${field.id}`;
    const helpId = `${fieldId}-help`;
    const wrapper = document.createElement('div');
    wrapper.className = 'workshop-field';
    const label = appendText(wrapper, 'label', '', field.label);
    label.htmlFor = fieldId;
    const select = document.createElement('select');
    select.id = fieldId;
    select.name = field.id;
    select.setAttribute('aria-describedby', helpId);
    field.options.forEach((option) => {
      const optionElement = document.createElement('option');
      optionElement.value = option.value;
      optionElement.textContent = option.label;
      optionElement.selected = values[field.id] === option.value;
      select.append(optionElement);
    });
    wrapper.append(select);
    appendText(wrapper, 'p', 'workshop-field-help', field.help).id = helpId;
    container.append(wrapper);
  });
}

function formValues(definition) {
  const form = document.getElementById('workshopSetupForm');
  if (!form) return defaultWorkshopValues(definition);
  const entries = new FormData(form);
  return Object.fromEntries(definition.fields.map((field) => [field.id, String(entries.get(field.id) || '')]));
}

function formatSavedAt(savedAt) {
  const date = new Date(savedAt);
  if (Number.isNaN(date.valueOf())) return 'Saved locally';
  return `Saved locally ${new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }).format(date)}`;
}

function updateSavedState(draft) {
  updateText('workshopState', draft ? formatSavedAt(draft.savedAt) : 'Not saved');
}

function updateStatus(message, state = 'info') {
  const status = document.getElementById('workshopStatus');
  if (!status) return;
  status.textContent = message;
  status.dataset.state = state;
}

function updateUrl(experienceId) {
  const url = new URL(window.location.href);
  url.searchParams.set('experience', experienceId);
  window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
}

function browserStorage() {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function renderExperience(definition, options = {}) {
  const tool = getToolForDefinition(definition);
  if (!tool) {
    updateStatus('This planned experience is not available in the public registry yet.', 'error');
    return;
  }

  const draft = loadWorkshopDraft(browserStorage(), definition);
  const values = draft?.values || defaultWorkshopValues(definition);
  updateText('workshopEyebrow', tool.eyebrow);
  updateText('workshopTitle', tool.title);
  updateText('workshopSummary', tool.summary);
  updateText('workshopMarker', tool.marker);
  updateText('workshopCategory', definition.category);
  updateText('workshopPromptHeading', definition.prompt);
  updateText('workshopPrompt', 'This route stores only setup choices in this browser. The future adapter will be limited to the data, scoring, and evidence boundary documented below.');
  updateText('workshopNextMilestone', definition.nextMilestone);
  document.title = `${tool.title} Framework | DJ's House of Cards & Comics`;

  renderFields(definition, values);
  renderStageList(definition);
  renderDetailList('workshopResults', definition.resultContract);
  renderDetailList('workshopGuardrails', definition.guardrails);
  renderTagList('workshopConnections', definition.connectionPoints);
  renderTagList('workshopDataNeeds', tool.dependencies, 'workshop-data-tag');
  updateSavedState(draft);
  updateStatus(options.invalidRequest
    ? `${tool.title} is shown because the requested framework was not recognized.`
    : draft
      ? 'Your saved setup is loaded locally. Analytics and scoring remain disconnected.'
      : 'Choose a setup to document the future run locally. Analytics and scoring remain disconnected.', 'info');
}

function populatePicker(selectedId) {
  const picker = document.getElementById('experiencePicker');
  if (!picker) return;
  picker.replaceChildren();
  WORKSHOP_DEFINITIONS.forEach((definition) => {
    const tool = getToolForDefinition(definition);
    if (!tool) return;
    const option = document.createElement('option');
    option.value = definition.id;
    option.textContent = tool.title;
    option.selected = definition.id === selectedId;
    picker.append(option);
  });
}

function initializeWorkshop() {
  const definition = resolveWorkshopExperience(window.location.search);
  if (!definition) return;
  const requestedId = new URLSearchParams(window.location.search).get('experience');
  const invalidRequest = Boolean(requestedId && !getWorkshopDefinition(requestedId));
  populatePicker(definition.id);
  renderExperience(definition, { invalidRequest });

  document.getElementById('experiencePicker')?.addEventListener('change', (event) => {
    const nextDefinition = getWorkshopDefinition(event.currentTarget.value);
    if (!nextDefinition || !getToolForDefinition(nextDefinition)) return;
    updateUrl(nextDefinition.id);
    renderExperience(nextDefinition);
  });

  document.getElementById('workshopSetupForm')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const activeDefinition = resolveWorkshopExperience(window.location.search);
    if (!activeDefinition) return;
    try {
      const draft = saveWorkshopDraft(browserStorage(), activeDefinition, formValues(activeDefinition));
      updateSavedState(draft);
      updateStatus('Setup saved in this browser. The experience will remain in framework mode until its data and scoring adapters are reviewed.', 'success');
      window.dispatchEvent(new CustomEvent('djhc:fan-tool-framework-save', { detail: draft }));
    } catch {
      updateStatus('This browser did not allow local setup storage. You can still inspect the framework and its requirements.', 'error');
    }
  });

  document.getElementById('workshopReset')?.addEventListener('click', () => {
    const activeDefinition = resolveWorkshopExperience(window.location.search);
    if (!activeDefinition) return;
    clearWorkshopDraft(browserStorage(), activeDefinition);
    renderFields(activeDefinition, defaultWorkshopValues(activeDefinition));
    updateSavedState(null);
    updateStatus('Local setup reset. No analytics, account, catalog, or commerce data was changed.', 'info');
  });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeWorkshop, { once: true });
  } else {
    initializeWorkshop();
  }
}
