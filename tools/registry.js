/**
 * Public registry for DJHC fan tools.
 *
 * The registry is deliberately metadata-only. A tool can describe its route,
 * data requirements, and implementation boundary here without importing
 * commerce data or initializing a backend client on the hub page.
 */

export const TOOL_STATUSES = Object.freeze({
  LIVE: 'live',
  PLANNED: 'planned',
  RESEARCH: 'research'
});

const freezeTool = (tool) => Object.freeze({
  ...tool,
  capabilities: Object.freeze([...tool.capabilities]),
  dependencies: Object.freeze([...tool.dependencies]),
  highlights: Object.freeze([...(tool.highlights || [])])
});

const workshopHref = (id) => `./workshop/?experience=${encodeURIComponent(id)}`;

export const TOOL_REGISTRY = Object.freeze([
  freezeTool({
    id: 'lineup-lab',
    kind: 'tool',
    marker: 'NBA',
    emblem: '../assets/games/lineup-lab-emblem-20260907.webp',
    title: 'NBA Lineup Lab',
    eyebrow: 'Live fan tool',
    status: TOOL_STATUSES.LIVE,
    href: '../lineup-lab/',
    summary: 'Choose a team and season, set your priorities, and build a starting five or full rotation you can inspect.',
    capabilities: [
      'Build a starting five or full rotation',
      'Start with a game-plan preset or your own priorities',
      'Lock must-have players and filter the roster'
    ],
    highlights: [
      'Lineup builder',
      'Historical team-seasons',
      'Read-only fan tool'
    ],
    dependencies: [
      'Verified NBA player and team-season data',
      'Browser-safe read-only analytics views'
    ],
    implementationNotes: 'Keep the exact solver and source disclosures isolated from storefront checkout code.'
  }),
  freezeTool({
    id: 'lineup-dna',
    kind: 'tool',
    marker: 'DNA',
    emblem: '../assets/games/lineup-dna-emblem.svg',
    title: 'Lineup DNA',
    eyebrow: 'Live Lineup Lab explanation',
    status: TOOL_STATUSES.LIVE,
    href: '../lineup-lab/',
    summary: 'See what each player adds, where the five is thin, and how one replacement changes the lineup profile.',
    capabilities: [
      'See the roles your five covers',
      'Spot a thin or missing role',
      'Test one replacement before you rebuild'
    ],
    dependencies: [
      'Current role definitions and fan analytics helpers',
      'Optimizer output, rate views, and source caveats'
    ],
    implementationNotes: 'This is an in-place Lineup Lab explanation layer; box-score movement, switching, or matchup labels remain clearly marked as proxies or unavailable.'
  }),
  freezeTool({
    id: 'fix-the-five',
    kind: 'game',
    marker: '5x',
    emblem: '../assets/games/fix-the-five-emblem-20260907.webp',
    title: 'Fix the Five',
    eyebrow: 'Live daily Scout lineup game',
    status: TOOL_STATUSES.LIVE,
    href: './fix-the-five/',
    summary: 'Choose one legal replacement, lock your move, and reveal your place on that day’s fixed board.',
    capabilities: [
      'One clear swap in each round',
      'A source-labeled board for every challenge',
      'A board result, not a win prediction'
    ],
    highlights: [
      'Five daily Scout swaps',
      'Sealed fixed-board rank',
      'Local-only progress'
    ],
    dependencies: [
      'Validated Scout O/D scope in the 2023–24 through 2025–26 window',
      'Service-only daily board compiler and sealed reveal endpoint'
    ],
    implementationNotes: 'Every result stays inside one source-labeled Scout board. Public stats are context only; raw Scout values remain private, and an unavailable source never falls back to an older fixture.'
  }),
  freezeTool({
    id: 'rotation-rescue',
    kind: 'game',
    marker: 'Coach',
    title: 'Rotation Rescue',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('rotation-rescue'),
    launchLabel: 'Open framework',
    summary: 'Solve a historical coaching brief, build a five or full rotation, and compare the result with an exact optimizer target.',
    capabilities: [
      'Seeded team-season challenge setup',
      'Five-player and full-rotation build modes',
      'Explainable constraint and score breakdowns'
    ],
    dependencies: [
      'Exact optimizer and historical team-season pools',
      'Versioned challenge definitions and role coverage'
    ],
    implementationNotes: 'Score defined constraint completion or distance from the optimizer result; never invent a season-win probability.'
  }),
  freezeTool({
    id: 'scouts-call',
    kind: 'game',
    marker: 'Scout',
    title: "Scout's Call",
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('scouts-call'),
    launchLabel: 'Open framework',
    summary: 'Read a historical opponent profile, choose priorities and a counter-lineup, then compare your call with a source-labeled game plan.',
    capabilities: [
      'Opponent-profile challenge briefs',
      'Priority and counter-lineup choices',
      'Source-labeled coaching-plan reveal'
    ],
    dependencies: [
      'Historical team-season profiles',
      'Opponent game-plan helpers and Lineup Lab priorities'
    ],
    implementationNotes: 'Keep the exercise historical and avoid unsupported player-to-player defensive assignments, injury claims, or live schedule claims.'
  }),
  freezeTool({
    id: 'draft-night',
    kind: 'game',
    marker: 'Draft',
    emblem: '../assets/games/draft-night-emblem-20260907.webp',
    title: 'Draft Night',
    eyebrow: 'Live daily Scout lineup game',
    status: TOOL_STATUSES.LIVE,
    href: './draft-night/',
    summary: 'Pick five players by role, lock your lineup, and see where it lands on the day’s fixed board.',
    capabilities: [
      'Five simple role-based picks',
      'A source-labeled daily board',
      'A reveal after you lock the lineup'
    ],
    highlights: [
      '243 Scout-ranked paths per board',
      'Five-pick replay loop',
      'Local-only score'
    ],
    dependencies: [
      'Validated Scout O/D scope in the 2023–24 through 2025–26 window',
      'Service-only daily board compiler and sealed reveal endpoint'
    ],
    implementationNotes: 'The rank exists only inside the daily Scout board. Public stats label player context; raw model values stay private, and the game remains unavailable rather than using old fixtures.'
  }),
  freezeTool({
    id: 'what-breaks-this-five',
    kind: 'game',
    marker: 'Fit',
    title: 'What Breaks This Five?',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('what-breaks-this-five'),
    launchLabel: 'Open framework',
    summary: 'Inspect a notable five-player lineup, identify its role weakness, and compare your answer with the role model explanation.',
    capabilities: [
      'Curated lineup case files',
      'Role-gap prediction choices',
      'Explainable coverage and feasibility reveal'
    ],
    dependencies: [
      'Current role coverage and objective metrics',
      'Exact lineup feasibility and reviewed case definitions'
    ],
    implementationNotes: 'Treat defensive labels derived from box scores as proxies and distinguish exact lineup facts from modeled role assessments.'
  }),
  freezeTool({
    id: 'card-matchup-explorer',
    kind: 'tool',
    marker: 'Cards',
    title: 'Player & Card Matchups',
    eyebrow: 'Live collector tool',
    status: TOOL_STATUSES.LIVE,
    href: './player-card-matchups/',
    summary: 'Search a player, see verified cards in the DJHC catalog, and keep the season context beside the match.',
    emblem: '../assets/games/card-matchups-emblem.svg',
    capabilities: [
      'Exact player-to-card matches',
      'Season context beside eligible listings',
      'A clean path back to your lineup'
    ],
    dependencies: [
      'Active athlete identities and verified product mappings',
      'One buyer-facing catalog projection'
    ],
    implementationNotes: 'Do not infer a card match from title similarity alone; ambiguous identities remain unmatched.'
  }),
  freezeTool({
    id: 'collection-lineup-builder',
    kind: 'game',
    marker: 'My 5',
    title: 'Build from Your Collection',
    eyebrow: 'Planned collector game',
    status: TOOL_STATUSES.PLANNED,
    href: null,
    summary: 'Turn owned or saved player cards into an eligible roster, then build the best lineup from what you actually collect.',
    capabilities: [
      'Collection-based roster pool',
      'Team, era, and position challenges',
      'Shareable results without changing inventory'
    ],
    dependencies: [
      'Verified player-card relationships',
      'Local-first collection state with explicit opt-in persistence'
    ],
    implementationNotes: 'The first version should be a local, reversible game state; it must not write catalog quantity or sale state.'
  }),
  freezeTool({
    id: 'era-roster-challenges',
    kind: 'game',
    marker: 'Era',
    title: 'Era & Roster Challenges',
    eyebrow: 'Planned history game',
    status: TOOL_STATUSES.PLANNED,
    href: null,
    summary: 'Recreate an iconic roster, satisfy a historical team brief, or solve a card-set challenge with clear rules.',
    capabilities: [
      'Iconic roster reconstruction',
      'Era-versus-era scenarios',
      'Rule-based objectives and result sharing'
    ],
    dependencies: [
      'Stable historical team-season facts',
      'Versioned challenge definitions and deterministic scoring'
    ],
    implementationNotes: 'Challenge rules should be versioned so an old share link remains explainable after data refreshes.'
  }),
  freezeTool({
    id: 'trade-package-builder',
    kind: 'tool',
    marker: 'Trade',
    title: 'Trade & Package Builder',
    eyebrow: 'Planned what-if tool',
    status: TOOL_STATUSES.PLANNED,
    href: null,
    summary: 'Test hypothetical player packages and see how a team’s role coverage and game-plan fit would change.',
    capabilities: [
      'Add, remove, and swap players in a scenario',
      'Before-and-after role and skill-family comparison',
      'Explicit hypothetical labels and reset controls'
    ],
    dependencies: [
      'Lineup Lab role-scaled projections',
      'No live transaction or inventory writes'
    ],
    implementationNotes: 'This is a simulation surface, not a transaction workflow; keep it independent of checkout and Shopify state.'
  }),
  freezeTool({
    id: 'nba-analytics-explorer',
    kind: 'tool',
    marker: 'Data',
    title: 'NBA Analytics Explorer',
    eyebrow: 'Research-gated tool',
    status: TOOL_STATUSES.RESEARCH,
    href: null,
    summary: 'Explore shared-floor, on/off, context splits, adjusted impact, and RAPM only when the underlying play-by-play evidence is validated.',
    capabilities: [
      'Exact two- through five-player shared-floor views',
      'On/off, WOWY, possession-aware ratings, and context splits',
      'Teammate/opponent adjustment and RAPM with coverage labels'
    ],
    dependencies: [
      'Licensed, validated play-by-play source',
      'Dedicated analytics database and versioned model results'
    ],
    implementationNotes: 'Do not present raw plus-minus, estimated half-court splits, or incomplete provider archives as proven facts.'
  }),
  freezeTool({
    id: 'role-evolution-reel',
    kind: 'game',
    marker: 'Career',
    title: 'Role Evolution Reel',
    eyebrow: 'Research-gated game',
    status: TOOL_STATUSES.RESEARCH,
    href: null,
    summary: 'Follow a career timeline and identify the season with the largest observable shift in production, minutes, or playmaking role.',
    capabilities: [
      'Multi-season career timelines',
      'Observable role-shift comparisons',
      'Source-scoped reveal and explanation'
    ],
    dependencies: [
      'Public multi-season player summaries',
      'Reliable season denominators and labeled source scope'
    ],
    implementationNotes: 'Do not infer injury, locker-room, coaching, or tracking-based causes from observable box-score role signals.'
  }),
  freezeTool({
    id: 'era-translation-challenge',
    kind: 'game',
    marker: 'Era',
    title: 'Era Translation Challenge',
    eyebrow: 'Research-gated game',
    status: TOOL_STATUSES.RESEARCH,
    href: null,
    summary: 'Compare player-seasons within a transparent era and position cohort, then predict which performance was more unusual in context.',
    capabilities: [
      'Era-relative comparison rounds',
      'Position and minimum-sample filters',
      'Cohort-aware result explanations'
    ],
    dependencies: [
      'Complete labeled league-season cohorts',
      'Minutes, games, position, and rate thresholds'
    ],
    implementationNotes: 'A single roster or partial scrape cannot serve as a league-wide era baseline; the comparison cohort must be complete and visible.'
  }),
  freezeTool({
    id: 'archetype-cohort-lab',
    kind: 'tool',
    marker: 'Cohort',
    title: 'Archetype Forge & Cohort Lab',
    eyebrow: 'Research-gated tool',
    status: TOOL_STATUSES.RESEARCH,
    href: null,
    summary: 'Set era-relative style preferences and discover the nearest historical player-seasons inside a clearly defined comparison cohort.',
    capabilities: [
      'Era-relative style controls',
      'Small comparison cohorts',
      'Visible similarity recipe and filters'
    ],
    dependencies: [
      'Complete league-season cohorts and denominators',
      'Explicit similarity recipe with era and position filters'
    ],
    implementationNotes: 'Show the exact recipe and cohort, and do not frame box-score similarity as an objective scouting or player-equivalence verdict.'
  })
]);
