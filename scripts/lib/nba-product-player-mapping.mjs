const NBA_LEAGUE_CODE = 'NBA';

function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function readProductField(product, camelName, snakeName) {
  if (!product || typeof product !== 'object') return '';
  return product[camelName] ?? product[snakeName] ?? '';
}

function readAliasField(alias, camelName, snakeName) {
  if (!alias || typeof alias !== 'object') return '';
  return alias[camelName] ?? alias[snakeName] ?? '';
}

export function normalizeCatalogPlayerName(value) {
  return cleanText(value).toLowerCase();
}

export function splitCatalogPlayerNames(value) {
  return String(value ?? '')
    .split('|')
    .map(cleanText)
    .filter(Boolean);
}

export function isNbaBasketballProduct(product) {
  const category = cleanText(readProductField(product, 'category', 'category')).toLowerCase();
  const league = cleanText(readProductField(product, 'league', 'league')).toUpperCase();
  return category === 'basketball' && league === NBA_LEAGUE_CODE;
}

export function inferNbaSeasonContext(productName) {
  const title = cleanText(productName);
  const match = title.match(/^((?:19|20)\d{2})[-/](\d{2}|(?:19|20)\d{2})(?=\D|$)/);
  if (!match) {
    return Object.freeze({
      label: '',
      startYear: null,
      endYear: null,
      method: 'unresolved',
    });
  }

  const startYear = Number(match[1]);
  const endToken = match[2];
  const endYear = endToken.length === 2
    ? startYear + 1
    : Number(endToken);
  const hasAdjacentShortYear = endToken.length === 2
    && endYear % 100 === Number(endToken);
  const hasAdjacentLongYear = endToken.length === 4
    && endYear === startYear + 1;

  if (!hasAdjacentShortYear && !hasAdjacentLongYear) {
    return Object.freeze({
      label: '',
      startYear: null,
      endYear: null,
      method: 'unresolved',
    });
  }

  return Object.freeze({
    label: `${startYear}-${String(endYear % 100).padStart(2, '0')}`,
    startYear,
    endYear,
    method: 'title_season_range',
  });
}

export function aliasesFromNbaPlayers(players = []) {
  return (Array.isArray(players) ? players : [])
    .map((player) => {
      // nba_players.id is a league-profile key, not a permanent substitute for
      // the universal-athlete identity. A profile that has not been linked must
      // remain unmapped rather than silently creating a second identity.
      const athleteId = cleanText(readAliasField(player, 'athleteId', 'athlete_id'));
      if (!athleteId) return null;

      return {
        athleteId,
        leagueCode: NBA_LEAGUE_CODE,
        alias: readAliasField(player, 'fullName', 'full_name'),
        normalizedAlias: readAliasField(player, 'normalizedName', 'normalized_name')
          || normalizeCatalogPlayerName(readAliasField(player, 'fullName', 'full_name')),
        aliasType: 'canonical',
        reviewState: 'verified',
        identityStatus: 'active',
      };
    })
    .filter(Boolean);
}

function normalizeAlias(alias) {
  const athleteId = cleanText(readAliasField(alias, 'athleteId', 'athlete_id'));
  const leagueCode = cleanText(readAliasField(alias, 'leagueCode', 'league_code')).toUpperCase();
  const reviewState = cleanText(readAliasField(alias, 'reviewState', 'review_state')).toLowerCase();
  const membershipStatus = cleanText(
    readAliasField(alias, 'membershipStatus', 'membership_status') || 'verified'
  ).toLowerCase();
  const identityStatus = cleanText(readAliasField(alias, 'identityStatus', 'identity_status') || 'active')
    .toLowerCase();
  const aliasType = cleanText(readAliasField(alias, 'aliasType', 'alias_type') || 'known_name')
    .toLowerCase();
  const normalizedAlias = normalizeCatalogPlayerName(
    readAliasField(alias, 'normalizedAlias', 'normalized_alias')
      || readAliasField(alias, 'alias', 'alias')
  );

  if (!athleteId || leagueCode !== NBA_LEAGUE_CODE || reviewState !== 'verified'
    || membershipStatus !== 'verified'
    || identityStatus !== 'active' || !normalizedAlias) {
    return null;
  }

  return Object.freeze({ athleteId, normalizedAlias, aliasType });
}

function buildAliasIndex(aliases) {
  const index = new Map();
  for (const candidate of aliases) {
    const alias = normalizeAlias(candidate);
    if (!alias) continue;
    const candidatesByAthlete = index.get(alias.normalizedAlias) || new Map();
    const existing = candidatesByAthlete.get(alias.athleteId);
    if (!existing || (existing.aliasType !== 'canonical' && alias.aliasType === 'canonical')) {
      candidatesByAthlete.set(alias.athleteId, alias);
    }
    index.set(alias.normalizedAlias, candidatesByAthlete);
  }
  return index;
}

function productIdentity(product) {
  const rawId = readProductField(product, 'id', 'id');
  const productId = Number(rawId);
  return {
    productId: Number.isSafeInteger(productId) && productId > 0 ? productId : null,
    productName: cleanText(readProductField(product, 'name', 'name')),
    sourcePlayerText: cleanText(readProductField(product, 'playerAthlete', 'player_athlete')),
  };
}

function unresolvedProduct(identity, reason, subjects = []) {
  return Object.freeze({
    productId: identity.productId,
    productName: identity.productName,
    sourcePlayerText: identity.sourcePlayerText,
    reason,
    subjects,
  });
}

/**
 * Build a deterministic, reviewable NBA catalog mapping plan.
 *
 * No fuzzy matching is performed. A product is publishable only when every
 * pipe-delimited subject resolves through one verified alias to one distinct,
 * active universal athlete. One bad subject withholds the entire product.
 */
export function buildNbaProductPlayerMappingPlan({ products = [], aliases = [] } = {}) {
  const aliasIndex = buildAliasIndex(Array.isArray(aliases) ? aliases : []);
  const mappings = [];
  const unresolved = [];
  const eligibleProducts = (Array.isArray(products) ? products : [])
    .filter(isNbaBasketballProduct)
    .map((product) => ({ identity: productIdentity(product) }));
  const productIdCounts = new Map();

  for (const { identity } of eligibleProducts) {
    if (!identity.productId) continue;
    productIdCounts.set(identity.productId, (productIdCounts.get(identity.productId) || 0) + 1);
  }

  for (const { identity } of eligibleProducts) {
    if (!identity.productId) {
      unresolved.push(unresolvedProduct(identity, 'invalid_product_id'));
      continue;
    }

    // The database enforces one active mapping at each subject position. A
    // duplicated source ID is therefore ambiguous input, not a safe upsert.
    if (productIdCounts.get(identity.productId) > 1) {
      unresolved.push(unresolvedProduct(identity, 'duplicate_product_id'));
      continue;
    }

    const subjects = splitCatalogPlayerNames(identity.sourcePlayerText);
    if (!subjects.length) {
      unresolved.push(unresolvedProduct(identity, 'missing_player_text'));
      continue;
    }

    const resolutions = subjects.map((sourceText, index) => {
      const normalizedSourceName = normalizeCatalogPlayerName(sourceText);
      const candidates = [...(aliasIndex.get(normalizedSourceName)?.values() || [])]
        .sort((left, right) => left.athleteId.localeCompare(right.athleteId));
      return Object.freeze({
        sourceText,
        normalizedSourceName,
        subjectOrder: index + 1,
        candidates,
      });
    });

    const unmatched = resolutions.filter((resolution) => resolution.candidates.length === 0);
    const ambiguous = resolutions.filter((resolution) => resolution.candidates.length > 1);
    if (unmatched.length || ambiguous.length) {
      unresolved.push(unresolvedProduct(identity,
        ambiguous.length ? 'ambiguous_alias' : 'unmatched_alias',
        resolutions.map((resolution) => ({
          sourceText: resolution.sourceText,
          normalizedSourceName: resolution.normalizedSourceName,
          candidateAthleteIds: resolution.candidates.map((candidate) => candidate.athleteId),
        }))));
      continue;
    }

    const athleteIds = resolutions.map((resolution) => resolution.candidates[0].athleteId);
    if (new Set(athleteIds).size !== athleteIds.length) {
      unresolved.push(unresolvedProduct(identity, 'duplicate_athlete_subject',
        resolutions.map((resolution) => ({
          sourceText: resolution.sourceText,
          normalizedSourceName: resolution.normalizedSourceName,
          candidateAthleteIds: resolution.candidates.map((candidate) => candidate.athleteId),
        }))));
      continue;
    }

    const season = inferNbaSeasonContext(identity.productName);
    for (const resolution of resolutions) {
      const candidate = resolution.candidates[0];
      mappings.push(Object.freeze({
        product_id: identity.productId,
        athlete_id: candidate.athleteId,
        league_code: NBA_LEAGUE_CODE,
        subject_order: resolution.subjectOrder,
        subject_role: resolutions.length === 1 ? 'primary' : 'co_subject',
        depicted_season_label: season.label,
        depicted_season_start_year: season.startYear,
        depicted_season_end_year: season.endYear,
        season_mapping_method: season.method,
        match_method: candidate.aliasType === 'canonical'
          ? 'catalog_player_exact'
          : 'catalog_player_alias',
        match_confidence: 1,
        review_state: 'auto_verified',
        source_player_text: resolution.sourceText,
        evidence: Object.freeze({
          mappingVersion: 1,
          catalogPlayerAthlete: identity.sourcePlayerText,
          normalizedSourceName: resolution.normalizedSourceName,
          matchedAliasType: candidate.aliasType,
          productName: identity.productName,
        }),
      }));
    }
  }

  const mappedProductCount = new Set(mappings.map((mapping) => mapping.product_id)).size;
  return Object.freeze({
    mappings: Object.freeze(mappings),
    unresolved: Object.freeze(unresolved),
    summary: Object.freeze({
      eligibleProductCount: eligibleProducts.length,
      mappedProductCount,
      mappedRowCount: mappings.length,
      unresolvedProductCount: unresolved.length,
    }),
  });
}
