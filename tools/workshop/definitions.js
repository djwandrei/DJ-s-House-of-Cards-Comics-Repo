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
    id: 'statline-sleuth',
    category: 'Stat identification quiz',
    prompt: 'Who, when, or which team is hiding behind the clue?',
    fields: [
      {
        id: 'clue-subject',
        label: 'Clue subject',
        help: 'Each subject requires a reviewed question and one unambiguous answer.',
        defaultValue: 'player',
        options: [option('player', 'Player'), option('team', 'Team'), option('season', 'Season or era')]
      },
      {
        id: 'round-set',
        label: 'Round set',
        help: 'Daily and seeded sets will use fixed question-bank versions.',
        defaultValue: 'daily',
        options: [option('daily', 'Daily five'), option('practice', 'Practice five'), option('marathon', 'Ten-round run')]
      },
      {
        id: 'timer',
        label: 'Timer',
        help: 'Time can affect a bonus, but never whether the underlying answer is correct.',
        defaultValue: 'relaxed',
        options: [option('off', 'Off'), option('relaxed', '30 seconds'), option('quick', '15 seconds')]
      }
    ],
    stages: [
      { title: 'Clue', summary: 'Load one reviewed stat clue with source, scope, stable answer ID, and question-bank version.' },
      { title: 'Guess', summary: 'Capture one answer or a bounded multiple-choice selection and optional time bonus.' },
      { title: 'Reveal', summary: 'Show the exact answer, supporting values, source scope, and why other choices fail.' }
    ],
    resultContract: ['Round-by-round answers', 'Accuracy and optional time score', 'Evidence-backed reveals', 'Question-bank version'],
    guardrails: ['Reviewed questions only', 'No ambiguous identity matches', 'No clues from incomplete records'],
    connectionPoints: ['public player-season summaries', 'historical team summaries', 'versioned question bank', 'seeded round helper'],
    nextMilestone: 'Publish a tiny reviewed fixture bank and complete a five-question local game loop with deterministic scoring.'
  }),
  freezeDefinition({
    id: 'evidence-court',
    category: 'Analytics literacy quiz',
    prompt: 'Is the claim a fact, reconstruction, model estimate, proxy, or unsupported?',
    fields: [
      {
        id: 'case-pack',
        label: 'Case pack',
        help: 'The first release can use hand-reviewed examples without loading private analytics.',
        defaultValue: 'mixed',
        options: [option('mixed', 'Mixed evidence'), option('lineups', 'Lineups and co-presence'), option('models', 'Models and proxies')]
      },
      {
        id: 'round-count',
        label: 'Case count',
        help: 'Short sessions support a quick, complete ending.',
        defaultValue: 'five',
        options: [option('three', '3 cases'), option('five', '5 cases'), option('ten', '10 cases')]
      },
      {
        id: 'explanation',
        label: 'Explanation timing',
        help: 'Every case includes an explanation; this setting changes when it appears.',
        defaultValue: 'each',
        options: [option('each', 'After each case'), option('end', 'At the end')]
      }
    ],
    stages: [
      { title: 'Claim', summary: 'Present a versioned scenario using the same evidence language shown across DJHC analytics.' },
      { title: 'Verdict', summary: 'Capture one of five explicit evidence classifications without grading confidence as certainty.' },
      { title: 'Reasoning', summary: 'Explain the correct boundary, source scope, and the conclusion the evidence cannot support.' }
    ],
    resultContract: ['Case verdicts', 'Classification accuracy', 'Explanation for every case', 'Evidence glossary links'],
    guardrails: ['No causal leap from correlation', 'No private records needed', 'Unsupported is a valid and visible answer'],
    connectionPoints: ['curated scenario bank', 'evidence-level glossary', 'source-label component', 'deterministic scoring helper'],
    nextMilestone: 'Ship five reviewed cases that cover every evidence class and test the full answer-and-explanation loop.'
  }),
  freezeDefinition({
    id: 'optimizer-sensitivity-studio',
    category: 'Transparent optimizer tool',
    prompt: 'What must change before the optimizer changes its answer?',
    fields: [
      {
        id: 'sweep-target',
        label: 'Sweep target',
        help: 'Only declared model settings are eligible for a controlled sweep.',
        defaultValue: 'objective-weights',
        options: [option('objective-weights', 'Objective weights'), option('role-thresholds', 'Role thresholds'), option('one-constraint', 'One constraint')]
      },
      {
        id: 'build-scope',
        label: 'Optimization scope',
        help: 'Best-five and full-rotation results have different feasibility requirements.',
        defaultValue: 'best-five',
        options: [option('best-five', 'Best five'), option('full-rotation', 'Full rotation')]
      },
      {
        id: 'comparison',
        label: 'Comparison view',
        help: 'The result must preserve the exact settings used for every run.',
        defaultValue: 'stability',
        options: [option('stability', 'Selection stability'), option('alternatives', 'Alternative frontier')]
      }
    ],
    stages: [
      { title: 'Baseline', summary: 'Capture the historical pool, constraints, objective weights, and one exact baseline solution.' },
      { title: 'Sweep', summary: 'Run bounded, reproducible setting changes through the existing exact solver worker.' },
      { title: 'Explain', summary: 'Show stable selections, switch points, feasible alternatives, and the settings behind each result.' }
    ],
    resultContract: ['Baseline solution', 'Declared sweep range', 'Selection switch points', 'Feasible alternative set'],
    guardrails: ['Model stability is not player truth', 'Every run exposes its settings', 'Infeasible scenarios end explicitly'],
    connectionPoints: ['optimizer-core.js worker', 'optimizer-config.js', 'scenario-url.js', 'Pareto alternative proof'],
    nextMilestone: 'Complete one bounded single-weight sweep against a fixed team-season and verify every result with the exact solver.'
  }),
  freezeDefinition({
    id: 'franchise-fingerprints',
    category: 'Historical team quiz',
    prompt: 'Which franchise or era left this statistical fingerprint?',
    fields: [
      {
        id: 'answer-type',
        label: 'Answer type',
        help: 'The answer key controls which identifying details remain hidden during the round.',
        defaultValue: 'franchise',
        options: [option('franchise', 'Franchise'), option('era', 'Era'), option('both', 'Franchise and era')]
      },
      {
        id: 'profile-depth',
        label: 'Profile depth',
        help: 'Observed profile fields must remain understandable without tactical overreach.',
        defaultValue: 'standard',
        options: [option('quick', '3 signals'), option('standard', '5 signals'), option('deep', '8 signals')]
      },
      {
        id: 'round-set',
        label: 'Round set',
        help: 'Versioned sets protect old scores and share cards from silent answer changes.',
        defaultValue: 'daily',
        options: [option('daily', 'Daily card'), option('practice', 'Practice set')]
      }
    ],
    stages: [
      { title: 'Mask', summary: 'Select a reviewed team-season and hide direct team, player, city, and logo identifiers.' },
      { title: 'Identify', summary: 'Reveal observed shooting, passing, turnover, and rebounding signals in a fixed order.' },
      { title: 'Unmask', summary: 'Show the franchise, season, exact source fields, and a careful profile explanation.' }
    ],
    resultContract: ['Anonymous profile card', 'Guess history', 'Franchise and season reveal', 'Observed field definitions'],
    guardrails: ['No unsupported tactical labels', 'No identifiers leak into clue text', 'Only reviewed answer keys publish'],
    connectionPoints: ['historical team totals', 'team-profile derivation', 'versioned question bank', 'source-label component'],
    nextMilestone: 'Create and leakage-test a five-card anonymous fixture pack from approved historical team-season profiles.'
  }),
  freezeDefinition({
    id: 'two-truths-one-box-score',
    category: 'Player-season fact game',
    prompt: 'Which of the three player-season claims is false?',
    fields: [
      {
        id: 'round-set',
        label: 'Round set',
        help: 'Every three-claim set must be fixed and reviewed before it is eligible.',
        defaultValue: 'daily',
        options: [option('daily', 'Daily five'), option('practice', 'Practice five')]
      },
      {
        id: 'stat-scope',
        label: 'Stat scope',
        help: 'Rate questions require explicit denominators and minimum samples.',
        defaultValue: 'mixed',
        options: [option('totals', 'Season totals'), option('rates', 'Rates and percentages'), option('mixed', 'Mixed')]
      },
      {
        id: 'reveal-style',
        label: 'Reveal style',
        help: 'The supporting values remain visible in either mode.',
        defaultValue: 'each',
        options: [option('each', 'After each round'), option('end', 'End of set')]
      }
    ],
    stages: [
      { title: 'Deal', summary: 'Load one exact athlete-season identity and three assertions from a reviewed bank.' },
      { title: 'Challenge', summary: 'Capture the false-claim choice without changing the underlying assertion order or answer.' },
      { title: 'Check', summary: 'Reveal the exact supporting values, source, phase, and reason the selected claim is true or false.' }
    ],
    resultContract: ['Selected false claims', 'Accuracy score', 'Exact supporting stat lines', 'Assertion-bank version'],
    guardrails: ['Exact athlete-season mappings only', 'No generated unreviewed prose', 'Rate denominators remain visible'],
    connectionPoints: ['verified player-season summaries', 'athlete identity mapping', 'reviewed assertion bank', 'daily seed helper'],
    nextMilestone: 'Build ten reviewed three-claim fixtures from exact NBA player-season mappings and validate every answer automatically.'
  }),
  freezeDefinition({
    id: 'phase-flip',
    category: 'Season-phase prediction game',
    prompt: 'Did this metric rise or fall when the postseason began?',
    fields: [
      {
        id: 'metric-family',
        label: 'Metric family',
        help: 'The reveal must show the exact rate or volume definition.',
        defaultValue: 'rate',
        options: [option('rate', 'Rate metric'), option('volume', 'Volume metric'), option('efficiency', 'Efficiency metric')]
      },
      {
        id: 'sample-policy',
        label: 'Sample policy',
        help: 'Rounds that miss the selected threshold are omitted instead of guessed.',
        defaultValue: 'standard',
        options: [option('inclusive', 'Inclusive'), option('standard', 'Standard'), option('strict', 'Strict')]
      },
      {
        id: 'round-set',
        label: 'Round set',
        help: 'A fixed set keeps phase comparisons and omissions reproducible.',
        defaultValue: 'practice',
        options: [option('daily', 'Daily five'), option('practice', 'Practice five')]
      }
    ],
    stages: [
      { title: 'Match', summary: 'Load verified regular-season and postseason rows for the same exact player-season and metric definition.' },
      { title: 'Predict', summary: 'Record rise, fall, or effectively unchanged using a declared comparison rule.' },
      { title: 'Context', summary: 'Reveal both values, games, minutes, denominators, difference, and the sample warning.' }
    ],
    resultContract: ['Direction prediction', 'Both phase values', 'Games and minutes context', 'Declared comparison threshold'],
    guardrails: ['Missing phases are omitted', 'Small samples remain visible', 'Direction does not imply a causal playoff effect'],
    connectionPoints: ['regular-season summary rows', 'postseason summary rows', 'sample-policy helper', 'reviewed round bank'],
    nextMilestone: 'Validate a five-round fixture set where both phases, denominators, and sample labels are complete.'
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
