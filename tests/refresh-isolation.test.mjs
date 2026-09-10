import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { runRefreshPipeline, executeRefreshUnit } from '../scripts/refresh-data.mjs';
import { INGESTION_TASKS, validateIngestionPipelineDefinition } from '../scripts/lib/ingestion-pipeline.mjs';
import { sourceUnitsForTask, localProjectionForTask } from '../scripts/lib/refresh-source-outputs.mjs';
import { fetchFrameworkCatalogs } from '../scripts/fetch-framework-catalogs.mjs';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'refresh-isolation-tests');
mkdirSync(fixtures, { recursive: true });
after(() => rmdirSync(fixtures));
function setup(t) {
  const root = mkdtempSync(join(fixtures, 'run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), value); };
  const get = (path) => readFileSync(join(root, path), 'utf8');
  return { root, put, get };
}
const task = (id, remote = true) => ({ id, script: `${id}.mjs`, args: [], stages: ['acquire'], scope: [id], retries: 1, remote_fetch: remote, isolation: remote ? 'quarantinable' : 'fail_fast' });
const descriptor = (task) => [{ taskId: task.id, sourceId: task.id, script: task.script, args: [], paths: ['data/shared.json'], retries: task.retries }];
const gates = { validateCandidate: () => {}, finalize: () => {}, describeProjection: () => null };

test('failed subprocess reports the actual source diagnostic and has a finite deadline', () => {
  assert.throws(() => executeRefreshUnit({ script: 'example.mjs', args: [] }, '.', (_exe, _args, options) => {
    assert.equal(options.timeout, 900000);
    return { status: 1, stderr: 'HTTP 404: official publisher detail is missing' };
  }), /HTTP 404: official publisher detail is missing/);
});

test('every production remote task has explicit outputs and local isolation cannot quarantine', () => {
  assert.deepEqual(validateIngestionPipelineDefinition(), []);
  const remote = INGESTION_TASKS.filter((entry) => entry.remote_fetch);
  assert.equal(remote.length, 16);
  for (const entry of remote) assert.ok(sourceUnitsForTask(entry, { hydration: [{ id: 'artifact-example' }], resourceIds: ['repo-example'] }).every((unit) => unit.paths.length));
  const invalid = INGESTION_TASKS.map((entry) => entry.remote_fetch ? entry : { ...entry, isolation: 'quarantinable' });
  assert.match(validateIngestionPipelineDefinition(invalid).join(' '), /invalid isolation/);
  assert.throws(() => sourceUnitsForTask(task('unowned')), /no declared output/);
});

test('remote quarantine restores immediate shared state and allows the next source and local task', async (t) => {
  const { root, put, get } = setup(t);
  put('data/shared.json', 'original');
  const seen = [];
  const recorded = [];
  let finalized;
  const result = await runRefreshPipeline({ ...gates, root,
    tasks: [task('A'), task('B'), task('C'), task('local', false)], describeSources: descriptor,
    executor: (unit) => {
      if (unit.sourceId === 'C') assert.deepEqual(recorded, ['A', 'B']);
      seen.push(unit.sourceId);
      if (unit.sourceId === 'A') put('data/shared.json', 'accepted A');
      if (unit.sourceId === 'B') { put('data/shared.json', 'bad B'); throw new Error('offline'); }
      if (unit.sourceId === 'C') assert.equal(get('data/shared.json'), 'accepted A');
    }, recordResult: (result) => recorded.push(result.sourceId), finalize: (results) => { finalized = results; },
  });
  assert.deepEqual(seen, ['A', 'B', 'C', 'local']);
  assert.equal(result.status, 'complete_with_quarantine');
  assert.equal(result.results[1].status, 'quarantined');
  assert.equal(finalized.length, 3);
  const report = JSON.parse(get('.local/source-refresh-results.json'));
  assert.deepEqual(report.results[1].quarantinedPaths, ['data/shared.json']);
  assert.equal(report.results[1].error, 'offline');
});

test('framework catalogs execute as independent only units followed by one local projection', async (t) => {
  const { root, put } = setup(t);
  const framework = INGESTION_TASKS.find((entry) => entry.id === 'fetch-framework-catalogs');
  const units = sourceUnitsForTask(framework);
  for (const unit of units) for (const path of unit.paths) put(path, 'last-good');
  const seen = [];
  const result = await runRefreshPipeline({ ...gates, root, tasks: [framework],
    describeProjection: localProjectionForTask,
    executor: (unit) => {
      seen.push(unit.args);
      if (unit.sourceId === 'nist-csf-2') throw new Error('CSF unavailable');
    },
  });
  assert.equal(units.length, 8);
  const expectedCalls = units.flatMap((unit) => unit.sourceId === 'nist-csf-2' ? [unit.args, unit.args] : [unit.args]);
  assert.deepEqual(seen.slice(0, 9), expectedCalls);
  assert.deepEqual(seen[9], localProjectionForTask(framework).args);
  assert.deepEqual(units.at(-1).args, ['--public', 'fedramp-baselines']);
  assert.equal(result.results[0].status, 'partial');
});

test('unknown ownership fails before any task, manifest or source write', async (t) => {
  const { root } = setup(t);
  await assert.rejects(runRefreshPipeline({ ...gates, root,
    tasks: [task('local', false), task('unowned')], executor: () => assert.fail('must not execute'),
  }), /no declared output/);
  assert.equal(existsSync(join(root, 'data/ingestion-pipeline-manifest.json')), false);
});

test('local failure stops subsequent work and finalization without quarantine', async (t) => {
  const { root, get } = setup(t);
  const seen = [];
  await assert.rejects(runRefreshPipeline({ ...gates, root,
    tasks: [task('local', false), task('later', false)],
    executor: (unit) => { seen.push(unit.sourceId); throw new Error('local invariant'); },
    finalize: () => assert.fail('must not finalize'),
  }), /local invariant/);
  assert.deepEqual(seen, ['local']);
  const manifest = JSON.parse(get('data/ingestion-pipeline-manifest.json'));
  assert.equal(manifest.status, 'failed');
  assert.equal(manifest.failed_task, 'local');
});

test('candidate validation rolls back while finalization failure remains fail-fast', async (t) => {
  const { root, put, get } = setup(t);
  put('data/shared.json', 'last-good');
  await assert.rejects(runRefreshPipeline({ ...gates, root, tasks: [task('A')], describeSources: descriptor,
    executor: () => put('data/shared.json', 'invalid'),
    validateCandidate: () => { throw new Error('candidate mismatch'); },
    finalize: (results) => { assert.equal(results[0].status, 'quarantined'); throw new Error('final invariant'); },
  }), /final invariant/);
  assert.equal(get('data/shared.json'), 'last-good');
  assert.equal(JSON.parse(get('.local/source-refresh-results.json')).failed_task, 'candidate-finalization');
});

test('derived projections run after raw fetch and before candidate validation', async (t) => {
  const { root, put, get } = setup(t);
  const source = { ...INGESTION_TASKS.find((entry) => entry.id === 'fetch-nara-cui'), retries: 1 };
  const unit = sourceUnitsForTask(source)[0];
  for (const path of unit.paths) put(path, 'old');
  const seen = [];
  await runRefreshPipeline({ ...gates, root, tasks: [source], executor: (operation) => {
    if (operation.args[0] === '--public') {
      seen.push('projection');
      assert.equal(get('data/nara-cui-registry-manifest.json'), 'fresh raw');
      put('data/cui-policy.json', 'fresh normalized');
    } else {
      seen.push('raw');
      put('data/nara-cui-registry-manifest.json', 'fresh raw');
    }
  }, validateCandidate: () => {
    seen.push('validate');
    assert.equal(get('data/cui-policy.json'), 'fresh normalized');
  } });
  assert.deepEqual(seen, ['raw', 'projection', 'validate']);
  for (const id of ['fetch-zero-trust-workbooks', 'fetch-nist-zero-trust', 'fetch-nist-structured-catalogs']) {
    const derived = sourceUnitsForTask(INGESTION_TASKS.find((entry) => entry.id === id))[0];
    for (const catalog of derived.followUp.args.slice(1)) assert.ok(derived.paths.includes(`data/${catalog}.json`));
  }
});

test('failed projection restores raw and normalized outputs in the same transaction', async (t) => {
  const { root, put, get } = setup(t);
  const source = { ...INGESTION_TASKS.find((entry) => entry.id === 'fetch-nara-cui'), retries: 1 };
  const unit = sourceUnitsForTask(source)[0];
  for (const path of unit.paths) put(path, 'last-good');
  const result = await runRefreshPipeline({ ...gates, root, tasks: [source], executor: (operation) => {
    if (operation.args[0] === '--public') {
      put('data/cui-policy.json', 'partial projection');
      throw new Error('projection failed');
    }
    put('data/nara-cui-registry-manifest.json', 'fresh raw');
  }, validateCandidate: () => assert.fail('incomplete projection cannot validate') });
  assert.equal(result.sourceResults[0].status, 'quarantined');
  for (const path of unit.paths) assert.equal(get(path), 'last-good');
});

test('DoD projection follows extraction and initial projection excludes dynamic or remote catalogs', async (t) => {
  const { root } = setup(t);
  const source = INGESTION_TASKS.find((entry) => entry.id === 'extract-dod-zero-trust');
  const seen = [];
  await runRefreshPipeline({ ...gates, root, tasks: [source], describeProjection: localProjectionForTask,
    executor: (unit) => seen.push([unit.script, unit.args]),
  });
  assert.deepEqual(seen, [['extract-dod-zt.mjs', []], ['fetch-framework-catalogs.mjs', ['--public', 'dod-zt']]]);
  const initial = localProjectionForTask(INGESTION_TASKS.find((entry) => entry.id === 'fetch-framework-catalogs')).args;
  for (const id of ['dod-zt', 'cui-policy', 'nist-zt', 'microsoft-zt-maturity', 'nist-iot-cybersecurity', 'nist-mobile-threats', 'fedramp-baselines']) assert.ok(!initial.includes(id));
});

test('FedRAMP membership failure propagates before any public catalog write', async () => {
  await assert.rejects(fetchFrameworkCatalogs({
    onlyPublic: ['fedramp-baselines'],
    fetchFedrampMembership: () => { throw new Error('workbook unavailable'); },
    fetchImpl: () => assert.fail('no unrelated catalog request'),
    writeJson: () => assert.fail('failed membership cannot publish fallback'),
  }), /workbook unavailable/);
});
