import assert from 'node:assert/strict';
import test from 'node:test';
import { retrieveStructuredOlirArtifact } from '../tools/relationship-builders/olir-retrieval.mjs';

test('GitHub blob XLSX is retrieved through the Contents API without a HEAD page probe', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method || 'GET' });
    if (String(url).startsWith('https://api.github.com/repos/example/mapping/contents/OLIR.xlsx')) {
      return Response.json({
        type: 'file', name: 'OLIR.xlsx', path: 'OLIR.xlsx',
        download_url: 'https://raw.githubusercontent.com/example/mapping/main/OLIR.xlsx',
      });
    }
    if (String(url).startsWith('https://raw.githubusercontent.com/example/mapping/main/OLIR.xlsx')) {
      return new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]), {
        status: 200,
        headers: { 'content-type': 'text/html' },
      });
    }
    throw new Error(`unexpected URL: ${url}`);
  };
  try {
    const result = await retrieveStructuredOlirArtifact(
      ['https://github.com/example/mapping/blob/main/OLIR.xlsx'],
      { fetchImpl: globalThis.fetch },
    );
    assert.ok(result.artifact, 'the GitHub XLSX must be downloaded, not quarantined');
    assert.equal(result.artifact.url, 'https://raw.githubusercontent.com/example/mapping/main/OLIR.xlsx');
    assert.equal(result.artifact.bytes.length, 4);
    assert.ok(calls.some((call) => call.url.includes('api.github.com/repos/example/mapping/contents/OLIR.xlsx')));
    assert.ok(calls.every((call) => call.method === 'GET'), 'a GitHub blob page HEAD request is not an artifact test');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('public Google Sheets submission resolves through its deterministic XLSX export', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.equal(String(url), 'https://docs.google.com/spreadsheets/d/public-sheet/export?format=xlsx');
    return new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04]), { status: 200, headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
  };
  try {
    const result = await retrieveStructuredOlirArtifact(
      ['https://docs.google.com/spreadsheets/d/public-sheet/edit'],
      { fetchImpl: globalThis.fetch },
    );
    assert.equal(result.artifact?.url, 'https://docs.google.com/spreadsheets/d/public-sheet/export?format=xlsx');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('OLIR workbook preserves every relationship sheet and keeps strength separate from type', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const { parseOlirStructuredArtifact } = await import('../tools/relationship-builders/olir-retrieval.mjs');
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('General Information').addRow(['Field Name', 'Value']);
  workbook.getWorksheet('General Information').addRow(['Informative Reference Name', 'Mapping (Focal: CSF 2.0)']);
  for (const family of ['AC', 'SR']) {
    const sheet = workbook.addWorksheet(family === 'AC' ? 'Relationships-AC' : 'SR');
    sheet.addRow(['Focal Document Element', 'Reference Document Element', 'Strength of Relationship (Optional)', 'Relationship Explanation']);
    sheet.addRow([`${family}-01`, 'CIP-003-9', 8, 'Publisher explanation']);
  }
  const supportive = workbook.addWorksheet('Relationships-Supportive');
  supportive.addRow(['Focal Document Element', 'Reference Document Element', 'Relationship Type', 'Strength of Relationship']);
  supportive.addRow(['GV.OC-01', '12.1.1', 'supports', 5]);
  const artifact = { url: 'https://example.org/mapping.xlsx', bytes: Buffer.from(await workbook.xlsx.writeBuffer()) };
  const result = await parseOlirStructuredArtifact(artifact);
  assert.equal(result.relationships.length, 3);
  assert.deepEqual(result.relationships.map(row => row.focal_id), ['AC-01', 'SR-01', 'GV.OC-01']);
  assert.equal(result.relationships[0].relationship_type, 'Concept Crosswalk');
  assert.equal(result.relationships[0].relationship_strength, '8');
  assert.equal(result.relationships[0].relationship_explanation, 'Publisher explanation');
  assert.match(result.relationships[1].source_locator, /^SR#/);
  assert.equal(result.relationships[2].relationship_type, 'Supportive');
  assert.equal(result.relationships[2].raw_relationship_type, 'supports');
  workbook.addWorksheet('Relationships-Broken').addRow(['Unrecognized content']);
  await assert.rejects(parseOlirStructuredArtifact({ ...artifact, bytes: Buffer.from(await workbook.xlsx.writeBuffer()) }), /columns are absent/);
});

test('registered submission grants are exact, isolated, and enforced on redirects', async () => {
  const { createRegisteredOlirFetch } = await import('../tools/relationship-builders/olir-retrieval.mjs');
  const registered = 'https://github.com/example/maps/tree/main/olir';
  const calls = [];
  const transport = async (url) => { calls.push(url); return new Response('bytes'); };
  const scoped = createRegisteredOlirFetch([registered, 'https://securecontrolsframework.com/content/olir/map.xlsx'], { fetchImpl: transport });
  await scoped('https://api.github.com/repos/example/maps/contents/olir?ref=main');
  await scoped('https://raw.githubusercontent.com/example/maps/main/olir/new-version.xlsx');
  await scoped('https://securecontrolsframework.com/content/olir/map.xlsx');
  assert.equal(calls.length, 3);
  for (const url of [
    'https://raw.githubusercontent.com/example/maps/main/elsewhere.xlsx',
    'https://raw.githubusercontent.com/example/maps/other/olir/new-version.xlsx',
    'https://raw.githubusercontent.com/example/maps/main/olir/subdir/other.xlsx',
    'https://securecontrolsframework.com/content/olir/other.xlsx',
    'https://127.0.0.1/mapping.xlsx',
    'https://api.github.com/repos/example/maps/contents/olir?ref=other',
  ]) await assert.rejects(scoped(url), /source URL policy/);
  assert.equal(calls.length, 3, 'denied destinations must never reach transport');
  await assert.rejects(createRegisteredOlirFetch([], { fetchImpl: transport })('https://raw.githubusercontent.com/example/maps/main/olir/new-version.xlsx'), /source URL policy/);
  const redirected = createRegisteredOlirFetch([registered], { fetchImpl: async () => new Response(null, { status: 302, headers: { location: 'https://attacker.test/mapping.xlsx' } }) });
  await assert.rejects(redirected('https://api.github.com/repos/example/maps/contents/olir?ref=main'), /source URL policy/);
});

test('registered publisher redirects preserve artifact identity', async () => {
  const { createRegisteredOlirFetch } = await import('../tools/relationship-builders/olir-retrieval.mjs');
  const scoped = createRegisteredOlirFetch([
    'https://docs.google.com/spreadsheets/d/public-sheet/edit',
    'https://securecontrolsframework.com/content/olir/map.xlsx',
  ], { fetchImpl: async () => new Response('bytes') });
  await scoped('https://doc-0c-98-sheets.googleusercontent.com/export/token/public-sheet?format=xlsx');
  await scoped('https://content.securecontrolsframework.com/olir/map.xlsx');
  await assert.rejects(scoped('https://doc-0c-98-sheets.googleusercontent.com/export/token/other-sheet?format=xlsx'), /source URL policy/);
  await assert.rejects(scoped('https://content.securecontrolsframework.com/olir/other.xlsx'), /source URL policy/);
  await assert.rejects(scoped('https://doc-0c-98-sheets.googleusercontent.com.attacker.test/export/token/public-sheet?format=xlsx'), /source URL policy/);
});
