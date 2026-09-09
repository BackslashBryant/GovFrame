import assert from 'node:assert/strict';
import test from 'node:test';
import { validateStructuredAssetCandidate } from '../scripts/discover-nist-structured-assets.mjs';
import { validateNaraCandidate } from '../scripts/fetch-nara-cui-registry.mjs';
import { validateOlirCandidate } from '../scripts/fetch-olir-catalog.mjs';

test('structured discovery rejects caught network and parser failures before publication', () => {
  assert.doesNotThrow(() => validateStructuredAssetCandidate({ pages: [{ status: 'fetched' }] }));
  for (const status of ['failed', 'parse_failed']) {
    assert.throws(() => validateStructuredAssetCandidate({ pages: [
      { status: 'fetched' }, { url: 'https://pages.nist.gov/example/', status },
    ] }), /discovery incomplete/);
  }
});

test('NARA rejects failed or missing details and unavailable change log', () => {
  const candidate = { total_entries: 1, results: [{ status: 'OK' }], change_log: { byte_length: 4 } };
  assert.doesNotThrow(() => validateNaraCandidate(candidate));
  assert.throws(() => validateNaraCandidate({ ...candidate, results: [{ status: 'FAILED' }] }), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, results: [] }), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, results: new Array(1) }), /refresh incomplete/);
  assert.throws(() => validateNaraCandidate({ ...candidate, change_log: { status: 'FAILED' } }), /refresh incomplete/);
});

const detail = { kind: 'NIST catalog detail endpoint', status: 200 };
const validMapping = { attempts: [detail], mapping: { map_file: 'maps/olir/1.json' } };

test('OLIR rejects missing detail, failed artifact, and parser failure despite other successful entries', () => {
  for (const failure of [
    { attempts: [{ error: 'offline' }], mapping: null },
    { attempts: [{ status: 503 }], mapping: {} },
    { attempts: [detail, { status: 503 }], mapping: null },
    { attempts: [detail], mapping: null, parse_failed: true },
    { attempts: [detail], mapping: null },
    { attempts: [detail, { error: 'offline' }], mapping: null, unsupported: true },
  ]) {
    assert.throws(() => validateOlirCandidate(new Map([[1, validMapping], [2, failure]])), /incomplete for 2/);
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
