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
    category: 'Rotation challenge',
    prompt: 'Can you build the requested five or rotation while following the rules?',
    fields: [
      {
        id: 'build-scope',
        label: 'What you will build',
        help: 'Choose between a five-player lineup and a full 240-minute rotation.',
        defaultValue: 'best-five',
        options: [option('best-five', 'Best five'), option('full-rotation', 'Full 240-minute rotation')]
      },
      {
        id: 'challenge-source',
        label: 'Challenge source',
        help: 'The selected source sets which reviewed challenge brief appears.',
        defaultValue: 'daily',
        options: [option('daily', 'Daily seed'), option('weekly', 'Weekly feature'), option('practice', 'Practice pool')]
      },
      {
        id: 'difficulty',
        label: 'Rule level',
        help: 'A higher level can add more locks, exclusions, role rules, or minute limits.',
        defaultValue: 'standard',
        options: [option('rookie', 'Rookie'), option('standard', 'Standard'), option('expert', 'Expert')]
      }
    ],
    stages: [
      { title: 'Read the brief', summary: 'See the historical team-season, player pool, objective, and rules for this challenge.' },
      { title: 'Build your answer', summary: 'Choose a five or rotation without changing Lineup Lab, the catalog, or your account.' },
      { title: 'Review the result', summary: 'See which rules you met and how your answer compares with the defined best solution.' }
    ],
    resultContract: ['Your chosen lineup or rotation', 'A rule-by-rule explanation', 'A comparison with the defined best solution', 'A saved run summary'],
    guardrails: ['No prediction of season wins', 'No hidden minute limits', 'Five-player rows remain exact lineups'],
    connectionPoints: ['optimizer-core.js worker', 'lineup-role-model.js', 'rotation-unit-planner.js', 'versioned challenge pack'],
    nextMilestone: 'Connect one reviewed team-season example to the exact optimizer and complete one challenge from start to finish.'
  }),
  freezeDefinition({
    id: 'scouts-call',
    category: 'Historical game-plan challenge',
    prompt: 'Which priorities and lineup best answer this historical opponent?',
    fields: [
      {
        id: 'brief-type',
        label: 'Scouting brief',
        help: 'Start with one reviewed historical opponent profile.',
        defaultValue: 'balanced',
        options: [option('balanced', 'Balanced opponent'), option('paint-pressure', 'Paint pressure'), option('spacing', 'Spacing and shooting')]
      },
      {
        id: 'decision-depth',
        label: 'Decision depth',
        help: 'Choose whether you set priorities only or also build a five-player answer.',
        defaultValue: 'priorities-lineup',
        options: [option('priorities', 'Priorities only'), option('priorities-lineup', 'Priorities and lineup')]
      },
      {
        id: 'reveal-style',
        label: 'Reveal style',
        help: 'Every result will show its source and limitations.',
        defaultValue: 'guided',
        options: [option('guided', 'Guided explanation'), option('side-by-side', 'Side-by-side comparison')]
      }
    ],
    stages: [
      { title: 'Read the profile', summary: 'See the opponent strengths, weaknesses, sample size, and historical season boundary.' },
      { title: 'Make your call', summary: 'Choose priorities and, if requested, build a counter-lineup.' },
      { title: 'Review the debrief', summary: 'Compare your choices with the reviewed game-plan helper and see where they agree or differ.' }
    ],
    resultContract: ['Your selected priorities', 'Your counter-lineup when requested', 'A source-labeled comparison', 'A limitations note'],
    guardrails: ['No live injury or schedule claims', 'No unsupported player assignments', 'Observed profile is not proof of tactics'],
    connectionPoints: ['opponent-gameplan.js', 'fan-analytics.js', 'Lineup Lab scenario URL', 'historical team profile adapter'],
    nextMilestone: 'Connect one reviewed opponent profile to the existing priority model and test the Lineup Lab handoff.'
  }),
  freezeDefinition({
    id: 'what-breaks-this-five',
    category: 'Lineup explanation game',
    prompt: 'Which missing role or trade-off matters most in this five?',
    fields: [
      {
        id: 'case-source',
        label: 'Lineup cases',
        help: 'Each case uses one exact, reviewed five-player lineup.',
        defaultValue: 'historical',
        options: [option('historical', 'Historical lineups'), option('lab', 'Lineup Lab scenarios')]
      },
      {
        id: 'answer-mode',
        label: 'Answer mode',
        help: 'The answer choices use the same role definitions as Lineup Lab.',
        defaultValue: 'role-gap',
        options: [option('role-gap', 'Missing role'), option('trade-off', 'Biggest trade-off'), option('replacement', 'Best single change')]
      },
      {
        id: 'reveal-depth',
        label: 'Reveal depth',
        help: 'The detailed view separates facts, model outputs, and proxies.',
        defaultValue: 'detailed',
        options: [option('quick', 'Quick answer'), option('detailed', 'Detailed breakdown')]
      }
    ],
    stages: [
      { title: 'Inspect the five', summary: 'See the exact lineup and the public facts available for each selected player-season.' },
      { title: 'Make a diagnosis', summary: 'Choose the role gap, trade-off, or single change you think matters before seeing the model view.' },
      { title: 'Review the explanation', summary: 'Compare your answer with role coverage, objective metrics, feasibility, and evidence labels.' }
    ],
    resultContract: ['The selected lineup case', 'Your diagnosis', 'A role-coverage explanation', 'One modeled alternative'],
    guardrails: ['Exact five-player lineups only', 'Defensive box-score signals stay proxies', 'Modeled fit is not observed causation'],
    connectionPoints: ['lineup-role-model.js', 'fan-analytics.js', 'optimizer-core.js worker', 'reviewed lineup case bank'],
    nextMilestone: 'Publish one reviewed lineup case and test the diagnosis, explanation, and Lineup Lab handoff.'
  })
]);

export const WORKSHOP_DEFINITION_BY_ID = Object.freeze(Object.fromEntries(
  WORKSHOP_DEFINITIONS.map((definition) => [definition.id, definition])
));

export function getWorkshopDefinition(id) {
  return WORKSHOP_DEFINITION_BY_ID[String(id || '').trim()] || null;
}
