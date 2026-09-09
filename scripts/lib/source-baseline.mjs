import { createHash } from 'node:crypto';

const sha256 = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const hashPattern = /^sha256:[a-f0-9]{64}$/;

/** Measure normalized bytes separately from evidence about downloaded publisher bytes. */
export function observeCatalog(bytes) {
  const document = JSON.parse(bytes.toString('utf8'));
  if (!Array.isArray(document.records)) throw new Error('Catalog requires records');
  const ids = document.records.map((record) => record.id);
  if (ids.some((id) => typeof id !== 'string' || !id.trim()) || new Set(ids).size !== ids.length) {
    throw new Error('Catalog identities must be nonempty and unique');
  }
  const inventory = document.publisher_inventory;
  if (inventory && (inventory.imported_count !== ids.length || inventory.eligible_count !== ids.length ||
      !Number.isSafeInteger(inventory.raw_count) || inventory.raw_count < inventory.eligible_count ||
      !Array.isArray(inventory.excluded) || inventory.raw_count !== inventory.eligible_count + inventory.excluded.length ||
      inventory.excluded.some((entry) => typeof entry.id !== 'string' || !entry.id || typeof entry.reason !== 'string' || !entry.reason) ||
      !hashPattern.test(inventory.raw_identity_sha256) ||
      inventory.imported_identity_sha256 !== sha256(JSON.stringify([...ids].sort())))) {
    throw new Error('Publisher reconciliation does not match catalog identities');
  }
  return {
    record_count: ids.length,
    normalized_byte_length: bytes.length,
    normalized_sha256: sha256(bytes),
    identity_sha256: sha256(JSON.stringify([...ids].sort())),
    publisher_version: inventory?.publisher_version || document.source_version || document.source?.version || null,
    publisher_sha256: inventory?.source_sha256 || null,
    publisher_byte_length: inventory?.source_byte_length ?? null,
    publisher_evidence_reason: inventory?.source_sha256 && inventory?.source_byte_length
      ? null : 'Downloaded bytes were not retained in this accepted snapshot',
    independent_inventory: Boolean(inventory),
  };
}

function validObservation(value) {
  return value && Number.isSafeInteger(value.record_count) && value.record_count > 0 &&
    Number.isSafeInteger(value.normalized_byte_length) && value.normalized_byte_length > 0 &&
    hashPattern.test(value.normalized_sha256) && hashPattern.test(value.identity_sha256);
}

/** Candidate values never determine their own acceptance range. */
export function evaluateBaseline(previous, candidate, policy) {
  if (!validObservation(previous?.accepted) || !validObservation(previous?.anchor)) {
    throw new Error('Missing or invalid previously accepted baseline');
  }
  if (!policy || !Number.isSafeInteger(policy.absolute_floor) || policy.absolute_floor < 1 ||
      !Number.isFinite(policy.max_delta_pct) || policy.max_delta_pct < 0 || policy.max_delta_pct > 100 ||
      !Number.isFinite(policy.max_anchor_delta_pct) || policy.max_anchor_delta_pct < 0 || policy.max_anchor_delta_pct > 100) {
    throw new Error('Invalid immutable source baseline policy');
  }
  const reject = (reason) => ({ accepted: false, reason });
  if (!validObservation(candidate)) return reject('malformed_or_empty');
  if (candidate.record_count < policy.absolute_floor) return reject('absolute_floor');
  if (policy.require_independent_inventory && !candidate.independent_inventory) return reject('missing_publisher_inventory');
  const delta = (count) => Math.abs(candidate.record_count - count) / count * 100;
  const withinBand = delta(previous.accepted.record_count) <= policy.max_delta_pct &&
    delta(previous.anchor.record_count) <= policy.max_anchor_delta_pct;
  if (withinBand) return { accepted: true, reason: 'within_band', reset_anchor: false };
  // A changed label alone is insufficient: require a complete independently
  // reconciled publisher document and actual fresh-byte evidence as well.
  const corroborated = candidate.independent_inventory &&
    typeof candidate.publisher_version === 'string' && candidate.publisher_version.trim() &&
    candidate.publisher_version !== previous.accepted.publisher_version &&
    hashPattern.test(candidate.publisher_sha256) && candidate.publisher_sha256 !== previous.accepted.publisher_sha256 &&
    Number.isSafeInteger(candidate.publisher_byte_length) && candidate.publisher_byte_length > 0;
  return corroborated
    ? { accepted: true, reason: 'publisher_revision', reset_anchor: true }
    : reject('uncorroborated_count_change');
}

export function advanceBaseline(previous, candidate, policy, acceptedAt) {
  const decision = evaluateBaseline(previous, candidate, policy);
  if (!decision.accepted) return { decision, baseline: structuredClone(previous) };
  if (!acceptedAt || !Number.isFinite(Date.parse(acceptedAt))) throw new Error('Acceptance requires a valid timestamp');
  return {
    decision,
    baseline: {
      anchor: structuredClone(decision.reset_anchor ? candidate : previous.anchor),
      accepted: structuredClone(candidate),
      accepted_at: acceptedAt,
      history: [...(previous.history || []), { ...previous.accepted, accepted_at: previous.accepted_at }].slice(-8),
    },
  };
}
