import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { buildInventory, PUBLISHER_INVENTORY_CATALOGS, readNativeInventory, resolveNativeInventory } from '../scripts/build-catalog-source-inventory.mjs';
import { synchronizeCatalogInventoryContracts } from '../scripts/sync-catalog-inventory-contracts.mjs';

const digest = (ids) => `sha256:${createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')}`;
const publisherDocument = () => ({
  records: [{ id: 'A' }, { id: 'B' }],
  publisher_inventory: {
    raw_count: 3, eligible_count: 2, imported_count: 2,
    excluded: [{ id: 'group', reason: 'structural publisher group' }],
    raw_identity_sha256: digest(['group', 'A', 'B']), imported_identity_sha256: digest(['A', 'B']),
  },
});
test('catalog expectation comes from valid publisher inventory, not normalized recounting', () => {
  const result = buildInventory(publisherDocument(), null);
  assert.equal(result.discovered_records, 2);
  assert.equal(result.raw_records, 3);
  assert.equal(result.evidence_class, 'publisher_inventory');
  assert.equal(result.independent_inventory, true);
});
test('catalog inventory rejects lost, extra, duplicate and hash-mismatched normalized records', () => {
  for (const records of [[], [{ id: 'A' }], [{ id: 'A' }, { id: 'B' }, { id: 'C' }], [{ id: 'A' }, { id: 'A' }]]) {
    assert.throws(() => buildInventory({ ...publisherDocument(), records }, null));
  }
  const invalid = publisherDocument();
  invalid.publisher_inventory.imported_identity_sha256 = digest(['wrong']);
  assert.throws(() => buildInventory(invalid, null), /reconciliation/);
});
test('old reviewed snapshots are explicit and fresh candidates cannot use that fallback', () => {
  const document = { records: [{ id: 'A' }, { id: 'B' }] };
  const baseline = { anchor: { record_count: 2 } };
  const result = buildInventory(document, baseline);
  assert.equal(result.evidence_class, 'reviewed_snapshot');
  assert.equal(result.independent_inventory, false);
  assert.equal(result.raw_records, null);
  assert.throws(() => buildInventory(document, baseline, { requirePublisherInventory: true }), /Fresh candidate/);
  assert.throws(() => buildInventory({ records: [] }, baseline), /Empty/);
  assert.throws(() => buildInventory(document, { anchor: { record_count: 3 } }), /mismatch/);
});
test('inventory contracts correct old self-reference labels and reach a fixed point', () => {
  const input = { artifacts: [], catalog_source_bundles: [
    { catalog_id: 'nist-800-53', mapping_source_ids: [], expected_inventory: { evidence_class: 'pre_graph_adapter_inventory' } },
    { catalog_id: 'cmmc-2', mapping_source_ids: [] },
  ] };
  const first = synchronizeCatalogInventoryContracts(input);
  assert.equal(first.catalog_source_bundles[0].expected_inventory.evidence_class, 'publisher_inventory_or_reviewed_snapshot');
  assert.equal(first.catalog_source_bundles[1].expected_inventory.evidence_class, 'reviewed_snapshot');
  assert.deepEqual(synchronizeCatalogInventoryContracts(first), first);
  assert.equal(input.catalog_source_bundles[0].expected_inventory.evidence_class, 'pre_graph_adapter_inventory');
});

test('native manifest counts reject missing normalized units before source acceptance', () => {
  const native = resolveNativeInventory('disa-srg', { reconciliation: { srg_records_parsed: 3 } });
  assert.deepEqual(native, { expected_count: 3, excluded_count: 0, evidence_locator: 'data/disa-artifact-manifest.json#reconciliation.srg_records_parsed' });
  assert.throws(() => buildInventory({ records: [{ id: 'A' }, { id: 'B' }] }, null, { nativeInventory: native }), /Native source inventory mismatch/);
  assert.equal(readNativeInventory('unused', 'disa-cci'), null);
  assert.ok(PUBLISHER_INVENTORY_CATALOGS.includes('disa-cci'));
});

test('mobile native evidence accounts for excluded blank rows and preserves its expected locator', () => {
  const native = resolveNativeInventory('nist-mobile-threats', { reconciliation: { mobile_threats: { expected_records: 275, blank_rows_excluded: 7 } } });
  assert.equal(native.expected_count - native.excluded_count, 268);
  const records = Array.from({ length: 268 }, (_, index) => ({ id: `mobile-${index}` }));
  const result = buildInventory({ records }, null, { nativeInventory: native });
  assert.equal(result.discovered_records, 275);
  assert.equal(result.normalized_records, 268);
  assert.equal(result.excluded_records, 7);
  assert.equal(result.evidence_class, 'native_manifest');
  const input = { artifacts: [], catalog_source_bundles: [{ catalog_id: 'nist-mobile-threats', expected_inventory: { basis: 'Native mobile JSON', evidence_locator: native.evidence_locator, imported_evidence_locator: 'old-same-field', exclusions: [{ count: 7, reason: 'Blank rows' }] } }] };
  const synced = synchronizeCatalogInventoryContracts(input);
  assert.equal(synced.catalog_source_bundles[0].expected_inventory.evidence_locator, native.evidence_locator);
  assert.match(synced.catalog_source_bundles[0].expected_inventory.imported_evidence_locator, /catalogs.nist-mobile-threats.normalized_records$/);
  assert.equal(synced.catalog_source_bundles[0].expected_inventory.exclusions[0].count, 7);
  assert.deepEqual(synchronizeCatalogInventoryContracts(synced), synced);
});

test('curated DoD Zero Trust retains its reviewed 320-record expectation', () => {
  assert.equal(resolveNativeInventory('dod-zt', { reconciliation: { atlas_records_expected: 320 } }).expected_count, 320);
  assert.throws(() => resolveNativeInventory('dod-zt', { reconciliation: { atlas_records_expected: 321 } }), /reviewed 320/);
});
