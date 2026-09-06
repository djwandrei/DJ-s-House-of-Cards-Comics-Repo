export const WORKSHOP_SCHEMA_VERSION = 1;

function freezeField(field) {
  return Object.freeze({
    ...field,
    options: Object.freeze(field.options.map((option) => Object.freeze({ ...option })))
  });
}

function freezeStage(stage) {
  return Object.freeze({ ...stage });
}

function freezeDefinition(definition) {
  return Object.freeze({
    ...definition,
    fields: Object.freeze(definition.fields.map(freezeField)),
    stages: Object.freeze(definition.stages.map(freezeStage)),
    resultContract: Object.freeze([...definition.resultContract]),
    guardrails: Object.freeze([...definition.guardrails]),
    connectionPoints: Object.freeze([...definition.connectionPoints])
  });
}

const option = (value, label) => Object.freeze({ value, label });

export const WORKSHOP_DEFINITIONS = Object.freeze([
  freezeDefinition({
    id: 'rotation-rescue',
    category: 'Optimizer challenge',
    prompt: 'Can you solve the coaching brief without breaking the rotation?',
    fields: [
      {
        id: 'build-scope',
        label: 'Build scope',
        help: 'Choose the decision surface the future challenge adapter will load.',
        defaultValue: 'best-five',
        options: [option('best-five', 'Best five'), option('full-rotation', 'Full 240-minute rotation')]
      },
      {
        id: 'challenge-source',
        label: 'Challenge source',
        help: 'Seeded modes keep the brief and answer key reproducible.',
        defaultValue: 'daily',
        options: [option('daily', 'Daily seed'), option('weekly', 'Weekly feature'), option('practice', 'Practice pool')]
      },
      {
        id: 'difficulty',
        label: 'Constraint level',
        help: 'Difficulty will control the number of locks, exclusions, role rules, and minute limits.',
        defaultValue: 'standard',
        options: [option('rookie', 'Rookie'), option('standard', 'Standard'), option('expert', 'Expert')]
      }
    ],
    stages: [
      { title: 'Brief', summary: 'Load one versioned historical team-season, roster pool, objective, and visible constraints.' },
      { title: 'Build', summary: 'Collect the user five or rotation without mutating Lineup Lab, catalog, or account state.' },
      { title: 'Compare', summary: 'Run the exact optimizer and explain constraint completion and distance from the defined optimum.' }
    ],
    resultContract: ['Chosen lineup or rotation', 'Constraint-by-constraint audit', 'Exact optimizer comparison', 'Versioned run card'],
    guardrails: ['No predicted season wins', 'No hidden minute caps', 'Five-player rows must remain exact lineups'],
    connectionPoints: ['optimizer-core.js worker', 'lineup-role-model.js', 'rotation-unit-planner.js', 'versioned challenge pack'],
    nextMilestone: 'Connect one reviewed team-season fixture to the exact optimizer and finish a single deterministic challenge end to end.'
  }),
  freezeDefinition({
    id: 'scouts-call',
    category: 'Coaching decision game',
    prompt: 'Which priorities and counter-lineup best answer this historical opponent?',
    fields: [
      {
        id: 'brief-type',
        label: 'Scouting brief',
        help: 'The first adapter can start with a fixed, reviewed opponent profile.',
        defaultValue: 'balanced',
        options: [option('balanced', 'Balanced opponent'), option('paint-pressure', 'Paint pressure'), option('spacing', 'Spacing and shooting')]
      },
      {
        id: 'decision-depth',
        label: 'Decision depth',
        help: 'Choose whether the round asks only for priorities or also asks for a five-player answer.',
        defaultValue: 'priorities-lineup',
        options: [option('priorities', 'Priorities only'), option('priorities-lineup', 'Priorities and lineup')]
      },
      {
        id: 'reveal-style',
        label: 'Reveal style',
        help: 'Every reveal will retain source and limitation labels.',
        defaultValue: 'guided',
        options: [option('guided', 'Guided explanation'), option('side-by-side', 'Side-by-side comparison')]
      }
    ],
    stages: [
      { title: 'Scout', summary: 'Present observed opponent strengths, weaknesses, sample scope, and the historical season boundary.' },
      { title: 'Call', summary: 'Capture priorities and a counter-lineup through Lineup Lab-compatible identifiers.' },
      { title: 'Debrief', summary: 'Compare the call with the game-plan helper and explain where the choices agree or diverge.' }
    ],
    resultContract: ['Selected priorities', 'Counter-lineup handoff', 'Source-labeled game-plan comparison', 'Limitations panel'],
    guardrails: ['No live injury or schedule claims', 'No unsupported player assignments', 'Observed profile is not proof of tactics'],
    connectionPoints: ['opponent-gameplan.js', 'fan-analytics.js', 'Lineup Lab scenario URL', 'historical team profile adapter'],
    nextMilestone: 'Bind a single opponent-profile fixture to the existing priority model and validate a round-trip Lineup Lab handoff.'
  }),
  freezeDefinition({
    id: 'what-breaks-this-five',
    category: 'Lineup weakness game',
    prompt: 'Which missing role or trade-off breaks this five?',
    fields: [
      {
        id: 'case-source',
        label: 'Lineup cases',
        help: 'Every case must use one exact, reviewed five-player unit.',
        defaultValue: 'historical',
        options: [option('historical', 'Historical lineups'), option('lab', 'Lineup Lab scenarios')]
      },
      {
        id: 'answer-mode',
        label: 'Answer mode',
        help: 'Role choices use the same definitions as the explanation layer.',
        defaultValue: 'role-gap',
        options: [option('role-gap', 'Missing role'), option('trade-off', 'Biggest trade-off'), option('replacement', 'Best single change')]
      },
      {
        id: 'reveal-depth',
        label: 'Reveal depth',
        help: 'The detailed view separates exact facts, model outputs, and proxies.',
        defaultValue: 'detailed',
        options: [option('quick', 'Quick answer'), option('detailed', 'Detailed breakdown')]
      }
    ],
    stages: [
      { title: 'Inspect', summary: 'Present one exact five and the public-safe facts available for each selected player-season.' },
      { title: 'Diagnose', summary: 'Capture the expected role gap, trade-off, or single substitution before showing model output.' },
      { title: 'Explain', summary: 'Compare the choice with role coverage, objective metrics, exact feasibility, and evidence labels.' }
    ],
    resultContract: ['Lineup case ID', 'User diagnosis', 'Role-coverage explanation', 'One modeled alternative'],
    guardrails: ['Exact five-player lineups only', 'Defensive box-score signals stay proxies', 'Modeled fit is not observed causation'],
    connectionPoints: ['lineup-role-model.js', 'fan-analytics.js', 'optimizer-core.js worker', 'reviewed lineup case bank'],
    nextMilestone: 'Publish one reviewed lineup case and validate the diagnosis, explanation, and Lineup Lab handoff states.'
  })
]);

export const WORKSHOP_DEFINITION_BY_ID = Object.freeze(Object.fromEntries(
  WORKSHOP_DEFINITIONS.map((definition) => [definition.id, definition])
));

export function getWorkshopDefinition(id) {
  return WORKSHOP_DEFINITION_BY_ID[String(id || '').trim()] || null;
}
