import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCciInventory } from '../scripts/lib/cci-inventory.mjs';

const xml = '<cci_list><cci_items><cci_item id="CCI-000001"/><cci_item id="CCI-000002"/></cci_items></cci_list>';
test('CCI publisher identity walk rejects lost, duplicate and empty projections', () => {
  assert.equal(assertCciInventory(xml, [{ id: 'CCI-000002' }, { id: 'CCI-000001' }]).eligible_count, 2);
  for (const records of [[], [{ id: 'CCI-000001' }], [{ id: 'CCI-000001' }, { id: 'CCI-000001' }]]) {
    assert.throws(() => assertCciInventory(xml, records), /reconciliation/);
  }
  assert.throws(() => assertCciInventory('<cci_list><cci_items/></cci_list>', []), /Empty/);
  assert.throws(() => assertCciInventory(xml.replace('CCI-000002', 'CCI-000001'), [{ id: 'CCI-000001' }]), /reconciliation/);
});
