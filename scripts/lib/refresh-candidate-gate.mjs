import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import Ajv from 'ajv';
import { CATALOG_REFRESH_PROFILES, INDEPENDENT_REFRESH_CATALOGS, catalogPath } from './catalog-refresh-profiles.mjs';
import { readNativeInventory } from '../build-catalog-source-inventory.mjs';
import { advanceBaseline, evaluateBaseline, observeCatalog } from './source-baseline.mjs';
import { writeJsonAtomically } from './write-json-atomically.mjs';

export const BASELINE_PATH = 'data/source-baselines.json';
export const POLICY_PATH = 'data/source-refresh-policy.json';
const immutableFields = ['owner', 'authority_class', 'provenance_class', 'mandate_basis',
  'identity_kind', 'entity_kind', 'profile_id', 'origin', 'graph_eligible'];

export function assertRegistryTrustUnchanged(previous, current) {
  for (const collection of ['sources', 'publications', 'artifacts']) {
    const before = new Map((previous[collection] || []).map((item) => [item.id, item]));
    const after = new Map((current[collection] || []).map((item) => [item.id, item]));
    if (after.size !== (current[collection] || []).length || !isDeepStrictEqual([...before.keys()].sort(), [...after.keys()].sort())) {
      throw new Error(`Refresh changed admitted ${collection} identities`);
    }
    for (const [id, old] of before) {
      const next = after.get(id);
      for (const field of immutableFields) if (!isDeepStrictEqual(old[field], next[field])) {
        throw new Error(`Refresh changed protected ${collection}.${id}.${field}`);
      }
      if (!isDeepStrictEqual(old.metadata?.identity_kind, next.metadata?.identity_kind)) {
        throw new Error(`Refresh changed protected ${collection}.${id}.metadata.identity_kind`);
      }
    }
  }
}

export function createCandidateGate(root, options = {}) {
  const committed = options.readCommitted || ((path) => execFileSync('git', ['show', `HEAD:${path}`], { cwd: root, maxBuffer: 128 * 1024 * 1024 }));
  const originalPolicyBytes = committed(POLICY_PATH);
  const originalBaselineBytes = committed(BASELINE_PATH);
  const policy = JSON.parse(originalPolicyBytes);
  const previous = JSON.parse(originalBaselineBytes);
  const ajv = new Ajv({ allErrors: true });
  for (const [name, document] of [['source-baselines', previous], ['source-refresh-policy', policy]]) {
    const schema = JSON.parse(readFileSync(new URL(`../../data/schemas/${name}.schema.json`, import.meta.url)));
    if (!ajv.validate(schema, document)) throw new Error(`${name}: ${ajv.errorsText()}`);
  }
  const originalRegistry = JSON.parse(committed('data/source-registry.json'));
  if (policy.schema_version !== '1.0' || previous.schema_version !== '1.0') throw new Error('Unsupported baseline schema');
  const ids = Object.keys(CATALOG_REFRESH_PROFILES);
  const acceptedCatalogHashes = new Map();
  if (!isDeepStrictEqual(Object.keys(previous.catalogs).sort(), [...ids].sort()) ||
      !isDeepStrictEqual(Object.keys(policy.catalogs).sort(), [...ids].sort())) throw new Error('Incomplete catalog baseline ownership');
  const measure = (id) => observeCatalog(readFileSync(join(root, catalogPath(id))));
  const check = (id, candidate) => {
    const decision = evaluateBaseline(previous.catalogs[id], candidate, policy.catalogs[id]);
    if (!decision.accepted) throw new Error(`${id}: ${decision.reason}`);
    const native = (options.readNativeInventory || readNativeInventory)(root, id);
    if (native && candidate.record_count !== native.expected_count - native.excluded_count) {
      throw new Error(`${id}: native source inventory does not match imported records`);
    }
    if (!native && !INDEPENDENT_REFRESH_CATALOGS.has(id) && !candidate.independent_inventory &&
        candidate.record_count !== previous.catalogs[id].anchor.record_count) {
      throw new Error(`${id}: changed reviewed inventory requires publisher completeness evidence`);
    }
    return decision;
  };
  const untouched = () => {
    if (!readFileSync(join(root, POLICY_PATH)).equals(originalPolicyBytes) ||
        !readFileSync(join(root, BASELINE_PATH)).equals(originalBaselineBytes)) throw new Error('Refresh mutated its acceptance policy or prior baseline');
  };
  return {
    verifyPublished() {
      if (!readFileSync(join(root, POLICY_PATH)).equals(originalPolicyBytes)) throw new Error('Refresh changed its admission policy');
      assertRegistryTrustUnchanged(originalRegistry, JSON.parse(readFileSync(join(root, 'data/source-registry.json'))));
      const current = JSON.parse(readFileSync(join(root, BASELINE_PATH)));
      const expectedDocument = structuredClone(previous);
      if (!isDeepStrictEqual(Object.keys(current.catalogs).sort(), [...ids].sort())) throw new Error('Refresh changed baseline ownership');
      for (const id of ids) {
        const candidate = measure(id);
        if (candidate.normalized_sha256 === previous.catalogs[id].accepted.normalized_sha256) {
          if (!isDeepStrictEqual(current.catalogs[id], previous.catalogs[id])) throw new Error(`Unchanged source advanced baseline: ${id}`);
          continue;
        }
        check(id, candidate);
        const proposed = current.catalogs[id];
        const expected = advanceBaseline(previous.catalogs[id], candidate, policy.catalogs[id], proposed.accepted_at).baseline;
        if (!isDeepStrictEqual(proposed, expected)) throw new Error(`Unverified baseline advancement: ${id}`);
        expectedDocument.catalogs[id] = expected;
      }
      if (!isDeepStrictEqual(current, expectedDocument)) throw new Error('Refresh changed baseline provenance');
      return true;
    },
    recordResult(result) {
      if (result.status === 'accepted') {
        for (const id of ids) if (result.paths.some((path) => catalogPath(id) === path || catalogPath(id).startsWith(`${path}/`))) {
          acceptedCatalogHashes.set(id, measure(id).normalized_sha256);
        }
      }
      const registryPath = join(root, 'data/source-registry.json');
      const registry = JSON.parse(readFileSync(registryPath));
      registry.quarantine = (registry.quarantine || []).filter((entry) => entry.refresh_source_id !== result.sourceId);
      if (result.status === 'quarantined') {
        const catalogIds = ids.filter((id) => result.paths.some((path) => catalogPath(id) === path || catalogPath(id).startsWith(`${path}/`)));
        const artifactIds = (registry.catalog_source_bundles || [])
          .filter((bundle) => catalogIds.includes(bundle.catalog_id)).flatMap((bundle) => bundle.primary_artifact_ids || []);
        for (const id of new Set(artifactIds.length ? artifactIds : [result.sourceId])) {
          registry.quarantine.push({
            id, refresh_source_id: result.sourceId, task_id: result.taskId,
            reason: result.error, attempted_at: new Date().toISOString(),
            disposition: 'retained_last_good',
          });
        }
      }
      writeJsonAtomically(registryPath, registry);
    },
    validateCandidate(unit) {
      untouched();
      for (const id of ids) {
        const file = catalogPath(id);
        if (unit.paths.some((path) => file === path || file.startsWith(`${path}/`))) check(id, measure(id));
      }
      assertRegistryTrustUnchanged(originalRegistry, JSON.parse(readFileSync(join(root, 'data/source-registry.json'))));
    },
    finalize(results) {
      untouched();
      assertRegistryTrustUnchanged(originalRegistry, JSON.parse(readFileSync(join(root, 'data/source-registry.json'))));
      const proposed = structuredClone(previous);
      const now = new Date().toISOString();
      for (const id of ids) {
        const candidate = measure(id);
        // Retained last-good files do not need a new publisher proof and must
        // never acquire a new accepted date because another source succeeded.
        if (candidate.normalized_sha256 === previous.catalogs[id].accepted.normalized_sha256) continue;
        const file = catalogPath(id);
        if (results.some((result) => result.status === 'quarantined' && result.paths.some((path) => file === path || file.startsWith(`${path}/`))) &&
            acceptedCatalogHashes.get(id) !== candidate.normalized_sha256) {
          throw new Error(`Quarantined source output changed after rollback: ${id}`);
        }
        check(id, candidate);
        proposed.catalogs[id] = advanceBaseline(previous.catalogs[id], candidate, policy.catalogs[id], now).baseline;
      }
      writeJsonAtomically(join(root, BASELINE_PATH), proposed);
      return proposed;
    },
  };
}
