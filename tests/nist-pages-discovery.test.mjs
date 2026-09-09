import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractNistPagesInventory,
  extractStructuredAssets,
  selectStructuredAssetCandidatePages,
} from '../scripts/lib/nist-pages-discovery.mjs';

test('NIST Pages discovery inventories and classifies every table project', () => {
  const html = `
    <table><tbody>
      <tr><th>Repo Name</th><th>Description</th></tr>
      <tr><td><a href="../zero-trust-architecture/">zero-trust-architecture</a></td><td>Implementing a Zero Trust Architecture</td></tr>
      <tr><td><a href="/OSCAL/">OSCAL</a></td><td>Open Security Controls Assessment Language</td></tr>
      <tr><td><a href="/fds/">fds</a></td><td>Fire Dynamics Simulator</td></tr>
    </tbody></table>`;
  const entries = extractNistPagesInventory(html);
  assert.equal(entries.length, 3);
  assert.equal(entries.find((entry) => entry.repo_name === 'zero-trust-architecture').disposition, 'candidate');
  assert.ok(entries.find((entry) => entry.repo_name === 'OSCAL').topics.includes('security-controls'));
  assert.deepEqual(entries.find((entry) => entry.repo_name === 'fds').reason, 'no-cybersecurity-or-governance-title-signal');
  assert.equal(entries.find((entry) => entry.repo_name === 'zero-trust-architecture').url, 'https://pages.nist.gov/zero-trust-architecture/');
});

test('structured asset discovery finds data files and bounded relevant child pages', () => {
  const html = `
    <a href="Mappings.html">Mappings</a>
    <a href="downloads/control-map.xlsx#sheet">Control map</a>
    <a href="/project/data/catalog.json">JSON catalog</a>
    <a href="guide.html">Ordinary guide</a>`;
  assert.deepEqual(extractStructuredAssets(html, 'https://pages.nist.gov/project/').map((asset) => [asset.format, asset.url]), [
    ['json', 'https://pages.nist.gov/project/data/catalog.json'],
    ['xlsx', 'https://pages.nist.gov/project/downloads/control-map.xlsx'],
  ]);
  assert.deepEqual(selectStructuredAssetCandidatePages(html, 'https://pages.nist.gov/project/'), [
    'https://pages.nist.gov/project/Mappings.html',
  ]);
});

test('deeply nested publisher HTML defeats the parser, so callers must isolate the parse', () => {
  // Regression guard for the 2026-09-09 refresh outage: a NIST Pages project
  // page nested deeply enough overflows node-html-parser's stack, and the
  // refresh aborted every remaining ingestion task. discover-nist-structured-assets
  // now records such a page as `parse_failed` and continues, which is only
  // correct while this call can still throw. If this assertion starts failing,
  // the parser gained its own guard and that isolation can be revisited.
  const deep = `${'<div>'.repeat(20000)}<a href="/x.csv">c</a>${'</div>'.repeat(20000)}`;
  assert.throws(() => extractStructuredAssets(deep, 'https://pages.nist.gov/p/'), RangeError);

  // The same content shallow enough to parse is still extracted normally.
  const shallow = `${'<div>'.repeat(50)}<a href="/x.csv">c</a>${'</div>'.repeat(50)}`;
  assert.equal(extractStructuredAssets(shallow, 'https://pages.nist.gov/p/').length, 1);
});
