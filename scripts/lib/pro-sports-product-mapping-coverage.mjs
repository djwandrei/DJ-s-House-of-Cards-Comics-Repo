function cleanText(value) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

export const SOURCE_BACKED_CANDIDATE_DISPOSITIONS = new Set([
  'source_exact_unique_candidate',
  'source_exact_career_disambiguated_candidate',
  'source_normalized_unique_candidate',
  'source_exact_team_disambiguated_candidate',
  'source_normalized_team_disambiguated_candidate',
  'source_initialism_normalized_unique_candidate',
  'reviewed_catalog_alias_candidate',
  'reviewed_product_identity_override_candidate',
]);

function readField(record, camelName, snakeName = camelName) {
  if (!record || typeof record !== 'object') return '';
  return record[camelName] ?? record[snakeName] ?? '';
}

export function normalizeProviderIdentityName(value) {
  return cleanText(value).normalize('NFC').toLowerCase();
}

export function foldProviderIdentityName(value) {
  return normalizeProviderIdentityName(value)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// Only combine a leading two-letter initialism. This preserves normal names
// while reconciling catalog forms such as "CJ Prosise" and "C.J. Prosise".
export function normalizeLeadingInitialism(value) {
  const parts = foldProviderIdentityName(value).split(' ').filter(Boolean);
  if (parts.length >= 3 && parts[0].length === 1 && parts[1].length === 1) {
    return [`${parts[0]}${parts[1]}`, ...parts.slice(2)].join(' ');
  }
  return parts.join(' ');
}

export function splitProductSubjects(value) {
  return String(value ?? '').split('|').map(cleanText).filter(Boolean);
}

function splitProductTeams(value) {
  return String(value ?? '').split('|').map(cleanText).filter(Boolean);
}

function plausibleSeason(value) {
  const text = cleanText(value);
  if (!/^\d{4}$/.test(text)) return null;
  const season = Number(text);
  return Number.isInteger(season) && season >= 1800 && season <= 2200 ? season : null;
}

function aggregateTeamToken(value) {
  const token = cleanText(value).toUpperCase();
  return token === 'TOT' || /^\d+TM$/.test(token);
}

function productIdentity(product) {
  const rawId = readField(product, 'id');
  const id = Number(rawId);
  const rawYear = readField(product, 'year');
  const year = Number(rawYear);
  return {
    productId: Number.isSafeInteger(id) && id > 0 ? id : null,
    productName: cleanText(readField(product, 'name')),
    playerAthlete: cleanText(readField(product, 'playerAthlete', 'player_athlete')),
    team: cleanText(readField(product, 'team')),
    year: Number.isInteger(year) && year >= 1800 && year <= 2200 ? year : null,
  };
}

function isEligibleProduct(product, config) {
  return cleanText(readField(product, 'category')).toLowerCase() === config.category.toLowerCase()
    && cleanText(readField(product, 'league')).toUpperCase() === config.leagueCode;
}

export function buildProviderIdentityUniverse(rows = [], config = {}) {
  const leagueCode = cleanText(config.leagueCode).toUpperCase();
  const sourceName = cleanText(config.sourceName);
  const byExternalId = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const externalId = cleanText(readField(row, 'externalId', 'external_id'));
    const fullName = cleanText(readField(row, 'fullName', 'full_name'));
    const normalizedName = normalizeProviderIdentityName(fullName);
    if (!externalId || !normalizedName) continue;
    const seasonYear = plausibleSeason(readField(row, 'seasonYear', 'season_year'));
    const current = byExternalId.get(externalId) || {
      externalId,
      leagueCode,
      sourceName,
      names: new Map(),
      seasons: new Set(),
      teamCodes: new Set(),
      teamNames: new Set(),
      teamObservations: new Map(),
    };
    const priorName = current.names.get(normalizedName);
    if (!priorName) {
      current.names.set(normalizedName, {
        name: fullName,
        firstSeenSeason: seasonYear,
        lastSeenSeason: seasonYear,
      });
    } else if (Number.isInteger(seasonYear)) {
      const priorFirst = Number.isInteger(priorName.firstSeenSeason) ? priorName.firstSeenSeason : seasonYear;
      const priorLast = Number.isInteger(priorName.lastSeenSeason) ? priorName.lastSeenSeason : seasonYear;
      current.names.set(normalizedName, {
        name: seasonYear >= priorLast ? fullName : priorName.name,
        firstSeenSeason: Math.min(priorFirst, seasonYear),
        lastSeenSeason: Math.max(priorLast, seasonYear),
      });
    }
    if (Number.isInteger(seasonYear)) current.seasons.add(seasonYear);
    const teamCode = cleanText(readField(row, 'teamCode', 'team_code')).toUpperCase();
    const teamName = cleanText(readField(row, 'teamName', 'team_name'));
    const usableTeamCode = teamCode && !aggregateTeamToken(teamCode) ? teamCode : '';
    const usableTeamName = teamName && !aggregateTeamToken(teamName) ? teamName : '';
    if (usableTeamCode) current.teamCodes.add(usableTeamCode);
    if (usableTeamName) current.teamNames.add(usableTeamName);
    if (Number.isInteger(seasonYear) && (usableTeamCode || usableTeamName)) {
      const observation = { seasonYear, teamCode, teamName };
      current.teamObservations.set(`${seasonYear}\u0000${teamCode}\u0000${teamName}`, observation);
    }
    byExternalId.set(externalId, current);
  }

  return [...byExternalId.values()].map((identity) => {
    const seasons = [...identity.seasons].sort((left, right) => left - right);
    const observedNames = [...identity.names.values()]
      .sort((left, right) => right.lastSeenSeason - left.lastSeenSeason || left.name.localeCompare(right.name));
    return Object.freeze({
      externalId: identity.externalId,
      leagueCode: identity.leagueCode,
      sourceName: identity.sourceName,
      canonicalName: observedNames[0]?.name || '',
      observedNames: Object.freeze(observedNames.map((entry) => entry.name).sort()),
      firstSeason: seasons[0] ?? null,
      lastSeason: seasons.at(-1) ?? null,
      teamCodes: Object.freeze([...identity.teamCodes].sort()),
      teamNames: Object.freeze([...identity.teamNames].sort()),
      teamObservations: Object.freeze([...identity.teamObservations.values()].sort((left, right) => (
        left.seasonYear - right.seasonYear
        || left.teamCode.localeCompare(right.teamCode)
        || left.teamName.localeCompare(right.teamName)
      ))),
    });
  }).sort((left, right) => left.externalId.localeCompare(right.externalId));
}

function indexIdentities(identities, normalizer) {
  const index = new Map();
  for (const identity of identities) {
    for (const name of identity.observedNames) {
      const key = normalizer(name);
      if (!key) continue;
      const candidates = index.get(key) || new Map();
      candidates.set(identity.externalId, identity);
      index.set(key, candidates);
    }
  }
  return index;
}

function identityEvidence(identity) {
  return {
    providerExternalId: identity.externalId,
    providerCanonicalName: identity.canonicalName,
    providerObservedNames: identity.observedNames,
    providerFirstSeason: identity.firstSeason,
    providerLastSeason: identity.lastSeason,
    providerTeamCodes: identity.teamCodes,
    providerTeamNames: identity.teamNames,
    providerTeamObservations: identity.teamObservations,
  };
}

function teamDefinitionNames(definitions, productYear = null) {
  if (!Array.isArray(definitions)) return [];
  return definitions.flatMap((definition) => {
    if (typeof definition === 'string') return [definition];
    if (!definition || typeof definition !== 'object' || typeof definition.name !== 'string') return [];
    const firstSeason = plausibleSeason(definition.firstSeason);
    const lastSeason = plausibleSeason(definition.lastSeason);
    if (Number.isInteger(productYear)
      && ((Number.isInteger(firstSeason) && productYear < firstSeason)
        || (Number.isInteger(lastSeason) && productYear > lastSeason))) return [];
    return [definition.name];
  });
}

function validateTeamCodeDefinitions(teamCodeNames = {}) {
  for (const [rawCode, definitions] of Object.entries(teamCodeNames)) {
    if (!Array.isArray(definitions)) throw new Error(`Team code ${rawCode} must define an array of names.`);
    const rules = definitions.map((definition) => {
      if (typeof definition === 'string' && cleanText(definition)) {
        return { name: cleanText(definition), firstSeason: null, lastSeason: null };
      }
      if (!definition || typeof definition !== 'object' || !cleanText(definition.name)) {
        throw new Error(`Team code ${rawCode} has an invalid name definition.`);
      }
      const firstSeason = plausibleSeason(definition.firstSeason);
      const lastSeason = plausibleSeason(definition.lastSeason);
      if (Number.isInteger(firstSeason) && Number.isInteger(lastSeason) && firstSeason > lastSeason) {
        throw new Error(`Team code ${rawCode} has an invalid season range.`);
      }
      return { name: cleanText(definition.name), firstSeason, lastSeason };
    });
    for (let left = 0; left < rules.length; left += 1) {
      for (let right = left + 1; right < rules.length; right += 1) {
        if (rules[left].name === rules[right].name) continue;
        const overlapStart = Math.max(rules[left].firstSeason ?? -Infinity, rules[right].firstSeason ?? -Infinity);
        const overlapEnd = Math.min(rules[left].lastSeason ?? Infinity, rules[right].lastSeason ?? Infinity);
        if (overlapStart <= overlapEnd) {
          throw new Error(`Team code ${rawCode} has overlapping franchise-name ranges.`);
        }
      }
    }
  }
}

function decodedTeamCodeNames(team, config = {}, productYear = null) {
  const definitions = config.teamCodeNames?.[String(team || '').toUpperCase()];
  const names = [...new Set(teamDefinitionNames(definitions, productYear))];
  // A historical code with no known card year is intentionally unavailable;
  // choosing any era would turn a missing fact into a franchise assertion.
  return names.length === 1 ? names : [];
}

function readableTeamName(value) {
  const team = cleanText(value);
  return team && !(team === team.toUpperCase() && /^[A-Z0-9]{2,4}$/.test(team)) ? team : '';
}

function providerTeamNames(identity, config = {}, productYear = null) {
  const hasProductYear = Number.isInteger(productYear);
  const observations = hasProductYear
    ? (identity.teamObservations || []).filter((observation) => observation.seasonYear === productYear)
    : [];
  // A known card year must be evaluated from that season alone. Falling back
  // to a later franchise makes historical-city cards look falsely verified.
  if (hasProductYear) {
    return [...new Set(observations.flatMap((observation) => {
      const decodedCode = decodedTeamCodeNames(observation.teamCode, config, productYear);
      // The source franchise code is authoritative. Its display text may be a
      // different era's abbreviation, so only use a full readable name when
      // the code is absent or unknown.
      if (decodedCode.length) return decodedCode;
      const fallbackName = readableTeamName(observation.teamName);
      return fallbackName ? [fallbackName] : [];
    }))];
  }
  const decodedCodes = identity.teamCodes.flatMap((team) => decodedTeamCodeNames(team, config, null));
  const readableNames = identity.teamNames.map(readableTeamName).filter(Boolean);
  return [...new Set([...readableNames, ...decodedCodes])];
}

function comparableTeamName(value, config = {}) {
  const folded = foldProviderIdentityName(value);
  return config.teamNameAliases?.[folded] || folded;
}

function identityMatchesProductTeam(identity, productTeam, config = {}, productYear = null) {
  const target = comparableTeamName(productTeam, config);
  return Boolean(target) && providerTeamNames(identity, config, productYear)
    .some((providerTeam) => comparableTeamName(providerTeam, config) === target);
}

function teamAssignments(productTeams, identities) {
  if (productTeams.length === 1) {
    return identities.map((identity, index) => ({ identity, subjectOrder: index + 1, productTeam: productTeams[0] }));
  }
  if (productTeams.length === identities.length) {
    return identities.map((identity, index) => ({ identity, subjectOrder: index + 1, productTeam: productTeams[index] }));
  }
  return null;
}

function teamEvidence(productTeams, identities, config = {}, productYear = null) {
  if (!productTeams.length) return { status: 'not_available', matchedTeams: [] };
  const contexts = new Set((config.teamContextNames || []).map((team) => comparableTeamName(team, config)));
  if (productTeams.every((team) => contexts.has(comparableTeamName(team, config)))) {
    return { status: 'card_context', matchedTeams: [...productTeams] };
  }
  const assignments = teamAssignments(productTeams, identities);
  if (!assignments) return { status: 'subject_pairing_unavailable', matchedTeams: [] };
  const evaluated = assignments.map((assignment) => ({
    ...assignment,
    providerTeams: providerTeamNames(assignment.identity, config, productYear),
  }));
  const unavailable = evaluated.filter((assignment) => assignment.providerTeams.length === 0);
  if (unavailable.length) {
    return {
      status: Number.isInteger(productYear) ? 'provider_team_year_unavailable' : 'provider_team_unavailable',
      matchedTeams: [],
      unavailableSubjectOrders: unavailable.map((assignment) => assignment.subjectOrder),
    };
  }
  const matched = evaluated.filter((assignment) => assignment.providerTeams.some((providerTeam) => (
    comparableTeamName(providerTeam, config) === comparableTeamName(assignment.productTeam, config)
  )));
  const matchedTeams = [...new Set(matched.map((assignment) => assignment.productTeam))];
  if (matched.length === assignments.length) return { status: 'consistent', matchedTeams };
  if (matched.length) return { status: 'partial', matchedTeams };
  return { status: 'conflict_review', matchedTeams: [] };
}

function yearEvidence(productYear, identities) {
  if (!productYear) return { status: 'not_available' };
  const supportsYear = identities.some((identity) => Number.isInteger(identity.firstSeason)
    && Number.isInteger(identity.lastSeason)
    && productYear >= identity.firstSeason - 1
    && productYear <= identity.lastSeason + 1);
  return { status: supportsYear ? 'career_window_consistent' : 'outside_observed_career_window' };
}

function candidateList(index, key) {
  return [...(index.get(key)?.values() || [])]
    .sort((left, right) => left.externalId.localeCompare(right.externalId));
}

function candidatesInProductYearWindow(candidates, productYear) {
  if (!productYear) return [];
  return candidates.filter((identity) => Number.isInteger(identity.firstSeason)
    && Number.isInteger(identity.lastSeason)
    && productYear >= identity.firstSeason - 1
    && productYear <= identity.lastSeason + 1);
}

function subjectTeam(productTeams, subjectCount, subjectIndex) {
  if (productTeams.length === 1) return productTeams[0];
  if (productTeams.length === subjectCount) return productTeams[subjectIndex] || '';
  return '';
}

function candidateTeamMatches(candidates, productTeam, config = {}, productYear = null) {
  if (!productTeam) return [];
  return candidates.filter((candidate) => identityMatchesProductTeam(candidate, productTeam, config, productYear));
}

function sameScope(override, config) {
  return cleanText(override?.leagueCode).toUpperCase() === config.leagueCode
    && cleanText(override?.sourceName) === config.sourceName;
}

function productFingerprint(fingerprint, label) {
  const year = plausibleSeason(fingerprint?.year);
  if (!fingerprint || typeof fingerprint.name !== 'string'
    || typeof fingerprint.playerAthlete !== 'string' || typeof fingerprint.team !== 'string'
    || !Number.isInteger(year)) {
    throw new Error(`${label} requires an exact product fingerprint.`);
  }
  return Object.freeze({
    name: cleanText(fingerprint.name),
    playerAthlete: cleanText(fingerprint.playerAthlete),
    team: cleanText(fingerprint.team),
    year,
  });
}

function expectedProductFingerprint(override, label) {
  return productFingerprint(override?.expectedProduct, `${label} expectedProduct`);
}

function expectedCorrectedProductFingerprint(correction, label) {
  const expectedProduct = expectedProductFingerprint(correction, label);
  const correctedProduct = productFingerprint(correction?.expectedCorrectedProduct, `${label} expectedCorrectedProduct`);
  const corrections = correction?.proposedCatalogCorrections;
  const permittedFields = new Set(['playerAthlete', 'team', 'year']);
  if (!corrections || typeof corrections !== 'object' || !Object.keys(corrections).length) {
    throw new Error(`${label} requires catalog corrections.`);
  }
  const derived = { ...expectedProduct };
  for (const [field, value] of Object.entries(corrections)) {
    if (!permittedFields.has(field)) throw new Error(`${label} contains an unsupported catalog field: ${field}.`);
    const normalizedValue = field === 'year' ? plausibleSeason(value) : cleanText(value);
    if ((field === 'year' && !Number.isInteger(normalizedValue)) || (field !== 'year' && !normalizedValue)) {
      throw new Error(`${label} has an invalid corrected ${field} value.`);
    }
    derived[field] = normalizedValue;
  }
  for (const field of ['name', 'playerAthlete', 'team', 'year']) {
    if (correctedProduct[field] !== derived[field]) {
      throw new Error(`${label} expectedCorrectedProduct must match the declared catalog correction.`);
    }
  }
  if (Object.entries(derived).every(([field, value]) => value === expectedProduct[field])) {
    throw new Error(`${label} does not change the expected product fingerprint.`);
  }
  return correctedProduct;
}

function productMatchesFingerprint(product, fingerprint) {
  return product.productName === fingerprint.name
    && product.playerAthlete === fingerprint.playerAthlete
    && product.team === fingerprint.team
    && product.year === fingerprint.year;
}

function correctionChangesPlayerSubjects(correction) {
  const expectedSubjects = splitProductSubjects(correction.expectedProduct.playerAthlete);
  const correctedSubjects = splitProductSubjects(correction.expectedCorrectedProduct.playerAthlete);
  return expectedSubjects.length !== correctedSubjects.length
    || expectedSubjects.some((subject, index) => subject !== correctedSubjects[index]);
}

function mergeCatalogCorrections(resolutions) {
  const merged = {};
  for (const resolution of resolutions) {
    for (const [field, value] of Object.entries(resolution.proposedCatalogCorrections || {})) {
      if (Object.hasOwn(merged, field) && merged[field] !== value) {
        throw new Error(`Conflicting catalog correction proposals for ${field}.`);
      }
      merged[field] = value;
    }
  }
  return Object.keys(merged).length ? merged : null;
}

function buildOverrideIndexes(config, identities) {
  const aliases = new Map();
  const productOverrides = new Map();
  const catalogCorrections = new Map();
  const exclusions = new Map();
  const identityByExternalId = new Map(identities.map((identity) => [identity.externalId, identity]));
  for (const override of config.aliasOverrides || []) {
    if (!sameScope(override, config)) continue;
    const sourceKey = normalizeProviderIdentityName(override.sourcePlayerText);
    const target = identityByExternalId.get(cleanText(override.providerExternalId));
    if (!sourceKey || !target) {
      throw new Error(`Catalog alias override lacks a cached provider identity: ${override.sourcePlayerText || ''}.`);
    }
    const prior = aliases.get(sourceKey);
    if (prior && prior.providerExternalId !== override.providerExternalId) {
      throw new Error(`Conflicting catalog alias overrides for ${override.sourcePlayerText}.`);
    }
    aliases.set(sourceKey, { ...override, target });
  }
  for (const override of config.productIdentityOverrides || []) {
    if (!sameScope(override, config)) continue;
    const productId = Number(override.productId);
    const subjectOrder = Number(override.subjectOrder);
    const key = `${productId}\u0000${subjectOrder}`;
    const target = identityByExternalId.get(cleanText(override.providerExternalId));
    if (!Number.isSafeInteger(productId) || productId <= 0 || !Number.isSafeInteger(subjectOrder)
      || subjectOrder <= 0 || !normalizeProviderIdentityName(override.sourcePlayerText) || !target) {
      throw new Error(`Product identity override is incomplete for product ${override.productId || ''}.`);
    }
    const prior = productOverrides.get(key);
    if (prior && prior.providerExternalId !== override.providerExternalId) {
      throw new Error(`Conflicting product identity overrides for product ${productId}.`);
    }
    productOverrides.set(key, {
      ...override,
      target,
      expectedProduct: expectedProductFingerprint(override, `Product identity override for ${productId}`),
    });
  }
  for (const correction of config.productCatalogCorrections || []) {
    if (!sameScope(correction, config)) continue;
    const productId = Number(correction.productId);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !cleanText(correction.evidence)
      || !correction.proposedCatalogCorrections
      || typeof correction.proposedCatalogCorrections !== 'object'
      || !Object.keys(correction.proposedCatalogCorrections).length) {
      throw new Error(`Product catalog correction is incomplete for product ${correction.productId || ''}.`);
    }
    if (catalogCorrections.has(productId)) {
      throw new Error(`Duplicate product catalog correction for product ${productId}.`);
    }
    catalogCorrections.set(productId, {
      ...correction,
      expectedProduct: expectedProductFingerprint(correction, `Product catalog correction for ${productId}`),
      expectedCorrectedProduct: expectedCorrectedProductFingerprint(correction, `Product catalog correction for ${productId}`),
    });
  }
  for (const exclusion of config.productIdentityExclusions || []) {
    if (!sameScope(exclusion, config)) continue;
    const productId = Number(exclusion.productId);
    if (!Number.isSafeInteger(productId) || productId <= 0 || !cleanText(exclusion.disposition)) {
      throw new Error('Product identity exclusion is incomplete.');
    }
    if (exclusions.has(productId)) throw new Error(`Duplicate product identity exclusion for ${productId}.`);
    exclusions.set(productId, {
      ...exclusion,
      expectedProduct: expectedProductFingerprint(exclusion, `Product identity exclusion for ${productId}`),
    });
  }
  return { aliases, productOverrides, catalogCorrections, exclusions };
}

export function buildProSportsCatalogMappingCoverage({ products = [], providerRows = [], config = {} } = {}) {
  const leagueCode = cleanText(config.leagueCode).toUpperCase();
  const normalizedConfig = {
    category: cleanText(config.category),
    leagueCode,
    sourceName: cleanText(config.sourceName),
    teamCodeNames: config.teamCodeNames || {},
    teamNameAliases: config.teamNameAliases || {},
    teamContextNames: config.teamContextNames || [],
    aliasOverrides: config.aliasOverrides || [],
    productIdentityOverrides: config.productIdentityOverrides || [],
    productCatalogCorrections: config.productCatalogCorrections || [],
    productIdentityExclusions: config.productIdentityExclusions || [],
  };
  if (!normalizedConfig.category || !leagueCode || !normalizedConfig.sourceName) {
    throw new Error('category, leagueCode, and sourceName are required.');
  }
  validateTeamCodeDefinitions(normalizedConfig.teamCodeNames);
  const identities = buildProviderIdentityUniverse(providerRows, normalizedConfig);
  const exactIndex = indexIdentities(identities, normalizeProviderIdentityName);
  const foldedIndex = indexIdentities(identities, foldProviderIdentityName);
  const initialismIndex = indexIdentities(identities, normalizeLeadingInitialism);
  const overrideIndexes = buildOverrideIndexes(normalizedConfig, identities);
  const eligibleProducts = (Array.isArray(products) ? products : [])
    .filter((product) => isEligibleProduct(product, normalizedConfig))
    .map(productIdentity)
    .sort((left, right) => (left.productId ?? Number.MAX_SAFE_INTEGER) - (right.productId ?? Number.MAX_SAFE_INTEGER));
  const rows = [];

  for (const product of eligibleProducts) {
    const subjects = splitProductSubjects(product.playerAthlete);
    const productTeams = splitProductTeams(product.team);
    if (!product.productId) {
      rows.push({ ...product, disposition: 'invalid_product_id', confidence: 'none', proposedSubjects: [] });
      continue;
    }
    if (!subjects.length) {
      const intentional = productTeams.length > 0;
      rows.push({
        ...product,
        disposition: intentional ? 'intentionally_blank_team_lot' : 'missing_player_text',
        confidence: intentional ? 'not_applicable' : 'none',
        proposedSubjects: [],
        evidence: { source: 'catalog', playerTextBlank: true, productTeams },
      });
      continue;
    }
    const exclusion = overrideIndexes.exclusions.get(product.productId);
    if (exclusion) {
      if (!productMatchesFingerprint(product, exclusion.expectedProduct)) {
        rows.push({
          ...product,
          disposition: 'reviewed_exclusion_fingerprint_drift',
          confidence: 'review',
          currentValues: { playerAthlete: product.playerAthlete, team: product.team, year: product.year },
          proposedSubjects: [],
          evidence: {
            source: normalizedConfig.sourceName,
            leagueCode,
            reviewedExclusion: String(exclusion.evidence || ''),
            expectedProduct: exclusion.expectedProduct,
          },
        });
        continue;
      }
      rows.push({
        ...product,
        disposition: String(exclusion.disposition),
        confidence: 'not_applicable',
        currentValues: { playerAthlete: product.playerAthlete, team: product.team, year: product.year },
        proposedSubjects: [],
        evidence: {
          source: normalizedConfig.sourceName,
          leagueCode,
          reviewedExclusion: String(exclusion.evidence || ''),
        },
        proposedCatalogCorrections: exclusion.proposedCatalogCorrections || null,
      });
      continue;
    }

    const configuredCatalogCorrection = overrideIndexes.catalogCorrections.get(product.productId);
    let catalogCorrection = null;
    let reviewedCatalogCorrection = null;
    if (configuredCatalogCorrection) {
      if (productMatchesFingerprint(product, configuredCatalogCorrection.expectedProduct)) {
        reviewedCatalogCorrection = configuredCatalogCorrection;
        if (correctionChangesPlayerSubjects(configuredCatalogCorrection)) {
          rows.push({
            ...product,
            disposition: 'catalog_subject_correction_pending_review',
            confidence: 'review',
            currentValues: { playerAthlete: product.playerAthlete, team: product.team, year: product.year },
            proposedSubjects: [],
            requiresCatalogCorrectionBeforeMapping: true,
            evidence: {
              source: normalizedConfig.sourceName,
              leagueCode,
              reviewedCatalogCorrection: String(configuredCatalogCorrection.evidence || ''),
              expectedProduct: configuredCatalogCorrection.expectedProduct,
              expectedCorrectedProduct: configuredCatalogCorrection.expectedCorrectedProduct,
            },
            proposedCatalogCorrections: configuredCatalogCorrection.proposedCatalogCorrections,
          });
          continue;
        }
        catalogCorrection = configuredCatalogCorrection;
      } else if (productMatchesFingerprint(product, configuredCatalogCorrection.expectedCorrectedProduct)) {
        // The catalog already reflects this exact reviewed correction. Retain its
        // narrowly scoped evidence-conflict permission, but do not propose the
        // already-applied catalog change a second time.
        reviewedCatalogCorrection = configuredCatalogCorrection;
        // A catalog repair can correctly name every card in a mixed set while
        // still lack a verified provider identity for one or more subjects.
        // Keep that post-repair state manual rather than resolving a coincidentally
        // matching namesake from the provider cache.
        if (configuredCatalogCorrection.holdMappingAfterCorrection === true) {
          rows.push({
            ...product,
            disposition: 'catalog_identity_evidence_pending_review',
            confidence: 'review',
            currentValues: { playerAthlete: product.playerAthlete, team: product.team, year: product.year },
            proposedSubjects: [],
            requiresProviderIdentityEvidenceBeforeMapping: true,
            evidence: {
              source: normalizedConfig.sourceName,
              leagueCode,
              reviewedCatalogCorrection: String(configuredCatalogCorrection.evidence || ''),
              expectedProduct: configuredCatalogCorrection.expectedProduct,
              expectedCorrectedProduct: configuredCatalogCorrection.expectedCorrectedProduct,
            },
          });
          continue;
        }
      } else {
        rows.push({
          ...product,
          disposition: 'reviewed_catalog_correction_fingerprint_drift',
          confidence: 'review',
          currentValues: { playerAthlete: product.playerAthlete, team: product.team, year: product.year },
          proposedSubjects: [],
          evidence: {
            source: normalizedConfig.sourceName,
            leagueCode,
            reviewedCatalogCorrection: String(configuredCatalogCorrection.evidence || ''),
            expectedProduct: configuredCatalogCorrection.expectedProduct,
            expectedCorrectedProduct: configuredCatalogCorrection.expectedCorrectedProduct,
          },
        });
        continue;
      }
    }

    const resolutions = subjects.map((sourcePlayerText, index) => {
      const productOverride = overrideIndexes.productOverrides.get(`${product.productId}\u0000${index + 1}`);
      const exactKey = normalizeProviderIdentityName(sourcePlayerText);
      if (productOverride) {
        if (!productMatchesFingerprint(product, productOverride.expectedProduct)) {
          return {
            subjectOrder: index + 1,
            sourcePlayerText,
            normalizedSourceName: exactKey,
            foldedSourceName: foldProviderIdentityName(sourcePlayerText),
            matchMethod: 'reviewed_product_override_fingerprint_drift',
            matchClass: 'unmatched',
            candidates: [],
            overrideEvidence: productOverride.evidence,
            overrideFingerprintDrift: true,
          };
        }
        if (exactKey !== normalizeProviderIdentityName(productOverride.sourcePlayerText)) {
          return {
            subjectOrder: index + 1,
            sourcePlayerText,
            normalizedSourceName: exactKey,
            foldedSourceName: foldProviderIdentityName(sourcePlayerText),
            matchMethod: 'reviewed_product_override_source_drift',
            matchClass: 'unmatched',
            candidates: [],
            overrideEvidence: productOverride.evidence,
          };
        }
        return {
          subjectOrder: index + 1,
          sourcePlayerText,
          normalizedSourceName: exactKey,
          foldedSourceName: foldProviderIdentityName(sourcePlayerText),
          matchMethod: 'reviewed_product_identity_override',
          matchClass: 'product_override',
          candidates: [productOverride.target],
          overrideEvidence: productOverride.evidence,
          allowEvidenceConflict: productOverride.allowEvidenceConflict === true,
          proposedCatalogCorrections: productOverride.proposedCatalogCorrections || null,
        };
      }
      const aliasOverride = overrideIndexes.aliases.get(exactKey);
      if (aliasOverride) {
        return {
          subjectOrder: index + 1,
          sourcePlayerText,
          normalizedSourceName: exactKey,
          foldedSourceName: foldProviderIdentityName(sourcePlayerText),
          matchMethod: 'reviewed_catalog_alias_override',
          matchClass: 'alias_override',
          candidates: [aliasOverride.target],
          overrideEvidence: aliasOverride.evidence,
        };
      }
      const allExactCandidates = candidateList(exactIndex, exactKey);
      const foldedKey = foldProviderIdentityName(sourcePlayerText);
      const foldedCandidates = allExactCandidates.length ? [] : candidateList(foldedIndex, foldedKey);
      const initialismKey = normalizeLeadingInitialism(sourcePlayerText);
      const initialismCandidates = allExactCandidates.length || foldedCandidates.length
        ? [] : candidateList(initialismIndex, initialismKey);
      const baseCandidates = allExactCandidates.length ? allExactCandidates
        : (foldedCandidates.length ? foldedCandidates : initialismCandidates);
      const baseMatchClass = allExactCandidates.length ? 'exact'
        : (foldedCandidates.length ? 'normalized' : (initialismCandidates.length ? 'initialism' : 'unmatched'));
      const careerWindowCandidates = baseCandidates.length > 1
        ? candidatesInProductYearWindow(baseCandidates, product.year) : [];
      const candidatesAfterYear = careerWindowCandidates.length === 1
        ? careerWindowCandidates : baseCandidates;
      const teamCandidates = candidatesAfterYear.length > 1
        ? candidateTeamMatches(
          candidatesAfterYear,
          subjectTeam(productTeams, subjects.length, index),
          normalizedConfig,
          product.year,
        ) : [];
      const candidates = teamCandidates.length === 1 ? teamCandidates : candidatesAfterYear;
      const baseMethod = baseMatchClass === 'exact' ? 'provider_name_exact'
        : (baseMatchClass === 'normalized' ? 'provider_name_folded'
          : (baseMatchClass === 'initialism' ? 'provider_name_initialism_normalized' : 'unmatched'));
      return {
        subjectOrder: index + 1,
        sourcePlayerText,
        normalizedSourceName: exactKey,
        foldedSourceName: foldedKey,
        matchMethod: teamCandidates.length === 1 ? `${baseMethod}_team`
          : (careerWindowCandidates.length === 1 ? `${baseMethod}_career_window` : baseMethod),
        matchClass: baseMatchClass,
        candidates,
      };
    });
    const ambiguous = resolutions.some((resolution) => resolution.candidates.length > 1);
    const unmatched = resolutions.some((resolution) => resolution.candidates.length === 0);
    const allSourceExact = resolutions.every((resolution) => resolution.matchClass === 'exact');
    const usedCareerWindow = resolutions.some((resolution) => resolution.matchMethod.endsWith('_career_window'));
    const usedTeamDisambiguation = resolutions.some((resolution) => resolution.matchMethod.endsWith('_team'));
    const usedAliasOverride = resolutions.some((resolution) => resolution.matchClass === 'alias_override');
    const usedProductOverride = resolutions.some((resolution) => resolution.matchClass === 'product_override');
    const productOverrideFingerprintDrift = resolutions.some((resolution) => resolution.overrideFingerprintDrift);
    const usedInitialismNormalization = resolutions.some((resolution) => resolution.matchClass === 'initialism');
    const selected = resolutions.map((resolution) => resolution.candidates[0]).filter(Boolean);
    const duplicateIdentity = !ambiguous && !unmatched
      && new Set(selected.map((identity) => identity.externalId)).size !== selected.length;
    const teams = teamEvidence(productTeams, selected, normalizedConfig, product.year);
    const year = yearEvidence(product.year, selected);
    // A missing same-year provider team does not make an exact player identity
    // ambiguous (prospect and retrospective cards are common), but it must not
    // be represented as proof that the catalog team is correct. Only a real
    // mismatch blocks the athlete mapping candidate.
    const teamConflict = new Set([
      'conflict_review',
      'partial',
    ]).has(teams.status);
    const catalogAttributeReviewRequired = new Set([
      'provider_team_unavailable',
      'provider_team_year_unavailable',
      'subject_pairing_unavailable',
    ]).has(teams.status);
    const evidenceConflict = teamConflict || year.status === 'outside_observed_career_window';
    // A multi-subject card may use reviewed identity overrides too, but only
    // when every listed subject is independently fingerprinted and explicitly
    // permits the same evidence exception. One reviewed subject must never
    // suppress a conflict for an unreviewed companion on a set or leader card.
    const identityOverridePermitsEvidenceConflict = resolutions.length > 0
      && resolutions.every((resolution) => resolution.matchClass === 'product_override'
        && resolution.allowEvidenceConflict === true);
    const productCorrectionPermitsEvidenceConflict = reviewedCatalogCorrection?.allowEvidenceConflict === true;
    const reviewedEvidencePermitsConflict = identityOverridePermitsEvidenceConflict
      || productCorrectionPermitsEvidenceConflict;
    let disposition = 'unseen_provider_name';
    let confidence = 'none';
    if (ambiguous) disposition = 'ambiguous_provider_identity';
    else if (productOverrideFingerprintDrift) {
      disposition = 'reviewed_product_override_fingerprint_drift';
      confidence = 'review';
    }
    else if (duplicateIdentity) disposition = 'duplicate_provider_subject';
    else if (!unmatched && evidenceConflict && !reviewedEvidencePermitsConflict) {
      if (teamConflict && year.status === 'outside_observed_career_window') {
        disposition = 'catalog_team_and_year_conflict_review';
      } else if (teams.status === 'partial') {
        disposition = 'catalog_team_partial_conflict_review';
      } else if (teamConflict) {
        disposition = 'catalog_team_conflict_review';
      } else {
        disposition = 'catalog_year_conflict_review';
      }
      confidence = 'review';
    }
    else if (!unmatched && usedProductOverride) {
      disposition = 'reviewed_product_identity_override_candidate';
      confidence = 'high';
    } else if (!unmatched && usedAliasOverride) {
      disposition = 'reviewed_catalog_alias_candidate';
      confidence = 'high';
    } else if (!unmatched && allSourceExact && usedTeamDisambiguation) {
      disposition = 'source_exact_team_disambiguated_candidate';
      confidence = 'high';
    } else if (!unmatched && allSourceExact) {
      disposition = usedCareerWindow
        ? 'source_exact_career_disambiguated_candidate'
        : 'source_exact_unique_candidate';
      confidence = 'high';
    } else if (!unmatched) {
      disposition = usedTeamDisambiguation
        ? 'source_normalized_team_disambiguated_candidate'
        : (usedInitialismNormalization
          ? 'source_initialism_normalized_unique_candidate'
          : 'source_normalized_unique_candidate');
      confidence = 'high';
    }
    rows.push({
      ...product,
      disposition,
      confidence,
      currentValues: { playerAthlete: product.playerAthlete, team: product.team, year: product.year },
      proposedSubjects: resolutions.map((resolution) => ({
        subjectOrder: resolution.subjectOrder,
        sourcePlayerText: resolution.sourcePlayerText,
        matchMethod: resolution.matchMethod,
        candidateCount: resolution.candidates.length,
        candidates: resolution.candidates.map(identityEvidence),
        overrideEvidence: resolution.overrideEvidence || null,
        proposedCatalogCorrections: resolution.proposedCatalogCorrections || null,
      })),
      evidence: {
        source: normalizedConfig.sourceName,
        leagueCode,
        reviewedCatalogCorrection: reviewedCatalogCorrection?.evidence || null,
        team: teams,
        year,
        catalogAttributeReviewRequired,
      },
      proposedCatalogCorrections: mergeCatalogCorrections([
        ...resolutions,
        catalogCorrection || {},
      ]),
    });
  }

  const dispositionCounts = rows.reduce((counts, row) => {
    counts[row.disposition] = (counts[row.disposition] || 0) + 1;
    return counts;
  }, {});
  const sourceBackedCandidates = rows.filter((row) => (
    SOURCE_BACKED_CANDIDATE_DISPOSITIONS.has(row.disposition)
  ));
  return Object.freeze({
    leagueCode,
    sourceName: normalizedConfig.sourceName,
    providerIdentityCount: identities.length,
    eligibleProductCount: eligibleProducts.length,
    sourceBackedCandidateProductCount: sourceBackedCandidates.length,
    sourceBackedCandidateMappingRowCount: sourceBackedCandidates
      .reduce((total, row) => total + row.proposedSubjects.length, 0),
    dispositionCounts,
    rows,
  });
}
