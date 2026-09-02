import {
  isNbaBasketballProduct,
  normalizeCatalogPlayerName,
  splitCatalogPlayerNames,
} from './nba-product-player-mapping.mjs';

const VERIFIED_REVIEW_STATES = new Set(['auto_verified', 'human_verified']);

function productField(product, camelName, snakeName = camelName) {
  return product?.[camelName] ?? product?.[snakeName] ?? '';
}

function productIdentity(product) {
  return {
    productId: Number(product?.id),
    productName: String(product?.name || '').trim(),
    playerAthlete: String(productField(product, 'playerAthlete', 'player_athlete')).trim(),
    team: String(productField(product, 'team', 'team')).trim(),
  };
}

function mappingRowsByProduct(mappingRows = []) {
  const rowsByProduct = new Map();
  for (const row of Array.isArray(mappingRows) ? mappingRows : []) {
    const productId = Number(row?.product_id);
    if (!Number.isSafeInteger(productId) || productId <= 0) continue;
    if (!VERIFIED_REVIEW_STATES.has(String(row?.review_state || '').toLowerCase())) continue;
    const rows = rowsByProduct.get(productId) || [];
    rows.push(row);
    rowsByProduct.set(productId, rows);
  }
  for (const rows of rowsByProduct.values()) {
    rows.sort((left, right) => Number(left.subject_order) - Number(right.subject_order));
  }
  return rowsByProduct;
}

function summarizeEvidence(evidenceByName, normalizedName) {
  const athletes = evidenceByName.get(normalizedName) || new Map();
  return [...athletes.entries()]
    .map(([athleteId, productIds]) => ({
      athleteId,
      productIds: [...productIds].sort((left, right) => left - right),
    }))
    .sort((left, right) => left.athleteId.localeCompare(right.athleteId));
}

/**
 * Build a review-only expansion queue from a verified mapping snapshot.
 *
 * The queue never promotes title similarity. It only proposes a candidate when
 * every pipe-delimited catalog subject has already resolved consistently to one
 * athlete in another verified product mapping, and all subjects are distinct.
 */
export function buildNbaProductMappingCoverage({ products = [], mappingRows = [] } = {}) {
  const catalog = Array.isArray(products) ? products : [];
  const eligibleProducts = catalog.filter(isNbaBasketballProduct);
  const rowsByProduct = mappingRowsByProduct(mappingRows);
  const currentProductIds = new Set(eligibleProducts.map((product) => Number(product.id)));
  const evidenceByName = new Map();
  const mappedEvidenceIssues = [];

  for (const product of eligibleProducts) {
    const identity = productIdentity(product);
    const rows = rowsByProduct.get(identity.productId) || [];
    if (!rows.length) continue;
    const subjects = splitCatalogPlayerNames(identity.playerAthlete);
    if (!subjects.length || subjects.length !== rows.length) {
      mappedEvidenceIssues.push({
        productId: identity.productId,
        productName: identity.productName,
        reason: !subjects.length ? 'mapped_product_missing_player_text' : 'mapped_subject_count_mismatch',
        subjectCount: subjects.length,
        mappingRowCount: rows.length,
      });
      continue;
    }

    for (let index = 0; index < subjects.length; index += 1) {
      const athleteId = String(rows[index]?.athlete_id || '').trim();
      if (!athleteId || Number(rows[index]?.subject_order) !== index + 1) {
        mappedEvidenceIssues.push({
          productId: identity.productId,
          productName: identity.productName,
          reason: 'mapped_subject_order_mismatch',
          subjectCount: subjects.length,
          mappingRowCount: rows.length,
        });
        break;
      }
      const normalizedName = normalizeCatalogPlayerName(subjects[index]);
      const athletes = evidenceByName.get(normalizedName) || new Map();
      const productIds = athletes.get(athleteId) || new Set();
      productIds.add(identity.productId);
      athletes.set(athleteId, productIds);
      evidenceByName.set(normalizedName, athletes);
    }
  }

  const queue = [];
  for (const product of eligibleProducts) {
    const identity = productIdentity(product);
    if (rowsByProduct.has(identity.productId)) continue;
    const subjects = splitCatalogPlayerNames(identity.playerAthlete);
    if (!subjects.length) {
      queue.push({
        productId: identity.productId,
        current: identity,
        proposed: null,
        evidence: [],
        confidence: 'none',
        source: 'products.json',
        disposition: 'missing_player_text',
      });
      continue;
    }

    const resolutions = subjects.map((sourceText, index) => {
      const normalizedName = normalizeCatalogPlayerName(sourceText);
      return {
        subjectOrder: index + 1,
        sourceText,
        normalizedName,
        candidates: summarizeEvidence(evidenceByName, normalizedName),
      };
    });
    const hasConflict = resolutions.some((resolution) => resolution.candidates.length > 1);
    const hasUnseen = resolutions.some((resolution) => resolution.candidates.length === 0);
    const athleteIds = resolutions
      .filter((resolution) => resolution.candidates.length === 1)
      .map((resolution) => resolution.candidates[0].athleteId);
    const repeatsAthlete = new Set(athleteIds).size !== athleteIds.length;
    const exactCandidate = !hasConflict && !hasUnseen && !repeatsAthlete;

    queue.push({
      productId: identity.productId,
      current: identity,
      proposed: exactCandidate ? resolutions.map((resolution) => ({
        subjectOrder: resolution.subjectOrder,
        athleteId: resolution.candidates[0].athleteId,
        sourcePlayerText: resolution.sourceText,
      })) : null,
      evidence: resolutions,
      confidence: exactCandidate ? 'high_candidate' : 'none',
      source: 'verified_mapping_snapshot',
      disposition: exactCandidate
        ? 'source_consistent_exact_candidate'
        : hasConflict
          ? 'conflicting_verified_name_evidence'
          : repeatsAthlete
            ? 'duplicate_athlete_subject'
            : 'unseen_verified_name',
    });
  }

  const mappedCurrentProductCount = eligibleProducts
    .filter((product) => rowsByProduct.has(Number(product.id))).length;
  const dispositionCounts = queue.reduce((counts, item) => {
    counts[item.disposition] = (counts[item.disposition] || 0) + 1;
    return counts;
  }, {});
  const staleSnapshotProductIds = [...rowsByProduct.keys()]
    .filter((productId) => !currentProductIds.has(productId))
    .sort((left, right) => left - right);

  return {
    summary: {
      catalogProductCount: catalog.length,
      eligibleNbaProductCount: eligibleProducts.length,
      mappedCurrentProductCount,
      unmappedCurrentProductCount: queue.length,
      exactExpansionCandidateCount: dispositionCounts.source_consistent_exact_candidate || 0,
      mappedEvidenceIssueCount: mappedEvidenceIssues.length,
      staleSnapshotProductCount: staleSnapshotProductIds.length,
      dispositionCounts,
    },
    queue,
    mappedEvidenceIssues,
    staleSnapshotProductIds,
  };
}
