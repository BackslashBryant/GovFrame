import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStructuredAssetCandidate, retainUnavailableDiscovery } from '../scripts/discover-nist-structured-assets.mjs';
import { validateNaraCandidate } from '../scripts/fetch-nara-cui-registry.mjs';
import { validateOlirCandidate, retainOlirSubmissions } from '../scripts/fetch-olir-catalog.mjs';

test('discovery discloses unavailable pages and rejects total retrieval failure', () => {
  assert.doesNotThrow(() => validateStructuredAssetCandidate({ pages: [{ status: 'fetched' }] }));
  for (const status of ['failed', 'parse_failed']) {
    assert.doesNotThrow(() => validateStructuredAssetCandidate({ pages: [
      { status: 'fetched' }, { url: 'https://pages.nist.gov/example/', status },
    ] }));
    assert.throws(() => validateStructuredAssetCandidate({ pages: [{ status }] }), /discovery incomplete/);
  }
});

test('failed discovery pages retain their prior assets and recovered pages replace that evidence', () => {
  const asset = { url: 'https://pages.nist.gov/a/data.csv', format: 'csv', source_pages: ['https://pages.nist.gov/a/'] };
  const previous = { assets: [asset] };
  const output = { pages: [{ url: 'https://pages.nist.gov/a/', status: 'failed' }, { url: 'https://pages.nist.gov/b/', status: 'fetched' }], assets: [], reconciliation: {} };
  assert.throws(() => validateStructuredAssetCandidate(output, previous), /inventory became empty|lost accepted asset/);
  assert.throws(() => validateStructuredAssetCandidate({ ...output, pages: [{ status: 'fetched', url: asset.source_pages[0] }] }, previous), /inventory became empty/);
  retainUnavailableDiscovery(output, previous);
  validateStructuredAssetCandidate(output, previous);
  assert.equal(output.assets[0].url, asset.url);
  assert.equal(output.reconciliation.assets_retained, 1);
  assert.equal(previous.assets[0].retention_reason, undefined);
  const recovered = { pages: [{ url: 'https://pages.nist.gov/a/', status: 'fetched' }], assets: [asset], reconciliation: {} };
  retainUnavailableDiscovery(recovered, output);
  assert.equal(recovered.reconciliation.assets_retained, 0);
});

test('NARA rejects failed or missing details and unavailable change log', () => {
  const candidate = { total_entries: 1, results: [{ status: 'OK' }], change_log: { byte_length: 4 } };
  assert.doesNotThrow(() => validateNaraCandidate(candidate));
  assert.throws(() => validateNaraCandidate({ ...candidate, results: [{ status: 'FAILED' }] }), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, results: [] }), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, results: new Array(1) }), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, change_log: { status: 'FAILED' } }), /refresh incomplete/);
});

test('NARA preserves disclosed publisher gaps but rejects loss of previously accepted content', () => {
  const good = { slug: 'good', status: 'OK' };
  const missing = { slug: 'missing', status: 'FAILED', error: 'HTTP 404' };
  const previous = { results: [good, missing] };
  const candidate = { total_entries: 2, results: [good, missing], change_log: { byte_length: 10 } };
  assert.doesNotThrow(() => validateNaraCandidate(candidate, previous));
  assert.throws(() => validateNaraCandidate({ ...candidate, results: [missing, { ...good, status: 'FAILED' }] }, previous), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, total_entries: 1, results: [missing] }, previous), /previously accepted details lost/);
  assert.doesNotThrow(() => validateNaraCandidate({ ...candidate, results: [good, { ...missing, status: 'OK' }] }, previous));
});

const detail = { kind: 'NIST catalog detail endpoint', status: 200 };
const validMapping = { attempts: [detail], mapping: { map_file: 'maps/olir/1.json' } };

test('OLIR rejects failed catalog detail evidence despite other successful entries', () => {
  for (const failure of [
    { attempts: [{ error: 'offline' }], mapping: null },
    { attempts: [{ status: 503 }], mapping: {} },
  ]) {
    assert.throws(() => validateOlirCandidate(new Map([[1, validMapping], [2, failure]])), /incomplete for 2/);
  }
});

test('OLIR isolates unimportable new entries but never loses previously published mappings', () => {
  for (const failure of [
    { attempts: [detail, { status: 503 }], mapping: null },
    { attempts: [detail], mapping: null, parse_failed: true },
    { attempts: [detail], mapping: null },
  ]) {
    const entries = new Map([[1, validMapping], [2, failure]]);
    assert.doesNotThrow(() => validateOlirCandidate(entries, [{ id: 2, ingested: false }]));
    assert.throws(() => validateOlirCandidate(entries, [{ id: 2, ingested: true }]), /incomplete for 2/);
  }
});

test('OLIR permits successful unsupported candidates but never drops previously ingested mappings', () => {
  const unsupported = { attempts: [detail], mapping: null, unsupported: true };
  const candidate = new Map([[1, validMapping], [2, unsupported]]);
  assert.doesNotThrow(() => validateOlirCandidate(candidate, [{ id: 2, ingested: false }]));
  assert.throws(() => validateOlirCandidate(candidate, [{ id: 2, ingested: true }]), /incomplete for 2/);
  // Non-Final/out-of-scope entries are intentionally absent from retrievals.
  assert.doesNotThrow(() => validateOlirCandidate(new Map(), [{ id: 3, ingested: false }]));
});

test('OLIR valid mappings pass without mutating staged documents or prior evidence', () => {
  const previous = [{ id: 1, ingested: true }];
  const candidate = new Map([[1, structuredClone(validMapping)]]);
  const before = structuredClone({ candidate, previous });
  validateOlirCandidate(candidate, previous);
  assert.deepEqual({ candidate, previous }, before);
});

test('OLIR preserves exact accepted bytes for unavailable submissions and clears retention on recovery', () => {
  const artifact = { map_file: 'maps/olir/225.json', checksum: 'sha256:accepted', byte_length: 10, relationship_count: 1 };
  const previous = [{ id: 225, ingested: true, map_file: artifact.map_file, artifact }];
  const bytes = Buffer.from(JSON.stringify({ olir_id: 225, sha256: artifact.checksum, byte_length: 10, relationships: [{ focal_id: 'A', reference_id: 'B' }] }) + '\n');
  const failed = new Map([[225, { attempts: [detail], mapping: null, unavailable_reason: 'publisher unavailable' }]]);
  const retained = retainOlirSubmissions(failed, previous, () => bytes);
  validateOlirCandidate(retained, previous);
  assert.ok(retained.get(225).retainedBytes.equals(bytes));
  assert.deepEqual(retained.get(225).retainedItem, previous[0]);
  assert.equal(failed.get(225).mapping, null);
  assert.throws(() => retainOlirSubmissions(failed, previous, () => Buffer.from('{}')), /evidence mismatch/);
  assert.throws(() => retainOlirSubmissions(failed, [{ ...previous[0], map_file: '../other' }], () => bytes), /invalid retained mapping path/);
  const recovered = retainOlirSubmissions(new Map([[225, validMapping]]), previous, () => { throw new Error('unnecessary reread'); });
  assert.equal(recovered.get(225).retainedBytes, undefined);
});
