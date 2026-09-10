import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { assertPublisherVolume } from './helpers/publisher-volume.mjs';

import { parseNistMobileThreatCatalogue } from '../tools/importers/nist-structured-catalog-adapter.mjs';

const manifest = JSON.parse(readFileSync('data/curated/nist-structured-catalogs/source-manifest.json', 'utf8'));
const iot = JSON.parse(readFileSync('data/curated/nist-structured-catalogs/iot-requirements.json', 'utf8'));
const mobile = JSON.parse(readFileSync('data/curated/nist-structured-catalogs/mobile-threats.json', 'utf8'));

test('NIST IoT workbooks reconcile every publisher row without synthetic records', () => {
  const reconciliation = manifest.reconciliation.iot;
  assert.equal(reconciliation.workbooks_discovered, 2);
  assert.equal(reconciliation.workbooks_ingested, 2);
  assert.equal(reconciliation.workbooks_failed, 0);
  // Raw workbooks are not retained: check stored publisher row evidence and
  // projection consistency, without calling a normalized recount raw discovery.
  for (const sheets of [reconciliation.primary_worksheets, reconciliation.supplemental_worksheets]) {
    assert.ok(sheets.length > 0);
    assert.equal(new Set(sheets.map((sheet) => sheet.worksheet)).size, sheets.length);
    for (const sheet of sheets) {
      assert.ok(Number.isInteger(sheet.source_rows) && sheet.source_rows > 0);
      assert.equal(sheet.parsed_rows, sheet.source_rows, sheet.worksheet);
    }
  }
  assert.equal(new Set(iot.records.map((record) => record.id)).size, iot.records.length);
  assert.equal(reconciliation.records, iot.records.length);
  assert.equal(reconciliation.mapped_records, iot.records.filter((record) => record.publisher_mappings.length).length);
  assert.equal(reconciliation.published_mapping_assertions, iot.records.reduce((sum, record) => sum + record.publisher_mappings.length, 0));
  assert.equal(reconciliation.graph_eligible_80053_relationships, iot.records.reduce((sum, record) => sum + record.relationships.length, 0));
  for (const record of iot.records) {
    assert.ok(record.id);
    assert.deepEqual(record.relationships, record.publisher_mappings.filter((mapping) => mapping.target_catalog === 'nist-800-53'));
    const expectedMappings = record.source_fragments.filter((fragment) => fragment.field === 'mapping').flatMap((fragment) => {
      const source = manifest.sources.find((entry) => entry.source_key === fragment.source_key);
      assert.ok(source);
      const pattern = source.mapping_kind === 'sp_800_53' ? /\b[A-Z]{2,3}-\d+\b/g : /\b[A-Z]{2}\.[A-Z]{2}-\d+\b/g;
      return [...new Set(fragment.text.match(pattern) || [])].map((id) =>
        `${fragment.source_key}:${id.replace(/-0+(\d+)/, '-$1')}`);
    });
    assert.deepEqual(record.publisher_mappings.map((mapping) => `${mapping.source_id}:${mapping.target_id}`).sort(), expectedMappings.sort());
  }
  assert.equal(reconciliation.synthetic_records, 0);
  assertPublisherVolume('nist-iot-cybersecurity', 'data/curated/nist-structured-catalogs/iot-requirements.json', iot.records.length);
  assert.ok(iot.records.every((record) => record.parent_id && record.source_fragments.length > 0));
  assert.ok(iot.records.every((record) => record.source_fragments.every((fragment) => fragment.sheet && fragment.cell)));
  assert.equal(iot.records.filter((record) => record.description && record.description === record.title).length, 0);
});

test('NIST Mobile Threat JSON and CSV reconcile threats, categories, blanks, and CVEs', () => {
  const reconciliation = manifest.reconciliation.mobile_threats;
  const threats = mobile.records.filter((record) => record.type === 'mobile_threat');
  const categories = mobile.records.filter((record) => record.type === 'mobile_threat_category');
  const sourceIds = [];
  const sourceCategories = new Set();
  const sourceCves = new Set();
  const sourceIndexes = new Set();
  for (const threat of threats) {
    const fields = Object.fromEntries(threat.source_fragments.map((fragment) => {
      assert.equal(fragment.checksum, `sha256:${createHash('sha256').update(fragment.text).digest('hex')}`);
      return [fragment.field, JSON.parse(fragment.text)];
    }));
    assert.ok(fields.ThreatID);
    sourceIds.push(fields.ThreatID.trim());
    assert.equal(threat.id, fields.ThreatID.trim());
    sourceCategories.add(fields.ThreatCategory?.trim() || 'Uncategorized');
    const cves = [...new Set([fields.CVEExample].flat().flatMap((value) => String(value ?? '').match(/CVE-\d{4}-\d+/g) || []))].sort();
    assert.deepEqual([...threat.cve_examples].sort(), cves);
    cves.forEach((id) => sourceCves.add(id));
    const index = Number(threat.locator.match(/#\/(\d+)$/)?.[1]);
    assert.ok(Number.isInteger(index) && index >= 0 && index < reconciliation.json_rows_discovered);
    assert.ok(!sourceIndexes.has(index));
    sourceIndexes.add(index);
    assert.ok(categories.some((category) => category.id === threat.parent_id && category.title === (fields.ThreatCategory?.trim() || 'Uncategorized')));
  }
  assert.ok(threats.length > 0);
  assert.equal(new Set(sourceIds).size, threats.length);
  assert.equal(new Set(mobile.records.map((record) => record.id)).size, mobile.records.length);
  assert.deepEqual(categories.map((record) => record.title).sort(), [...sourceCategories].sort());
  assert.ok(Number.isInteger(reconciliation.blank_rows_excluded) && reconciliation.blank_rows_excluded >= 0);
  assert.equal(reconciliation.json_rows_discovered - reconciliation.blank_rows_excluded, sourceIds.length);
  assert.equal(reconciliation.threats_ingested, threats.length);
  assert.equal(reconciliation.categories_ingested, categories.length);
  assert.equal(reconciliation.total_records, mobile.records.length);
  assert.equal(reconciliation.expected_records, reconciliation.json_rows_discovered + sourceCategories.size);
  assert.equal(reconciliation.expected_records - reconciliation.blank_rows_excluded, mobile.records.length);
  assert.equal(reconciliation.unique_cves_reconciled, sourceCves.size);
  assert.ok(reconciliation.csv_rows_discovered >= sourceCves.size);
  assert.equal(reconciliation.synthetic_records, 0);
  assertPublisherVolume('nist-mobile-threats', 'data/curated/nist-structured-catalogs/mobile-threats.json', mobile.records.length);
  assert.ok(mobile.records.every((record) => record.parent_id));
  assert.ok(mobile.records.filter((record) => record.type === 'mobile_threat').every((record) => record.source_fragments.length > 0));
});

test('NIST Mobile threats do not turn an absent publisher origin into synthetic prose', () => {
  const source = {
    json: { source_key: 'mobile-json', url: 'https://example.invalid/mobile.json' },
  };
  const result = parseNistMobileThreatCatalogue(
    Buffer.from(JSON.stringify([{
      ThreatID: 'APP-0',
      Threat: 'Eavesdropping on Unencrypted App Traffic',
      ThreatCategory: 'Vulnerable Applications',
      ThreatOrigin: '',
      ExploitExample: [],
      CVEExample: [],
      PossibleCountermeasures: [],
    }])),
    Buffer.from('CVE\n'),
    source,
  );
  const threat = result.records.find((record) => record.id === 'APP-0');
  assert.equal(threat.description, '');
  assert.equal(threat.title, 'Eavesdropping on Unencrypted App Traffic');
});

test('every discovered NIST structured asset has an explicit ingestion disposition', () => {
  const triage = JSON.parse(readFileSync('data/nist-structured-asset-triage.json', 'utf8'));
  const discoveryBytes = readFileSync('data/nist-structured-asset-discovery.json');
  const discovery = JSON.parse(discoveryBytes);
  assert.equal(triage.source_inventory_sha256, `sha256:${createHash('sha256').update(discoveryBytes).digest('hex')}`);
  assert.ok(discovery.assets.length > 0);
  assert.equal(new Set(triage.assets.map((asset) => asset.url)).size, triage.assets.length);
  assert.deepEqual(triage.assets.map((asset) => asset.url).sort(), discovery.assets.map((asset) => asset.url).sort());
  assert.equal(triage.reconciliation.assets_discovered, discovery.assets.length);
  assert.equal(discovery.reconciliation.structured_assets_discovered, discovery.assets.length);
  assert.equal(triage.reconciliation.assets_classified, triage.assets.length);
  assert.equal(triage.reconciliation.unclassified_assets, 0);
  const statuses = ['ingested_catalog', 'redundant_representation', 'queued_resource', 'out_of_scope'];
  assert.ok(triage.assets.every((asset) => statuses.includes(asset.status)));
  for (const status of statuses) assert.equal(triage.reconciliation[status] || 0, triage.assets.filter((asset) => asset.status === status).length);
  assert.ok(triage.assets.every((asset) => asset.reason && Object.hasOwn(asset, 'target')));
});
