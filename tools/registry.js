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
  dependencies: Object.freeze([...tool.dependencies])
});

export const TOOL_REGISTRY = Object.freeze([
  freezeTool({
    id: 'lineup-lab',
    kind: 'tool',
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
    dependencies: [
      'Verified NBA player and team-season data',
      'Browser-safe read-only analytics views'
    ],
    implementationNotes: 'Keep the exact solver and source disclosures isolated from storefront checkout code.'
  }),
  freezeTool({
    id: 'card-matchup-explorer',
    kind: 'tool',
    title: 'Player & Card Matchups',
    eyebrow: 'Planned collector tool',
    status: TOOL_STATUSES.PLANNED,
    href: null,
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
  })
]);
