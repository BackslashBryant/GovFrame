import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOlirStructuredArtifact, retrieveStructuredOlirArtifact, createRegisteredOlirFetch, olirAvailability } from '../tools/relationship-builders/olir-retrieval.mjs';
import { discoverOlirLinks, olirHtmlTables } from '../tools/relationship-builders/olir-html.mjs';
import { applyOlirRetentionHealth, planAlertChanges } from '../tools/report-refresh-alerts.mjs';
import { productionLighthousePlan } from '../tools/collect-production-lighthouse.mjs';
import { validateLighthouseReport, routeThresholdFailures } from '../tools/lighthouse-metrics.mjs';

const htmlArtifact = (html, url) => ({ url, content_type: 'text/html', bytes: Buffer.from(html) });

test('HTML tables keep framework boundaries and actual publisher row locators', async () => {
  const artifact = htmlArtifact('<table><tr><th>BXAI-OS Step</th><th>NIST Focal Element</th><th>Relationship</th><th>Rationale</th></tr><tr><td>Step 1</td><td>AI RMF GOVERN 1.1\nCSF 2.0 ID.AM-01</td><td>Superset of</td><td>Functional</td></tr><tr><td colspan="4">Publisher note</td></tr><tr><td>Step 2</td><td>AI RMF MAP 1.1</td><td>supports</td><td>Functional</td></tr></table>', 'https://bxaios.com/nist-alignment/');
  const ai = await parseOlirStructuredArtifact(artifact, { focalCatalogId: 'nist-ai-rmf' });
  const csf = await parseOlirStructuredArtifact(artifact, { focalCatalogId: 'csf-2' });
  assert.deepEqual(ai.relationships.map(r => r.focal_id), ['GOVERN 1.1', 'MAP 1.1']);
  assert.equal(ai.relationships[1].source_locator, 'table-1#row-4');
  assert.deepEqual(csf.relationships.map(r => r.focal_id), ['ID.AM-01']);
});

test('CSV parses quoted identifiers, commas and multiline explanations faithfully', async () => {
  const parsed = await parseOlirStructuredArtifact({ url: 'https://example.org/map.csv', bytes: Buffer.from('Focal Document Element,Reference Document Element,Relationship Type,Comments\nGV.OC-01,R1,supports,"First clause, second clause\nsecond line"\n') });
  assert.equal(parsed.relationships.length, 1);
  assert.equal(parsed.relationships[0].rationale, 'First clause, second clause\nsecond line');
  const numeric = await parseOlirStructuredArtifact({ url: 'https://example.org/map.csv', bytes: Buffer.from('Focal Document Element,Reference Document Element\n001,002\n') });
  assert.equal(numeric.relationships[0].focal_id, '001');
  assert.equal(numeric.relationships[0].reference_id, '002');
});

test('empty table templates are not relationship data and standard locators preserve original rows', async () => {
  const headers = '<tr><th>Focal Document Element</th><th>Reference Document Element</th></tr>';
  assert.deepEqual(olirHtmlTables(`<table>${headers}<tr><td></td><td></td></tr></table>`, 'https://example.org/map'), []);
  const parsed = await parseOlirStructuredArtifact(htmlArtifact(`<table><tr><td>Title</td></tr>${headers}<tr><td>GV.OC-01</td><td>A1</td></tr></table>`, 'https://example.org/map'));
  assert.equal(parsed.relationships[0].source_locator, 'table-1#row-3');
});

test('developer HTML preserves published actions and does not mix framework tables', async () => {
  const artifact = htmlArtifact('<main><p>Action A1: Establish accountability.</p><p>Alignment with NIST CSF: GV.OC-02, GV.RR.01</p></main>', 'https://www.gov.uk/mapping');
  const parsed = await parseOlirStructuredArtifact(artifact, { focalCatalogId: 'csf-2' });
  assert.deepEqual(parsed.relationships.map(r => r.focal_id), ['GV.OC-02', 'GV.RR.01']);
  assert.ok(parsed.relationships.every(r => r.rationale === 'Action A1: Establish accountability.'));
  const table = '<table><tr><th>AI RMF Function</th><th>Subcategory</th><th>SDOS Controls</th></tr><tr><td>GOVERN</td><td>GOVERN 1.1</td><td>C1, C2</td></tr></table>';
  assert.equal((await parseOlirStructuredArtifact(htmlArtifact(table, 'https://aamcyber.com/sdos/reference/v1/'), { focalCatalogId: 'nist-ai-rmf' })).relationships.length, 2);
  assert.equal(olirHtmlTables(table, 'https://aamcyber.com/sdos/reference/v1/', 'csf-2').length, 0);
});

test('folder discovery and named legacy downloads select only published matching artifacts', () => {
  assert.deepEqual(discoverOlirLinks('<div data-id="published_file_id">Mapping.xlsx</div><div data-id="pdf_id">Guide.pdf</div>', 'https://drive.google.com/drive/folders/folder'), ['https://drive.google.com/uc?export=download&id=published_file_id']);
  const links = '<a href="/get-olir?olir_name=sp800181_to_ssdf_1_0_0">NICE</a><a href="/get-olir?olir_name=csf_1_1_0_to_ssdf_1_0_0">CSF</a>';
  assert.deepEqual(discoverOlirLinks(links, 'https://workforce-builder.herokuapp.com/tools/olirs', { sourceIdentifier: 'NIST-SP-800-181-to-SSDF' }), ['https://workforce-builder.herokuapp.com/get-olir?olir_name=sp800181_to_ssdf_1_0_0']);
});

test('retired downloads cannot silently substitute a current workbook and access limits remain explicit', async () => {
  let calls = 0;
  const result = await retrieveStructuredOlirArtifact(['https://content.securecontrolsframework.com/olir/old.xlsx'], { fetchImpl: async () => {
    calls += 1;
    const response = new Response('<a href="https://content.securecontrolsframework.com/current.xlsx">Download</a>', { headers: { 'content-type': 'text/html' } });
    Object.defineProperty(response, 'url', { value: 'https://securecontrolsframework.com/free-content/scf-download' });
    return response;
  } });
  assert.equal(result.artifact, null);
  assert.equal(calls, 1);
  assert.equal(olirAvailability({ attempts: result.attempted }), 'artifact_replaced_by_html');
  assert.equal(olirAvailability({ attempts: [{ status: 403 }] }), 'access_restricted');
  assert.equal(olirAvailability({ attempts: [{ status: 200 }] }), 'no_public_mapping_discovered');
  assert.equal(olirAvailability({ parse_failed: true }), 'parse_failed');
});

test('temporary HTML and server failures recover within the same bounded artifact retrieval', async () => {
  for (const failure of ['html', 'server', 'network']) {
    let calls = 0;
    const delays = [];
    const result = await retrieveStructuredOlirArtifact(['https://content.securecontrolsframework.com/olir/map.xlsx'], {
      wait: async (ms) => delays.push(ms),
      fetchImpl: async () => {
        calls += 1;
        if (calls === 1) {
          if (failure === 'network') throw Object.assign(new Error('connection reset'), { code: 'ECONNRESET' });
          return new Response('<html>Unavailable</html>', { status: failure === 'server' ? 503 : 200, headers: { 'content-type': 'text/html' } });
        }
        return new Response(Buffer.from('PKworkbook'), { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
      },
    });
    assert.equal(calls, 2);
    assert.deepEqual(delays, [1000]);
    assert.equal(result.attempted.length, 2);
    assert.equal(result.artifact.bytes.toString(), 'PKworkbook');
  }
});

test('persistent bad responses are bounded and access restrictions are not retried', async () => {
  for (const status of [200, 403, 429, 503]) {
    let calls = 0;
    const result = await retrieveStructuredOlirArtifact(['https://content.securecontrolsframework.com/olir/map.xlsx'], {
      wait: async () => {}, fetchImpl: async () => { calls += 1; return new Response('<html>Unavailable</html>', { status, headers: { 'content-type': 'text/html' } }); },
    });
    assert.equal(result.artifact, null);
    assert.equal(calls, status === 403 ? 1 : 2);
  }
  let total = 0;
  await retrieveStructuredOlirArtifact(Array.from({ length: 25 }, (_, index) => `https://example.org/map-${index}.xlsx`), {
    wait: async () => {}, fetchImpl: async () => { total += 1; return new Response('', { status: 503 }); },
  });
  assert.equal(total, 24, 'retries share the candidate request ceiling');
});

test('registered landing page grants only discovered structured artifact paths', async () => {
  const page = 'https://www.razil.io/post/mapping';
  const file = 'https://irp.cdn-website.com/account/map.csv';
  const calls = [];
  const scoped = createRegisteredOlirFetch([page], { fetchImpl: async url => {
    calls.push(url);
    return new Response(url === page ? `<a href="${file}">Mapping</a>` : 'Focal Document Element,Reference Document Element\nGV.OC-01,R1', { headers: { 'content-type': url === page ? 'text/html' : 'text/csv' } });
  } });
  const result = await retrieveStructuredOlirArtifact([page], { fetchImpl: scoped });
  assert.equal(result.artifact.url, file);
  assert.deepEqual(calls, [page, file]);
  await assert.rejects(scoped('https://irp.cdn-website.com/account/other.csv'), /policy/);
  const issueOnly = createRegisteredOlirFetch(['https://github.com/example/mapping/issues/1'], { fetchImpl: async () => new Response('') });
  await assert.rejects(issueOnly('https://api.github.com/repos/example/mapping/contents/'), /policy/);
});

test('retention keeps an existing incident open until actual recovery without mutating admission', () => {
  const results = [{ sourceId: 'fetch-olir-catalog', status: 'accepted', attempts: 1 }];
  const retained = applyOlirRetentionHealth(results, { processed_items: [{ id: 183, refresh_status: 'retained_last_good', refresh_error: 'HTTP 503' }] });
  const issue = { number: 1, state: 'open', title: 'old', body: '<!-- control-atlas-refresh:fetch-olir-catalog -->\nold' };
  assert.equal(planAlertChanges(retained, [issue])[0].payload.state, 'open');
  assert.equal(results[0].status, 'accepted');
  assert.equal(planAlertChanges(applyOlirRetentionHealth(results, { processed_items: [] }), [issue])[0].payload.state, 'closed');
});

test('production measurement has fixed warmups, three measured runs and unchanged budgets', () => {
  const plan = productionLighthousePlan('https://rambulls.github.io/control-atlas/');
  assert.equal(plan.filter(r => r.warmup).length, 2);
  assert.equal(plan.filter(r => !r.warmup).length, 3);
  assert.ok(plan.every(r => r.args.includes('--save-assets')));
  assert.ok(plan.filter(r => r.warmup).every(r => r.args.at(-1).includes('/warmups/')));
  assert.equal(routeThresholdFailures([{ url: 'x', runs: 3, lcpMs: 1000, cls: 0, tbtMs: 201 }]).length, 1);
});

test('incomplete or failed Lighthouse reports cannot masquerade as zero blocking time', () => {
  const report = { audits: Object.fromEntries(['largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift'].map(key => [key, { numericValue: 0 }])), categories: { performance: { score: 1 }, accessibility: { score: 1 } } };
  validateLighthouseReport(report);
  delete report.audits['total-blocking-time'];
  assert.throws(() => validateLighthouseReport(report), /metric/);
  assert.throws(() => validateLighthouseReport({ runtimeError: { code: 'NO_FCP' } }), /runtime failure/);
});
