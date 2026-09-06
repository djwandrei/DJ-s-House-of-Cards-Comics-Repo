import assert from 'node:assert/strict';
import test from 'node:test';
import { TOOL_REGISTRY, TOOL_STATUSES } from '../../tools/registry.js';
import {
  WORKSHOP_DEFINITIONS,
  WORKSHOP_SCHEMA_VERSION,
  getWorkshopDefinition
} from '../../tools/workshop/definitions.js';
import { resolveWorkshopExperience } from '../../tools/workshop/tool-workshop.js';
import {
  clearWorkshopDraft,
  createWorkshopDraft,
  defaultWorkshopValues,
  loadWorkshopDraft,
  normalizeWorkshopValues,
  saveWorkshopDraft,
  workshopStorageKey
} from '../../tools/workshop/workshop-state.js';

class MemoryStorage {
  values = new Map();

  getItem(key) {
    return this.values.has(key) ? this.values.get(key) : null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

test('workshop definitions are allowlisted planned registry entries', () => {
  const ids = WORKSHOP_DEFINITIONS.map((definition) => definition.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(ids.length, 3);

  WORKSHOP_DEFINITIONS.forEach((definition) => {
    const tool = TOOL_REGISTRY.find((entry) => entry.id === definition.id);
    assert.ok(tool, `${definition.id} is missing from the fan tool registry`);
    assert.equal(tool.status, TOOL_STATUSES.PLANNED);
    assert.equal(new URL(tool.href, 'https://local.djhc.test/tools/').pathname, '/tools/workshop/');
    assert.equal(new URL(tool.href, 'https://local.djhc.test/tools/').searchParams.get('experience'), definition.id);
    assert.equal(getWorkshopDefinition(definition.id), definition);
    assert.ok(definition.category.length > 3);
    assert.ok(definition.prompt.length > 20);
    assert.equal(definition.fields.length, 3);
    assert.equal(definition.stages.length, 3);
    assert.ok(definition.resultContract.length >= 3);
    assert.ok(definition.guardrails.length >= 3);
    assert.ok(definition.connectionPoints.length >= 3);
    assert.ok(definition.nextMilestone.length > 30);

    const fieldIds = definition.fields.map((field) => field.id);
    assert.equal(new Set(fieldIds).size, fieldIds.length, `${definition.id} reuses a field id`);
    definition.fields.forEach((field) => {
      assert.match(field.id, /^[a-z0-9-]+$/);
      assert.ok(field.label.length > 2);
      assert.ok(field.help.length > 10);
      assert.ok(field.options.length >= 2);
      assert.ok(field.options.some((option) => option.value === field.defaultValue));
    });
  });
});

test('workshop resolver never exposes an unregistered query experience', () => {
  assert.equal(resolveWorkshopExperience('?experience=scouts-call')?.id, 'scouts-call');
  assert.equal(resolveWorkshopExperience('?experience=lineup-dna')?.id, WORKSHOP_DEFINITIONS[0].id);
  assert.equal(resolveWorkshopExperience('?experience=five-role-draft')?.id, WORKSHOP_DEFINITIONS[0].id);
  assert.equal(resolveWorkshopExperience('?experience=not-a-real-tool')?.id, WORKSHOP_DEFINITIONS[0].id);
  assert.equal(resolveWorkshopExperience('')?.id, WORKSHOP_DEFINITIONS[0].id);
  assert.equal(getWorkshopDefinition('not-a-real-tool'), null);
});

test('user-retired concepts cannot return to the registry or workshop picker', () => {
  for (const id of ['two-truths-one-box-score', 'evidence-court', 'statline-sleuth',
    'optimizer-sensitivity-studio', 'franchise-fingerprints', 'phase-flip']) {
    assert.equal(TOOL_REGISTRY.some(tool => tool.id === id), false, `${id} remains in the roadmap`);
    assert.equal(getWorkshopDefinition(id), null);
    assert.equal(resolveWorkshopExperience(`?experience=${id}`)?.id, WORKSHOP_DEFINITIONS[0].id,
      'A retired deep link must use the existing honest unrecognized-framework fallback');
  }
  assert.deepEqual(WORKSHOP_DEFINITIONS.map(definition => definition.id), ['rotation-rescue', 'scouts-call', 'what-breaks-this-five']);
});

test('workshop local drafts are namespaced and restricted to declared fields', () => {
  const definition = getWorkshopDefinition('rotation-rescue');
  const storage = new MemoryStorage();
  const defaults = defaultWorkshopValues(definition);
  const normalized = normalizeWorkshopValues(definition, {
    'build-scope': 'full-rotation',
    'challenge-source': 'malicious-value',
    unknown: 'discarded'
  });

  assert.equal(workshopStorageKey(definition.id), `djhc:fan-tool:${definition.id}:v${WORKSHOP_SCHEMA_VERSION}`);
  assert.throws(() => workshopStorageKey('../invalid'), /valid fan-tool experience ID/);
  assert.deepEqual(defaults, {
    'build-scope': 'best-five',
    'challenge-source': 'daily',
    difficulty: 'standard'
  });
  assert.deepEqual(normalized, {
    'build-scope': 'full-rotation',
    'challenge-source': 'daily',
    difficulty: 'standard'
  });
  assert.equal(loadWorkshopDraft(null, definition), null);
  assert.doesNotThrow(() => clearWorkshopDraft(null, definition));
  assert.throws(() => saveWorkshopDraft(null, definition, normalized), /storage is unavailable/);

  const draft = saveWorkshopDraft(storage, definition, normalized, '2026-09-02T18:00:00.000Z');
  assert.equal(draft.schemaVersion, WORKSHOP_SCHEMA_VERSION);
  assert.deepEqual(loadWorkshopDraft(storage, definition), draft);
  assert.deepEqual(createWorkshopDraft(definition, { difficulty: 'expert' }, '2026-09-02T18:01:00.000Z').values, {
    'build-scope': 'best-five',
    'challenge-source': 'daily',
    difficulty: 'expert'
  });

  storage.setItem(workshopStorageKey(definition.id), '{not-json');
  assert.equal(loadWorkshopDraft(storage, definition), null);
  clearWorkshopDraft(storage, definition);
  assert.equal(storage.getItem(workshopStorageKey(definition.id)), null);
});
