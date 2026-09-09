import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceBaseline, evaluateBaseline, observeCatalog } from '../scripts/lib/source-baseline.mjs';

const measure = (count) => observeCatalog(Buffer.from(JSON.stringify({
  records: Array.from({ length: count }, (_, index) => ({ id: `C-${index}` })),
})));
const observed = measure(100);
const original = { accepted: observed, anchor: observed, accepted_at: '2026-09-01', history: [] };
const policy = { absolute_floor: 50, max_delta_pct: 20, max_anchor_delta_pct: 20, require_independent_inventory: false };

test('empty and malformed source data never advances accepted evidence', () => {
  for (const candidate of [measure(0), { ...observed, normalized_sha256: 'invented' }, measure(49)]) {
    const result = advanceBaseline(original, candidate, policy, '2026-09-09');
    assert.equal(result.decision.accepted, false);
    assert.deepEqual(result.baseline, original);
  }
  assert.throws(() => observeCatalog(Buffer.from('{"records":[{"id":"X"},{"id":"X"}]}')), /unique/);
});

test('accepted drift cannot ratchet down the anchor across weekly runs', () => {
  const first = advanceBaseline(original, measure(80), policy, '2026-09-09');
  assert.equal(first.decision.accepted, true);
  const second = advanceBaseline(first.baseline, measure(64), policy, '2026-09-16');
  assert.equal(second.decision.accepted, false);
  assert.equal(second.baseline.accepted.record_count, 80);
  assert.equal(second.baseline.anchor.record_count, 100);
  assert.deepEqual(original.accepted, observed);
});

test('legitimate independently reconciled publisher revision may exceed drift band', () => {
  const candidate = { ...measure(150), independent_inventory: true, publisher_version: '2.0',
    publisher_sha256: `sha256:${'a'.repeat(64)}`, publisher_byte_length: 2000 };
  assert.equal(evaluateBaseline(original, candidate, policy).reason, 'publisher_revision');
  const advanced = advanceBaseline(original, candidate, policy, '2026-09-09');
  assert.equal(advanced.baseline.anchor.record_count, 150);
  for (const mutation of [
    { independent_inventory: false }, { publisher_version: null }, { publisher_sha256: null },
    { publisher_byte_length: 0 }, { record_count: 0 }, { record_count: 49 },
  ]) assert.equal(evaluateBaseline(original, { ...candidate, ...mutation }, policy).accepted, false);
});

test('missing baseline and corrupted policies fail closed before candidate evaluation', () => {
  assert.throws(() => evaluateBaseline(null, observed, policy), /baseline/);
  for (const mutation of [{ absolute_floor: 0 }, { max_delta_pct: Infinity }, { max_anchor_delta_pct: 101 }]) {
    assert.throws(() => evaluateBaseline(original, observed, { ...policy, ...mutation }), /policy/);
  }
  assert.equal(evaluateBaseline(original, observed, { ...policy, require_independent_inventory: true }).accepted, false);
});

test('normalized bytes are never labeled as downloaded publisher evidence', () => {
  assert.equal(observed.publisher_sha256, null);
  assert.equal(observed.publisher_byte_length, null);
  assert.ok(observed.publisher_evidence_reason);
  assert.throws(() => observeCatalog(Buffer.from(JSON.stringify({ records: [{ id: 'X' }],
    publisher_inventory: { imported_count: 1, eligible_count: 1, imported_identity_sha256: 'forged' },
  }))), /reconciliation/);
});
