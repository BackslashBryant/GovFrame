import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import test from 'node:test';
import { CATALOG_REFRESH_PROFILES, catalogPath } from '../scripts/lib/catalog-refresh-profiles.mjs';
import { observeCatalog } from '../scripts/lib/source-baseline.mjs';
import { assertRegistryTrustUnchanged, createCandidateGate } from '../scripts/lib/refresh-candidate-gate.mjs';

function fixture(t) {
  mkdirSync('.local', { recursive: true });
  const root = mkdtempSync(resolve('.local', 'candidate-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  const bytes = Buffer.from(JSON.stringify({ records: [{ id: 'A' }, { id: 'B' }] }));
  const observation = observeCatalog(bytes);
  const baseline = { schema_version: '1.0', seed_commit: 'a'.repeat(40), catalogs: {} };
  const policy = { schema_version: '1.0', description: 'Synthetic policy fixture', catalogs: {} };
  for (const id of Object.keys(CATALOG_REFRESH_PROFILES)) {
    writeFileSync(join(root, catalogPath(id)), bytes);
    baseline.catalogs[id] = { anchor: observation, accepted: observation, accepted_at: '2026-09-09', history: [] };
    policy.catalogs[id] = { absolute_floor: 1, max_delta_pct: 50, max_anchor_delta_pct: 50, require_independent_inventory: false };
  }
  const committed = new Map([
    ['data/source-baselines.json', Buffer.from(JSON.stringify(baseline))],
    ['data/source-refresh-policy.json', Buffer.from(JSON.stringify(policy))],
    ['data/source-registry.json', Buffer.from('{}')],
  ]);
  for (const [path, value] of committed) writeFileSync(join(root, path), value);
  return { root, committed, gate: createCandidateGate(root, {
    readCommitted: (path) => committed.get(path), readNativeInventory: () => null,
  }) };
}

test('candidate uses committed baseline even if its working baseline is overwritten', (t) => {
  const { root, gate } = fixture(t);
  writeFileSync(join(root, 'data/source-baselines.json'), '{}');
  assert.throws(() => gate.validateCandidate({ paths: ['data/ccis.json'] }), /mutated/);
});

test('zero candidate rejected before acceptance, unchanged sources retain dates', (t) => {
  const { root, gate, committed } = fixture(t);
  const path = join(root, 'data/ccis.json');
  const previous = readFileSync(path);
  writeFileSync(path, '{"records":[]}');
  assert.throws(() => gate.validateCandidate({ paths: ['data/ccis.json'] }), /malformed_or_empty/);
  writeFileSync(path, previous);
  assert.deepEqual(gate.finalize([]), JSON.parse(committed.get('data/source-baselines.json')));
});

test('quarantined output cannot advance after another writer changes it', (t) => {
  const { root, gate } = fixture(t);
  writeFileSync(join(root, 'data/ccis.json'), '{"records":[{"id":"A"}]}');
  assert.throws(() => gate.finalize([{ status: 'quarantined', paths: ['data/ccis.json'] }]), /after rollback/);
});

test('trust-field deletion and newly admitted sources are rejected', () => {
  const previous = { sources: [{ id: 'X', mandate_basis: ['authority'], metadata: { identity_kind: 'normative' } }] };
  assert.throws(() => assertRegistryTrustUnchanged(previous, { sources: [{ id: 'X' }] }), /protected/);
  assert.throws(() => assertRegistryTrustUnchanged(previous, { sources: [...previous.sources, { id: 'Y' }] }), /identities/);
  assert.doesNotThrow(() => assertRegistryTrustUnchanged(previous, structuredClone(previous)));
});

test('unproven reviewed count changes and native count mismatches quarantine before generation', (t) => {
  const { root, gate, committed } = fixture(t);
  writeFileSync(join(root, 'data/cui-policy.json'), '{"records":[{"id":"A"}]}');
  assert.throws(() => gate.validateCandidate({ paths: ['data/cui-policy.json'] }), /requires publisher completeness/);
  const nativeGate = createCandidateGate(root, {
    readCommitted: (path) => committed.get(path),
    readNativeInventory: () => ({ expected_count: 3, excluded_count: 0 }),
  });
  assert.throws(() => nativeGate.validateCandidate({ paths: ['data/ccis.json'] }), /native source inventory/);
});

test('a later failed writer does not erase earlier accepted shared-file progress', (t) => {
  const { root, gate } = fixture(t);
  writeFileSync(join(root, 'data/ccis.json'), '{"records":[{"id":"A"}]}');
  const accepted = { sourceId: 'first', taskId: 'first', status: 'accepted', paths: ['data/ccis.json'] };
  gate.validateCandidate(accepted);
  gate.recordResult(accepted);
  const failed = { sourceId: 'second', taskId: 'second', status: 'quarantined', error: 'Synthetic failure', paths: ['data/ccis.json'] };
  gate.recordResult(failed);
  assert.equal(gate.finalize([accepted, failed]).catalogs['disa-cci'].accepted.record_count, 1);
  assert.equal(gate.verifyPublished(), true);
});
