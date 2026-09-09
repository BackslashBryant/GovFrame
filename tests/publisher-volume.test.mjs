import test from 'node:test';
import assert from 'node:assert/strict';
import { observeCatalog } from '../scripts/lib/source-baseline.mjs';
import { assertPublisherObservation } from './helpers/publisher-volume.mjs';

const observe = (count) => observeCatalog(Buffer.from(JSON.stringify({ records: Array.from({ length: count }, (_, index) => ({ id: `unit-${index}` })) })));
const previous = { accepted: observe(10), anchor: observe(10) };
const policy = { absolute_floor: 5, max_delta_pct: 20, max_anchor_delta_pct: 20, require_independent_inventory: true };

test('offline volume permits in-band growth without asserting publisher completeness', () => {
  const observation = assertPublisherObservation('sample', observe(11), previous, policy, 11);
  assert.equal(observation.independent_inventory, false);
  assert.equal(previous.accepted.record_count, 10);
  assert.equal(policy.require_independent_inventory, true);
});
test('offline volume retains absolute floors and fixed anchor bands', () => {
  assert.throws(() => assertPublisherObservation('sample', observe(1), previous, policy), /absolute_floor/);
  assert.throws(() => assertPublisherObservation('sample', observe(13), { ...previous, accepted: observe(12) }, policy), /uncorroborated_count_change/);
});
test('offline volume requires exact graph projection and valid prior authority', () => {
  assert.throws(() => assertPublisherObservation('sample', observe(10), previous, policy, 9), /retain every source record/);
  assert.throws(() => assertPublisherObservation('sample', observe(10), null, policy), /baseline is required/);
});
