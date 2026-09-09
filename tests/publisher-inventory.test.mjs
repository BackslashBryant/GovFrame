import test from 'node:test';
import assert from 'node:assert/strict';
import { assertPublisherInventory as check } from '../scripts/lib/publisher-inventory.mjs';

const oscal = (controls) => ({ catalog: { groups: [{ id: 'family', controls }] } });
const control = (id) => ({ id, class: 'SP800-53' });
test('independent OSCAL count catches lost and legitimately added publisher records', () => {
  const payload = oscal([control('ac-1'), control('ac-2')]);
  assert.throws(() => check('oscal-800-53', payload, [{ id: 'AC-1' }]), /mismatch/);
  const result = check('oscal-800-53', payload, [{ id: 'AC-2' }, { id: 'AC-1' }]);
  assert.equal(result.eligible_count, 2);
  assert.equal(result.raw_count, 3);
  assert.equal(result.excluded.length, 1);
  assert.match(result.raw_identity_sha256, /^sha256:[a-f0-9]{64}$/);
});
test('silent-zero and malformed publisher shapes fail closed', () => {
  for (const payload of [{}, { catalog: {} }, { catalog: { controls: {} } }]) assert.throws(() => check('oscal-800-53', payload, []));
  assert.throws(() => check('unknown', {}, []), /Unsupported/);
  assert.throws(() => check('ai-rmf', [{ title: 'A', description: 'text' }], []), /mismatch/);
});
test('duplicate raw, normalized, imported and missing IDs fail', () => {
  assert.throws(() => check('oscal-800-53', oscal([control('ac-1'), control('ac-1')]), []), /Duplicate publisher/);
  assert.throws(() => check('oscal-800-53', oscal([control('ac-1'), control('AC-1')]), []), /Duplicate eligible/);
  assert.throws(() => check('oscal-800-53', oscal([control(null)]), []), /Missing publisher/);
  assert.throws(() => check('oscal-800-53', oscal([control('ac-1')]), [{ id: 'AC-1' }, { id: 'AC-1' }]), /Duplicate imported/);
});
test('root and nested OSCAL controls are inventoried with requirement ID projection', () => {
  assert.equal(check('oscal-800-171', { catalog: { controls: [{ id: '03.01.01', class: 'requirement' }] } }, [{ id: '3.1.1' }]).eligible_count, 1);
  assert.equal(check('oscal-800-172', oscal([{ id: '03.01.01a', class: 'security_requirement' }]), [{ id: '3.1.1A' }]).eligible_count, 1);
  assert.equal(check('oscal-ssdf', { catalog: { groups: [{ id: 'g', groups: [{ id: 'g2', controls: [{ id: 'po-1', controls: [{ id: 'po-1-1' }] }] }] }] } }, [{ id: 'PO.1.1' }]).eligible_count, 1);
});
test('ATT&CK retains revoked techniques and requires publisher external IDs in both domains', () => {
  const payload = { objects: [{ id: 'attack-pattern--1', type: 'attack-pattern', revoked: true, external_references: [{ source_name: 'mitre-attack', external_id: 'T1' }] }] };
  for (const format of ['attack-enterprise', 'attack-ics']) assert.equal(check(format, payload, [{ id: 'T1' }]).eligible_count, 1);
  payload.objects[0].external_references = [];
  assert.throws(() => check('attack-ics', payload, []), /Missing publisher identity/);
});
test('AI RMF records explicit exclusions and rejects cleaned-empty IDs', () => {
  const result = check('ai-rmf', [{ title: ' A ', description: 'text' }, { title: 'B' }], [{ id: 'A' }]);
  assert.equal(result.excluded.length, 1);
  assert.throws(() => check('ai-rmf', [{ title: '<b></b>', description: 'text' }], []), /Missing publisher/);
});
test('FedRAMP independently walks each section and excludes empty variants', () => {
  const payload = { CTL: { AC: { 'AC-1': { guidance: ['guide'] }, 'AC-2': {} } }, FRD: { data: { all: { D1: { definition: 'meaning' } } } }, FRR: { P: { data: { all: { S: { R1: { statement: 'rule' }, R2: { varies_by_class: { a: { statement: '' } } } } } } } }, KSI: { G: { indicators: { K1: { varies_by_class: { a: { statement: 'indicator' } } } } } } };
  const records = ['CTL-AC-1', 'D1', 'R1', 'K1'].map((id) => ({ id }));
  const result = check('fedramp-2026', payload, records);
  assert.equal(result.raw_count, 6);
  assert.equal(result.eligible_count, 4);
  assert.equal(result.excluded.length, 2);
  assert.throws(() => check('fedramp-2026', payload, [...records, { id: 'R2' }]), /unexpected/);
  delete payload.FRR.P.data;
  assert.throws(() => check('fedramp-2026', payload, records), /Invalid publisher object/);
});

test('Rev2 CSV inventories decoded publisher rows and catches lost and duplicate requirements', () => {
  const csv = 'Family,Identifier,Security Requirement,Discussion\r\nAccess,3.1.1,"Requirement, quoted","Two\nlines"\r\nAccess,3.1.2,Other,Text\r\n';
  assert.equal(check('csv-800-171-rev2', csv, [{ id: '3.1.1' }, { id: '3.1.2' }]).eligible_count, 2);
  assert.throws(() => check('csv-800-171-rev2', csv, [{ id: '3.1.1' }]), /mismatch/);
  assert.throws(() => check('csv-800-171-rev2', csv.replace('3.1.2', '3.1.1'), []), /Duplicate publisher/);
  assert.throws(() => check('csv-800-171-rev2', csv + 'Access,,Requirement,Text\n', []), /Missing publisher/);
  assert.throws(() => check('csv-800-171-rev2', csv + '"unfinished', []), /unterminated/);
});

test('D3FEND independently traverses graph links with explicit unreachable and structural exclusions', () => {
  const payload = { '@graph': [
    { '@id': 'd3f:Detect' },
    { '@id': 'd3f:Parent', 'd3f:enables': { '@id': 'd3f:Detect' } },
    { '@id': 'd3f:A', 'd3f:d3fend-id': 'D3-A', 'rdfs:subClassOf': [{ '@id': 'd3f:Parent' }] },
    { '@id': 'd3f:B', 'd3f:d3fend-id': 'D3-B', 'rdfs:subClassOf': { '@id': 'd3f:B' } },
  ] };
  const result = check('d3fend', payload, [{ id: 'D3-A' }]);
  assert.equal(result.raw_count, 4);
  assert.equal(result.excluded.length, 3);
  assert.ok(result.excluded.some((entry) => entry.id === 'd3f:B' && /no reachable/.test(entry.reason)));
  assert.throws(() => check('d3fend', payload, []), /mismatch/);
  payload['@graph'].push({ '@id': 'd3f:C', 'd3f:d3fend-id': 'D3-A' });
  assert.throws(() => check('d3fend', payload, []), /Duplicate publisher technique/);
});
