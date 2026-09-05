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
    title: 'NBA Lineup Lab',
    eyebrow: 'Live fan tool',
    status: TOOL_STATUSES.LIVE,
    href: '../lineup-lab/',
    summary: 'Build a five-player lineup or full rotation from a historical team-season, game plan, and your own constraints.',
    capabilities: [
      'Best-five and full-rotation builds',
      'Game-plan presets and custom priorities',
      'Locks, exclusions, role coverage, alternatives, and shareable scenarios'
    ],
    highlights: [
      'Lineup builder',
      'Local game state',
      'No checkout impact'
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
    title: 'Lineup DNA',
    eyebrow: 'Live Lineup Lab explanation',
    status: TOOL_STATUSES.LIVE,
    href: '../lineup-lab/',
    summary: 'Read why a chosen five works, which roles are covered or thin, and how one source-bounded substitution changes the lineup profile.',
    capabilities: [
      'Role-coverage explanation cards',
      'Single-substitution before-and-after views',
      'Source and proxy labels beside every claim'
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
    title: 'Fix the Five',
    eyebrow: 'Live historical lineup game',
    status: TOOL_STATUSES.LIVE,
    href: './fix-the-five/',
    summary: 'Make one legal historical lineup swap at a time, then see the source-bounded Lineup DNA gains, trade-offs, and published-board score.',
    capabilities: [
      'Five-round daily historical challenge',
      'Legal replacement board and role-coverage reveal',
      'Local streaks, replay, and shareable seeded runs'
    ],
    highlights: [
      'Five daily swaps',
      'Transparent board score',
      'Local-only progress'
    ],
    dependencies: [
      'Reviewed historical roster snapshot',
      'Versioned game rules and transparent role coverage'
    ],
    implementationNotes: 'Every result stays inside a fixed published player board and labels its box-score role evidence, proxies, and limits plainly.'
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
    title: 'Draft Night',
    eyebrow: 'Live historical lineup game',
    status: TOOL_STATUSES.LIVE,
    href: './draft-night/',
    summary: 'Draft five historical players from a disclosed board, then reveal the fit, role coverage, and ranking across every published legal combination.',
    capabilities: [
      'Seeded five-pick historical boards',
      'Creator, scorer, wing, frontcourt, and big selections',
      'Full-board feasibility and Lineup DNA reveal'
    ],
    highlights: [
      '243 reviewed paths',
      'Five-pick replay loop',
      'Local-only score'
    ],
    dependencies: [
      'Historical player-season data and role definitions',
      'Deterministic draft pools and lineup feasibility checks'
    ],
    implementationNotes: 'The complete published board is re-evaluated before release; role definitions and box-score defensive activity remain transparent and labeled as proxies.'
  }),
  freezeTool({
    id: 'statline-sleuth',
    kind: 'game',
    marker: 'Quiz',
    title: 'Statline Sleuth',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('statline-sleuth'),
    launchLabel: 'Open framework',
    summary: 'Identify a player, team, season, or era from a reviewed statistical clue in a quick, repeatable quiz format.',
    capabilities: [
      'Daily, seeded, and practice rounds',
      'Player, team, season, and era clue modes',
      'Timed scoring with an evidence-backed reveal'
    ],
    dependencies: [
      'Approved public-safe player and team-season summaries',
      'Curated, versioned, and reviewed question banks'
    ],
    implementationNotes: 'Publish only reviewed questions built from unambiguous records; incomplete or uncertain rows cannot become clues.'
  }),
  freezeTool({
    id: 'evidence-court',
    kind: 'game',
    marker: 'Proof',
    title: 'Evidence Court',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('evidence-court'),
    launchLabel: 'Open framework',
    summary: 'Decide whether an analytics claim is a direct fact, reconstruction, model estimate, proxy, or unsupported conclusion.',
    capabilities: [
      'Short analytics-literacy case files',
      'Evidence-level classification',
      'Plain-language answer explanations'
    ],
    dependencies: [
      'Curated scenarios and documented evidence levels',
      'Reviewed explanations with no private data requirement'
    ],
    implementationNotes: 'Explain every answer and do not reward unsupported causal claims or confidence beyond the documented evidence.'
  }),
  freezeTool({
    id: 'optimizer-sensitivity-studio',
    kind: 'tool',
    marker: 'Model',
    title: 'Optimizer Sensitivity Studio',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('optimizer-sensitivity-studio'),
    launchLabel: 'Open framework',
    summary: 'Change declared weights and constraints to see which optimizer selections stay stable and which alternatives are fragile.',
    capabilities: [
      'Controlled objective-weight sweeps',
      'Constraint-by-constraint comparisons',
      'Stable-versus-sensitive selection summaries'
    ],
    dependencies: [
      'Exact solver with declared objective weights',
      'Historical player pools and explicit user constraints'
    ],
    implementationNotes: 'Describe stability only within the selected model, pool, and settings; never present it as objective player truth.'
  }),
  freezeTool({
    id: 'franchise-fingerprints',
    kind: 'game',
    marker: 'Team',
    title: 'Franchise Fingerprints',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('franchise-fingerprints'),
    launchLabel: 'Open framework',
    summary: 'Identify an anonymous franchise or era from an observed historical team-season style profile and a small set of clues.',
    capabilities: [
      'Anonymous team-season profile cards',
      'Franchise and era answer modes',
      'Observed-style reveal with source notes'
    ],
    dependencies: [
      'Historical team-season totals and derived profiles',
      'Reviewed answer keys and transparent profile fields'
    ],
    implementationNotes: 'Use observed shooting, passing, turnover, and rebounding profiles without implying unsupported tactical labels.'
  }),
  freezeTool({
    id: 'two-truths-one-box-score',
    kind: 'game',
    marker: '3 Facts',
    title: 'Two Truths, One Box Score',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('two-truths-one-box-score'),
    launchLabel: 'Open framework',
    summary: 'Review three exact player-season claims and identify the one statement that the verified box score does not support.',
    capabilities: [
      'Compact daily or practice rounds',
      'Player-season assertion sets',
      'Exact-stat reveal and explanation'
    ],
    dependencies: [
      'Verified mapped player-season statistics',
      'Fixed, reviewed assertion banks'
    ],
    implementationNotes: 'Do not generate assertions from uncertain athlete identities, ambiguous prose, or incomplete season records.'
  }),
  freezeTool({
    id: 'phase-flip',
    kind: 'game',
    marker: 'R vs P',
    title: 'Phase Flip',
    eyebrow: 'Framework available',
    status: TOOL_STATUSES.PLANNED,
    href: workshopHref('phase-flip'),
    launchLabel: 'Open framework',
    summary: 'Predict whether a player-season metric rose or fell in the postseason, then inspect both samples and their context.',
    capabilities: [
      'Regular-season versus postseason predictions',
      'Rate and volume metric modes',
      'Sample-aware side-by-side reveal'
    ],
    dependencies: [
      'Verified regular-season and postseason rows',
      'Games, minutes, rate denominators, and sample thresholds'
    ],
    implementationNotes: 'Omit a round when either phase is missing or when the available sample cannot support the stated comparison.'
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
    summary: 'Connect a player or Lineup Lab scenario to verified cards in the DJHC catalog and show useful season context.',
    capabilities: [
      'Exact player-to-card matches',
      'Player-season context beside eligible listings',
      'Watchlists tied to saved scenarios'
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
