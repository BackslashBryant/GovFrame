import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { hydrateArtifacts, hydrationResolutions, countXlsxRows } from '../scripts/hydrate-artifacts.mjs';
import { enrichCommonsDataset, repositoryResourceIds, repositoryIdentity } from '../scripts/enrich-commons-resources.mjs';
import { sourceUnitsForTask, loadSourceUnitInventory } from '../scripts/lib/refresh-source-outputs.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'source-unit-tests');
mkdirSync(fixtures, { recursive: true });
after(() => rmdirSync(fixtures));
function setup(t) {
  const root = mkdtempSync(join(fixtures, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), JSON.stringify(value)); };
  const get = (path) => readFileSync(join(root, path), 'utf8');
  return { root, put, get };
}
const checksum = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

test('audited publisher repository transfers resolve before requesting API evidence', () => {
  assert.deepEqual(repositoryIdentity({ repositoryUrl: 'https://github.com/IBM/compliance-trestle' }), { owner: 'oscal-compass', repo: 'compliance-trestle', scope: 'repository' });
  assert.deepEqual(repositoryIdentity({ repositoryUrl: 'https://github.com/mitre/caldera' }), { owner: 'apache', repo: 'caldera', scope: 'repository' });
  assert.equal(repositoryIdentity({ repositoryUrl: 'https://github.com/mitre/unknown' }).owner, 'mitre');
});

test('exact hydration failure cannot carry prior OK forward or write either file', async (t) => {
  const { root, put, get } = setup(t);
  put('data/source-registry.json', { artifacts: [{ id: 'artifact-a', sha256: checksum('old') }], catalog_source_bundles: [] });
  put('data/artifact-hydration-manifest.json', { results: [{ id: 'artifact-a', status: 'OK', sha256: checksum('old') }] });
  const before = [get('data/source-registry.json'), get('data/artifact-hydration-manifest.json')];
  await assert.rejects(hydrateArtifacts({ root, only: 'artifact-a', resolutions: [{ id: 'artifact-a', url: 'https://example.invalid/a' }], fetchImpl: () => { throw new Error('offline'); } }), /Hydration artifact-a failed/);
  assert.deepEqual([get('data/source-registry.json'), get('data/artifact-hydration-manifest.json')], before);
});

test('exact hydration selects no prefix siblings and preserves unrelated registry/log entries', async (t) => {
  const { root, put, get } = setup(t);
  const unrelated = { id: 'artifact-nist-oscal', sha256: checksum('unrelated') };
  put('data/source-registry.json', { artifacts: [{ id: 'artifact-a' }, unrelated], catalog_source_bundles: [] });
  const prior = { id: 'artifact-b', status: 'OK', sha256: checksum('b') };
  put('data/artifact-hydration-manifest.json', { results: [prior] });
  const seen = [];
  const resolutions = [{ id: 'artifact-a', url: 'https://example.invalid/a' }, { id: 'artifact-a-child', url: 'https://example.invalid/child' }];
  await hydrateArtifacts({ root, only: 'artifact-a', resolutions, fetchImpl: (url) => { seen.push(url); return { buf: Buffer.from('a'), status: 200 }; } });
  assert.deepEqual(seen, ['https://example.invalid/a']);
  assert.deepEqual(JSON.parse(get('data/source-registry.json')).artifacts[1], unrelated);
  assert.deepEqual(JSON.parse(get('data/artifact-hydration-manifest.json')).results[0], prior);
  await assert.rejects(hydrateArtifacts({ root, only: 'unknown', resolutions }), /No artifact resolutions/);
});

test('workbook temporary bytes stay under repository and disappear on reader failure', async (t) => {
  const { root } = setup(t);
  await assert.rejects(countXlsxRows(Buffer.from('fixture'), { root, readWorkbook: (path) => {
    assert.ok(path.startsWith(join(root, '.local')));
    assert.equal(readFileSync(path, 'utf8'), 'fixture');
    throw new Error('invalid workbook');
  } }), /invalid workbook/);
  assert.deepEqual(readdirSync(join(root, '.local')), []);
});

const resources = () => ({ resources: [
  { id: 'a', name: 'A', summary: 'A summary', resourceType: 'tool', canonicalUrl: 'https://github.com/example/a' },
  { id: 'b', name: 'B', summary: 'B summary', resourceType: 'tool', canonicalUrl: 'https://github.com/example/b', currentVersion: 'Current' },
] });

test('single Commons resource refresh preserves every nonselected field and rejects unknown selection', async () => {
  const dataset = resources();
  const untouched = JSON.stringify(dataset.resources[1]);
  const seen = [];
  await enrichCommonsDataset(dataset, { refresh: true, id: 'a', fetchEvidence: (identity) => {
    seen.push(identity.repo);
    return { sections: {}, media: [], facts: {} };
  } });
  assert.deepEqual(seen, ['a']);
  assert.equal(JSON.stringify(dataset.resources[1]), untouched);
  await assert.rejects(enrichCommonsDataset(dataset, { id: 'unknown' }), /Unknown repository resource/);
});

test('run-start source selections remain stable after later dataset mutation', (t) => {
  const { root, put } = setup(t);
  const dataset = resources();
  put('data/commons-resource-dataset.json', dataset);
  const task = { id: 'enrich-commons-resources', script: 'enrich-commons-resources.mjs', remote_fetch: true, isolation: 'quarantinable', retries: 2 };
  const inventory = loadSourceUnitInventory(root, [task]);
  put('data/commons-resource-dataset.json', { resources: [{ ...dataset.resources[0], id: 'new' }] });
  assert.deepEqual(sourceUnitsForTask(task, inventory).map((unit) => unit.args), [['--refresh', '--id=a'], ['--refresh', '--id=b']]);
  assert.deepEqual(repositoryResourceIds(dataset), ['a', 'b']);
  const hydrationTask = { ...task, id: 'hydrate-artifacts', script: 'hydrate-artifacts.mjs' };
  const units = sourceUnitsForTask(hydrationTask, { hydration: [{ id: 'artifact-a' }, { id: 'artifact-a-child' }] });
  assert.deepEqual(units.map((unit) => unit.args), [['--only', 'artifact-a'], ['--only', 'artifact-a-child']]);
  assert.equal(new Set(hydrationResolutions().map((entry) => entry.id)).size, hydrationResolutions().length);
});
