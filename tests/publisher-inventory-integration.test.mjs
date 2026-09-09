import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fetchFrameworkCatalogs, frameworkCatalogOptions } from '../scripts/fetch-framework-catalogs.mjs';
import { fetchMitreData } from '../scripts/fetch-mitre-data.mjs';
import { fetchFedramp2026Rules } from '../scripts/fetch-fedramp-2026-rules.mjs';
import { normalizeFedramp2026, buildFedramp2026FromBytes } from '../scripts/build-fedramp-2026-catalog.mjs';
import { enrichCsfCatalogFromReferenceTool, parseCsfReferenceToolRows } from '../tools/importers/csf-reference-tool-adapter.mjs';

const response = (value) => new Response(JSON.stringify(value, null, 2));
test('framework fetch gates zero records before writes and attests actual response bytes', async () => {
  const writes = [];
  const body = '[\n {"title":"GOVERN 1", "description":"Publisher outcome"}\n]';
  await fetchFrameworkCatalogs({ only: ['nist-ai-rmf-playbook'], fetchImpl: async () => new Response(body), writeJson: (...args) => writes.push(args) });
  assert.equal(writes.length, 1);
  const inventory = writes[0][1].publisher_inventory;
  assert.equal(inventory.eligible_count, 1);
  assert.equal(inventory.source_byte_length, Buffer.byteLength(body));
  assert.equal(inventory.source_sha256, `sha256:${createHash('sha256').update(body).digest('hex')}`);
  writes.length = 0;
  await assert.rejects(fetchFrameworkCatalogs({ only: ['nist-ai-rmf-playbook'], fetchImpl: async () => response([]), writeJson: (...args) => writes.push(args) }), /Empty eligible/);
  assert.equal(writes.length, 0);
});

test('framework integration catches a publisher root control lost by the existing projection', async () => {
  const writes = [];
  const catalog = {
    uuid: '12345678-1234-4234-8234-123456789012',
    metadata: { title: 'Test', 'last-modified': '2026-01-01', version: '1', 'oscal-version': '1.1.2' },
    controls: [{ id: '03.01.01', class: 'requirement', title: 'Requirement' }],
  };
  await assert.rejects(fetchFrameworkCatalogs({ only: ['nist-800-171-rev3'], fetchImpl: async () => response({ catalog }), writeJson: (...args) => writes.push(args) }), /inventory mismatch/);
  assert.equal(writes.length, 0);
});

function stix(id = 'T1') {
  return { objects: [{ id: 'attack-pattern--test', type: 'attack-pattern', name: 'Technique', external_references: [{ source_name: 'mitre-attack', external_id: id }] }, { id: 'collection--test', type: 'x-mitre-collection', x_mitre_version: '19.2' }] };
}
function mitreFetch(bundle) {
  return async (url) => {
    const api = 'https://api.github.com/repos/mitre-attack/attack-stix-data';
    const commit = 'a'.repeat(40);
    if (url === `${api}/releases/latest`) return response({
      tag_name: 'v19.2', draft: false, prerelease: false,
      html_url: 'https://github.com/mitre-attack/attack-stix-data/releases/tag/v19.2',
    });
    if (url === `${api}/commits/v19.2`) return response({ sha: commit, url: `${api}/commits/${commit}` });
    if (url.includes('enterprise-attack') || url.includes('ics-attack')) return response(bundle);
    if (url.includes('version.json')) return response({ ontology_version: '1.6.0' });
    if (url.includes('mappings')) return response({ results: { bindings: [] } });
    return response({ '@graph': [{ '@id': 'd3f:Alpha', 'd3f:d3fend-id': 'D3-A', 'd3f:enables': { '@id': 'd3f:Detect' } }, { '@id': 'd3f:Detect' }] });
  };
}
test('MITRE fetch attaches inventory and byte evidence without canonical reserialization', async () => {
  const result = await fetchMitreData({ fetchImpl: mitreFetch(stix()) });
  assert.equal(result.enterprise.publisher_inventory.eligible_count, 1);
  assert.equal(result.ics.publisher_inventory.imported_count, 1);
  assert.equal(result.enterprise.checksum_basis, 'raw_bytes');
  const body = JSON.stringify(stix(), null, 2);
  assert.equal(result.enterprise.checksum, `sha256:${createHash('sha256').update(body).digest('hex')}`);
  assert.equal(result.enterprise.source_artifact_byte_length, Buffer.byteLength(body));
  assert.equal(result.enterprise.publisher_inventory.source_sha256, result.enterprise.checksum);
  assert.equal(result.enterprise.publisher_inventory.publisher_version, '19.2');
  assert.equal(result.d3fend.publisher_inventory.eligible_count, 1);
  assert.equal(result.d3fend.publisher_inventory.publisher_version, '1.6.0');
});
test('MITRE rejects zero and missing publisher external IDs instead of returning committed fallback', async () => {
  const noTechniques = { objects: stix().objects.filter((entry) => entry.type === 'x-mitre-collection') };
  await assert.rejects(fetchMitreData({ fetchImpl: mitreFetch(noTechniques) }), /Empty eligible/);
  const bundle = stix();
  bundle.objects[0].external_references = [];
  await assert.rejects(fetchMitreData({ fetchImpl: mitreFetch(bundle) }), /Missing publisher identity/);
});

test('CSF workbook reconciliation compares both directions of independent publisher IDs', () => {
  const records = Array.from({ length: 106 }, (_, index) => ({
    id: `GV.A${String.fromCharCode(65 + Math.floor(index / 99))}-${String(index % 99 + 1).padStart(2, '0')}`,
    description: `Outcome ${index}`, function_id: `F${index % 6}`, category_id: `C${index % 22}`,
  }));
  const rows = [['Publisher export'], ['Function', 'Category', 'Subcategory'], ...records.map((record) => ['', '', `${record.id}: ${record.description}`])];
  const publisher = parseCsfReferenceToolRows(rows);
  const result = enrichCsfCatalogFromReferenceTool(records, publisher);
  assert.equal(result.publisher_inventory.raw_count, 106);
  assert.equal(result.publisher_inventory.raw_identity_sha256, result.publisher_inventory.imported_identity_sha256);
  assert.throws(() => enrichCsfCatalogFromReferenceTool(records.slice(1), publisher), /missing publisher subcategories/);
  const additional = { ...records[0], id: 'GV.ZZ-99' };
  assert.throws(() => enrichCsfCatalogFromReferenceTool([...records, additional], publisher), /missing active OSCAL identifiers/);
});

// Synthetic active inventory with exact withdrawal syntax observed in the
// official CSF 2.0 all-in-one worksheet on 2026-09-09.
const csfActive = Array.from({ length: 106 }, (_, index) => ({
  id: `GV.A${String.fromCharCode(65 + Math.floor(index / 99))}-${String(index % 99 + 1).padStart(2, '0')}`,
  description: `Active outcome ${index}`, function_id: `F${index % 6}`, category_id: `C${index % 22}`,
}));
const csfWithdrawn = [
  ['', '', 'ID.BE-01: [Withdrawn: Incorporated into GV.OC-05]'],
  ['', '', 'PR.IP-01: [Withdrawn: Incorporated into PR.PS-01]'],
];
const csfRows = (records = csfActive) => [
  ['', 'The NIST Cybersecurity Framework 2.0'],
  ['Function', 'Category', 'Subcategory', 'Implementation Examples', 'Informative References'],
  ...records.map((record) => ['', '', `${record.id}: ${record.description}`, 'Example', 'Reference']),
  ...csfWithdrawn,
];

test('CSF publisher withdrawal markers independently exclude legacy IDs from the active inventory', () => {
  const source = parseCsfReferenceToolRows(csfRows());
  assert.equal(source.raw_ids.length, 108);
  assert.equal(source.records.size, 106);
  assert.deepEqual(source.excluded.map((entry) => entry.id), ['ID.BE-01', 'PR.IP-01']);
  assert.ok(source.excluded.every((entry) => entry.reason.startsWith('[Withdrawn:')));
  const enriched = enrichCsfCatalogFromReferenceTool(csfActive, source);
  assert.equal(enriched.publisher_inventory.raw_count, 108);
  assert.equal(enriched.publisher_inventory.eligible_count, 106);
  assert.equal(enriched.publisher_inventory.excluded.length, 2);
  assert.equal(enriched.reconciliation.subcategories, 106);
});

test('CSF withdrawn rows cannot hide a missing active publisher or imported ID', () => {
  assert.throws(() => parseCsfReferenceToolRows(csfRows(csfActive.slice(1))), /only 105 subcategories/);
  const source = parseCsfReferenceToolRows(csfRows());
  assert.throws(() => enrichCsfCatalogFromReferenceTool(csfActive.slice(1), source), /missing publisher subcategories/);
  assert.throws(() => enrichCsfCatalogFromReferenceTool([...csfActive, { id: 'ID.BE-01' }], source), /missing active OSCAL identifiers/);
});

test('CSF duplicates and unmarked extra publisher IDs remain failures', () => {
  assert.throws(() => parseCsfReferenceToolRows([...csfRows(), csfWithdrawn[0]]), /repeats subcategory/);
  const source = parseCsfReferenceToolRows([...csfRows(), ['', '', 'GV.ZZ-99: New active publisher outcome']]);
  assert.throws(() => enrichCsfCatalogFromReferenceTool(csfActive, source), /missing publisher subcategories: GV.ZZ-99/);
});

const rules = () => ({ info: { version: 'test', last_updated: '2026-01-01' }, CTL: {}, FRD: { data: { all: { D1: { definition: 'Publisher definition' } } } }, FRR: {}, KSI: {} });
test('FedRAMP builder independently gates final projection including manufactured empty variants', () => {
  assert.equal(normalizeFedramp2026(rules()).publisher_inventory.eligible_count, 1);
  const payload = rules();
  payload.KSI.G = { indicators: { K1: { varies_by_class: { a: { statement: '' } } } } };
  assert.throws(() => normalizeFedramp2026(payload), /unexpected/);
});
test('FedRAMP fetch validates raw-versus-final inventory before any artifact write', async () => {
  const writes = [];
  const payload = rules();
  payload.FRD.data.all = {};
  await assert.rejects(fetchFedramp2026Rules('2026-01-01', {
    fetchImpl: async (url) => response(url.includes('schema') ? { type: 'object' } : payload),
    writeFile: (...args) => writes.push(args),
  }), /Empty eligible/);
  assert.equal(writes.length, 0);
});

test('framework CLI selection rejects unknown IDs before fetch and supports Rev2 CSV inventory', async () => {
  let fetches = 0;
  await assert.rejects(fetchFrameworkCatalogs({ ...frameworkCatalogOptions(['--only', 'unknown']), fetchImpl: async () => { fetches += 1; } }), /Unknown/);
  assert.equal(fetches, 0);
  assert.throws(() => frameworkCatalogOptions(['--only']), /requires/);
  assert.throws(() => frameworkCatalogOptions(['--only', 'a', '--public', 'b']), /Use --only/);
  const writes = [];
  const body = 'Family,Identifier,Security Requirement,Discussion\nAccess,3.1.1,Requirement,Discussion\n';
  await fetchFrameworkCatalogs({ ...frameworkCatalogOptions(['--only', 'nist-800-171-rev2']), fetchImpl: async () => new Response(body), writeJson: (...args) => writes.push(args) });
  assert.equal(writes[0][1].publisher_inventory.eligible_count, 1);
  assert.equal(writes[0][1].publisher_inventory.publisher_version, null);
});

test('FedRAMP standalone preserves source evidence only for byte-identical downloaded input', () => {
  const bytes = Buffer.from(JSON.stringify(rules(), null, 2));
  const sha = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const prior = normalizeFedramp2026(rules(), { source_sha256: sha, source_byte_length: bytes.length, source_url: 'https://example.test/rules.json' });
  const same = buildFedramp2026FromBytes(bytes, prior);
  assert.equal(same.publisher_inventory.source_sha256, sha);
  assert.equal(same.publisher_inventory.publisher_version, 'test');
  const changed = buildFedramp2026FromBytes(Buffer.from(JSON.stringify(rules())), prior);
  assert.equal(changed.publisher_inventory.source_sha256, null);
  assert.match(changed.publisher_inventory.source_evidence_reason, /do not match/);
  assert.match(changed.publisher_inventory.input_sha256, /^sha256:/);
});
