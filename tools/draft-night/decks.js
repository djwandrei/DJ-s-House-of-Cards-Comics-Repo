import { FIX_THE_FIVE_SCHEMA_VERSION } from '../fix-the-five/game-engine.js?v=20260905g';
import { FIX_THE_FIVE_SOURCE } from '../fix-the-five/fixtures.js?v=20260905g';

const balanced = Object.freeze({ points: 18, efgPct: 12, threePct: 12, rebounds: 16, assists: 16, steals: 12, blocks: 8, ballSecurity: 6 });
const spacing = Object.freeze({ points: 14, efgPct: 20, threePct: 36, rebounds: 8, assists: 8, steals: 5, blocks: 3, ballSecurity: 6 });
const creation = Object.freeze({ points: 18, efgPct: 8, threePct: 10, rebounds: 6, assists: 36, steals: 8, blocks: 4, ballSecurity: 10 });
const defense = Object.freeze({ points: 6, efgPct: 6, threePct: 6, rebounds: 22, assists: 8, steals: 25, blocks: 20, ballSecurity: 7 });
const glass = Object.freeze({ points: 8, efgPct: 12, threePct: 6, rebounds: 38, assists: 8, steals: 10, blocks: 12, ballSecurity: 6 });
const closing = Object.freeze({ points: 8, efgPct: 18, threePct: 12, rebounds: 8, assists: 28, steals: 10, blocks: 4, ballSecurity: 12 });
const scoring = Object.freeze({ points: 42, efgPct: 24, threePct: 16, rebounds: 6, assists: 5, steals: 2, blocks: 1, ballSecurity: 4 });
const rim = Object.freeze({ points: 4, efgPct: 8, threePct: 2, rebounds: 30, assists: 4, steals: 8, blocks: 38, ballSecurity: 6 });

const ROUNDS = Object.freeze([
  Object.freeze({ id: 'lead', title: 'Lead creator', prompt: 'Set the tempo with one source-listed guard.', candidateIds: Object.freeze(['dangelo-russell', 'patrick-beverley', 'jordan-mclaughlin']) }),
  Object.freeze({ id: 'scorer', title: 'Scoring guard', prompt: 'Add a guard who can carry a complementary scoring signal.', candidateIds: Object.freeze(['anthony-edwards', 'jaylen-nowell', 'malik-beasley']) }),
  Object.freeze({ id: 'wing', title: 'Wing connector', prompt: 'Choose the wing who gives your five a clearer balance point.', candidateIds: Object.freeze(['jaden-mcdaniels', 'taurean-prince', 'josh-okogie']) }),
  Object.freeze({ id: 'forward', title: 'Frontcourt support', prompt: 'Complete the forward pairing from the published board.', candidateIds: Object.freeze(['jarred-vanderbilt', 'jake-layman', 'leandro-bolmaro']) }),
  Object.freeze({ id: 'big', title: 'Centerpiece big', prompt: 'Close your five with one legal big.', candidateIds: Object.freeze(['karl-anthony-towns', 'naz-reid', 'nathan-knight']) }),
]);

function deck(id, title, brief, focus, objectiveWeights) {
  return Object.freeze({
    schemaVersion: FIX_THE_FIVE_SCHEMA_VERSION,
    id,
    reviewStatus: 'reviewed',
    source: FIX_THE_FIVE_SOURCE,
    title,
    brief,
    focus,
    objectiveWeights,
    positionMinimums: Object.freeze({ G: 2, F: 2, C: 1 }),
    rounds: ROUNDS,
    reviewNote: 'This is a curated release deck whose 3×3×3×3×3 board is re-evaluated by the published Draft Night scoring engine before release; it is not an independent scouting review.',
  });
}

/**
 * Eight source-labeled historical draft boards. The candidates remain small,
 * distinct, and fully reviewable; the daily seed picks one objective before
 * the visitor begins drafting.
 */
export const DRAFT_NIGHT_DECKS = Object.freeze([
  deck(
    'min-2022-balanced-build',
    'All-around five',
    'Draft a five that gives a source-bounded historical roster a little of everything.',
    'The board values a balanced blend of scoring, creation, glass work, and ball pressure.',
    balanced,
  ),
  deck(
    'min-2022-space-build',
    'Space the floor',
    'Build a five with clearer shooting and efficiency signals around its primary ballhandlers.',
    'Three-point percentage and efficiency lead this fixed historical-board comparison.',
    spacing,
  ),
  deck(
    'min-2022-creation-build',
    'Two-creator build',
    'Draft a five designed to spread decision-making across more than one player.',
    'Assists and ball security lead this fixed historical-board comparison.',
    creation,
  ),
  deck(
    'min-2022-pressure-build',
    'Pressure build',
    'Draft a five with a stronger box-score disruption and frontcourt coverage signal.',
    'Steals, rebounds, and blocks lead this fixed historical-board comparison; steals remain a proxy.',
    defense,
  ),
  deck(
    'min-2022-glass-build',
    'Own the glass',
    'Draft a five that makes finishing possessions the priority.',
    'Rebounding is the largest objective weight on this fixed historical-board comparison.',
    glass,
  ),
  deck(
    'min-2022-closing-build',
    'Close with control',
    'Draft a five that keeps decision-making and efficient possessions at the center of the published comparison.',
    'Assists, ball security, and efficiency lead this fixed historical-board comparison.',
    closing,
  ),
  deck(
    'min-2022-scoring-build',
    'Chase points',
    'Build the board\'s strongest source-bounded scoring five without turning the result into a game forecast.',
    'Scoring volume, efficiency, and 3-point accuracy lead this fixed historical-board comparison.',
    scoring,
  ),
  deck(
    'min-2022-rim-build',
    'Protect the paint',
    'Draft a five that emphasizes finishing possessions and source-visible interior activity.',
    'Blocks and rebounds lead this fixed historical-board comparison; they remain box-score signals, not team-defense proof.',
    rim,
  ),
]);

export const DRAFT_NIGHT_SOURCE = FIX_THE_FIVE_SOURCE;
