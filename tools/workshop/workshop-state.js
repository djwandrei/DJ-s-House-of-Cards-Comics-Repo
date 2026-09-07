import { WORKSHOP_SCHEMA_VERSION } from './definitions.js?v=20260907c';

const EXPERIENCE_ID_PATTERN = /^[a-z0-9-]+$/;
const STORAGE_PREFIX = 'djhc:fan-tool:';

export function workshopStorageKey(experienceId) {
  const normalizedId = String(experienceId || '').trim();
  if (!EXPERIENCE_ID_PATTERN.test(normalizedId)) {
    throw new TypeError('A valid fan-tool experience ID is required.');
  }
  return `${STORAGE_PREFIX}${normalizedId}:v${WORKSHOP_SCHEMA_VERSION}`;
}

export function defaultWorkshopValues(definition) {
  return Object.freeze(Object.fromEntries(
    definition.fields.map((field) => [field.id, field.defaultValue])
  ));
}

export function normalizeWorkshopValues(definition, candidate = {}) {
  return Object.freeze(Object.fromEntries(definition.fields.map((field) => {
    const allowedValues = new Set(field.options.map((option) => option.value));
    const requestedValue = typeof candidate[field.id] === 'string' ? candidate[field.id] : '';
    return [field.id, allowedValues.has(requestedValue) ? requestedValue : field.defaultValue];
  })));
}

export function createWorkshopDraft(definition, candidateValues = {}, savedAt = new Date().toISOString()) {
  return Object.freeze({
    schemaVersion: WORKSHOP_SCHEMA_VERSION,
    experienceId: definition.id,
    savedAt,
    values: normalizeWorkshopValues(definition, candidateValues)
  });
}

export function loadWorkshopDraft(storage, definition) {
  if (!storage?.getItem) return null;

  try {
    const parsed = JSON.parse(storage.getItem(workshopStorageKey(definition.id)) || 'null');
    if (!parsed || parsed.schemaVersion !== WORKSHOP_SCHEMA_VERSION || parsed.experienceId !== definition.id) return null;
    return createWorkshopDraft(definition, parsed.values, typeof parsed.savedAt === 'string' ? parsed.savedAt : '');
  } catch {
    return null;
  }
}

export function saveWorkshopDraft(storage, definition, candidateValues, savedAt) {
  if (!storage?.setItem) throw new TypeError('Workshop storage is unavailable.');
  const draft = createWorkshopDraft(definition, candidateValues, savedAt);
  storage.setItem(workshopStorageKey(definition.id), JSON.stringify(draft));
  return draft;
}

export function clearWorkshopDraft(storage, definition) {
  if (!storage?.removeItem) return;
  storage.removeItem(workshopStorageKey(definition.id));
}
