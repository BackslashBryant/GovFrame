import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { migrateSourceRegistryDocument } from '../scripts/migrate-source-truth-profiles.mjs';
import { artifactHash, reconcileFreshness } from '../scripts/reconcile-source-freshness.mjs';

const sourceIds = [
  'mitre-attack-enterprise', 'mitre-attack-ics',
  'mitre-d3fend-ontology', 'mitre-d3fend-mappings',
];
const runDate = '2026-09-09';
const previousImportDate = '2026-09-01';

test('quarantine preserves last checked while hashing accepted shared-source changes', () => {
  const document = [{ records: [{ id: 'accepted' }] }];
  const registry = {
    sources: [], publications: [],
    artifacts: [{ id: 'artifact', publication_source_id: 'shared' }],
    quarantine: [{ id: 'artifact', disposition: 'retained_last_good' }],
    freshness: { sources: [{ source_id: 'shared', sync_model: 'auto_synced',
      hash: artifactHash([]), last_checked: previousImportDate, last_imported: previousImportDate }] },
  };
  reconcileFreshness(registry, new Map([['shared', document]]), runDate);
  const state = registry.freshness.sources[0];
  assert.equal(state.last_checked, previousImportDate);
  assert.equal(state.last_imported, runDate);
  assert.equal(state.hash, artifactHash(document));
  reconcileFreshness(registry, new Map([['shared', document]]), '2026-09-10');
  assert.equal(state.last_imported, runDate);
  assert.equal(state.last_checked, previousImportDate);
});

function fixture(changed) {
  const catalogs = new Map(sourceIds.map((id) => [id, {
    source_version: 'test-version',
    snapshot_date: '2026-08-20',
    checksum: `sha256:${createHash('sha256').update(id).digest('hex')}`,
    records: [{ id }],
  }]));
  // Reconciliation hashes normalized document arrays, not publisher checksums.
  const documents = new Map([...catalogs].map(([id, catalog]) => [id, [catalog]]));
  const registry = {
    publications: sourceIds.map((id) => ({ id })),
    artifacts: [], sources: [], catalog_source_bundles: [],
    freshness: { sources: sourceIds.map((source_id) => ({
      source_id,
      sync_model: 'auto_synced',
      hash: artifactHash(changed ? [] : documents.get(source_id)),
      last_checked: previousImportDate,
      last_imported: previousImportDate,
    })) },
  };
  reconcileFreshness(registry, documents, runDate);
  return { registry, catalogs };
}

for (const changed of [false, true]) {
  test(`profile migration preserves reconciled MITRE freshness for ${changed ? 'changed' : 'unchanged'} content`, () => {
    const { registry, catalogs } = fixture(changed);
    const reconciled = structuredClone(registry.freshness);
    const migrated = migrateSourceRegistryDocument(registry, {}, catalogs);
    assert.deepEqual(migrated.freshness, reconciled);
    for (const source of migrated.freshness.sources) {
      assert.equal(source.last_checked, runDate);
      assert.equal(source.last_imported, changed ? runDate : previousImportDate);
      assert.notEqual(source.hash, catalogs.get(source.source_id).checksum);
    }
    // Exercise the real identity migration as well as preservation.
    assert.equal(migrated.publications[0].version, 'test-version');
    assert.equal(migrated.publications[0].entity_kind, 'publication');
  });
}

test('ownership regression assertion rejects the former publisher-checksum and snapshot-date overwrite', () => {
  const { registry, catalogs } = fixture(false);
  const reconciled = structuredClone(registry.freshness);
  const migrated = migrateSourceRegistryDocument(registry, {}, catalogs);
  for (const freshness of migrated.freshness.sources) {
    const catalog = catalogs.get(freshness.source_id);
    freshness.hash = catalog.checksum;
    freshness.last_imported = catalog.snapshot_date;
    freshness.last_checked = catalog.snapshot_date;
  }
  assert.throws(() => assert.deepEqual(migrated.freshness, reconciled), {
    code: 'ERR_ASSERTION',
  });
});

test('profile migration preserves synchronized catalog inventory contracts', () => {
  const fedrampExpected = {
    basis: 'publisher inventory', evidence_class: 'publisher_inventory_or_reviewed_snapshot',
    evidence_locator: 'data/generated/catalog-source-inventory.json#catalogs.fedramp-2026.discovered_records',
    imported_evidence_locator: 'data/generated/catalog-source-inventory.json#catalogs.fedramp-2026.normalized_records', exclusions: [],
  };
  const iotExpected = {
    basis: 'publisher mapping inventory', evidence_class: 'publisher_mapping_inventory',
    evidence_locator: 'data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.iot.records',
    imported_evidence_locator: 'data/generated/catalog-source-inventory.json#catalogs.nist-iot-cybersecurity.normalized_records', exclusions: [],
  };
  const registry = {
    publications: [], artifacts: [], sources: [], freshness: { sources: [] },
    catalog_source_bundles: [
      { catalog_id: 'fedramp-2026', expected_inventory: fedrampExpected },
      { catalog_id: 'nist-iot-cybersecurity', expected_inventory: iotExpected },
    ],
  };
  const migrated = migrateSourceRegistryDocument(registry, {}, new Map());
  assert.deepEqual(
    migrated.catalog_source_bundles.find(({ catalog_id }) => catalog_id === 'fedramp-2026').expected_inventory,
    fedrampExpected,
  );
  assert.deepEqual(
    migrated.catalog_source_bundles.find(({ catalog_id }) => catalog_id === 'nist-iot-cybersecurity').expected_inventory,
    iotExpected,
  );
});
