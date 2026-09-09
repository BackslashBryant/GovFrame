import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { evaluateBaseline, observeCatalog } from '../../scripts/lib/source-baseline.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const baselineRef = process.env.CONTROL_ATLAS_SOURCE_BASELINE_REF ||
  (process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1' ? 'HEAD' : null);
const authority = (path) => JSON.parse(baselineRef
  ? execFileSync('git', ['show', `${baselineRef}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 })
  : readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));
// Read admission authorities once. Refresh tests must use the previous Git
// baseline, never a candidate baseline file updated by the same refresh.
const baselines = authority('data/source-baselines.json');
const policy = authority('data/source-refresh-policy.json');
const observations = new Map();

export function assertPublisherObservation(catalogId, observed, previous, admissionPolicy, projectedCount) {
  assert.ok(previous, `${catalogId}: accepted baseline is required`);
  assert.ok(admissionPolicy, `${catalogId}: source policy is required`);
  const decision = evaluateBaseline(previous, observed, { ...admissionPolicy, require_independent_inventory: false });
  assert.ok(decision.accepted, `${catalogId}: publisher volume rejected (${decision.reason})`);
  if (projectedCount !== undefined) {
    assert.equal(projectedCount, observed.record_count, `${catalogId}: graph projection must retain every source record`);
  }
  return observed;
}

/** Offline volume regression check; producer tests separately prove completeness. */
export function assertPublisherVolume(catalogId, catalogPath, projectedCount) {
  if (!observations.has(catalogPath)) {
    observations.set(catalogPath, observeCatalog(readFileSync(new URL(`../../${catalogPath}`, import.meta.url))));
  }
  const observed = observations.get(catalogPath);
  const previous = baselines.catalogs[catalogId];
  const admissionPolicy = policy.catalogs[catalogId];
  return assertPublisherObservation(catalogId, observed, previous, admissionPolicy, projectedCount);
}
