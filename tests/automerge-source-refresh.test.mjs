import assert from 'node:assert/strict';
import test from 'node:test';
import { assertCompletePullFileInventory, assertRefreshPaths, refreshMergeDecision, mergeWhenReady } from '../tools/automerge-source-refresh.mjs';

const repository = 'RAMBULLS/control-atlas';
const pr = { state: 'open', draft: false, user: { login: 'control-atlas-source-refresh[bot]' },
  head: { ref: 'automation/source-refresh', sha: 'a'.repeat(40), repo: { full_name: repository } },
  base: { ref: 'main', repo: { full_name: repository } }, mergeable: true, mergeable_state: 'clean' };
const runs = ['ci', 'security'].map((name, index) => ({ id: index + 1,
  path: `.github/workflows/${name}.yml`, head_sha: pr.head.sha, event: 'pull_request', status: 'completed', conclusion: 'success' }));

test('only exact App PR with independent current-SHA CI and Security may merge', () => {
  assert.equal(refreshMergeDecision(pr, ['data/ccis.json'], runs).ready, true);
  for (const mutation of [{ head_sha: 'b'.repeat(40) }, { event: 'workflow_dispatch' }, { conclusion: 'action_required' }, { status: 'in_progress' }]) {
    assert.equal(refreshMergeDecision(pr, ['data/ccis.json'], [runs[0], { ...runs[1], ...mutation }]).ready, false);
  }
  assert.equal(refreshMergeDecision(pr, ['data/ccis.json'], [...runs, { ...runs[0], id: 99, conclusion: 'failure' }]).ready, false);
  assert.equal(refreshMergeDecision({ ...pr, mergeable_state: 'blocked' }, ['data/ccis.json'], runs).ready, false);
});

test('untrusted PR authors, branches, forks and code paths cannot reach merge', () => {
  for (const mutation of [{ user: { login: 'github-actions[bot]' } }, { base: { ...pr.base, ref: 'other' } },
    { head: { ...pr.head, repo: { full_name: 'someone/control-atlas' } } }]) {
    assert.throws(() => refreshMergeDecision({ ...pr, ...mutation }, ['data/ccis.json'], runs), /identity/);
  }
  for (const path of ['src/app.ts', '.github/workflows/ci.yml', 'data/source-refresh-policy.json',
    'data/source-refresh-contract.json', 'data/schemas/source-baselines.schema.json', 'data/generated/nodes.json', 'data/../evil.json']) {
    assert.throws(() => assertRefreshPaths([path]), /protected/);
  }
});

test('paginated file inventory tolerates unavailable REST counts but rejects positive mismatches', () => {
  const paths = ['data/ccis.json', 'maps/cci-to-800-53.json'];
  assert.doesNotThrow(() => assertCompletePullFileInventory({ changed_files: 0 }, paths));
  assert.doesNotThrow(() => assertCompletePullFileInventory({ changed_files: 2 }, paths));
  assert.throws(
    () => assertCompletePullFileInventory({ changed_files: 3 }, paths),
    /Incomplete PR file inventory/,
  );
});

test('unresolved GitHub mergeability is retried, but failed gates and conflicts are never bypassed', async () => {
  const pending = refreshMergeDecision({ ...pr, mergeable: null, mergeable_state: 'unknown' }, ['data/ccis.json'], runs);
  let calls = 0;
  const waits = [];
  const result = await mergeWhenReady(() => ++calls < 3 ? pending : { merged: true }, async (ms) => waits.push(ms));
  assert.equal(result.merged, true);
  assert.deepEqual(waits, [10000, 10000]);
  for (const blocked of [refreshMergeDecision({ ...pr, mergeable_state: 'dirty' }, ['data/ccis.json'], runs),
    refreshMergeDecision(pr, ['data/ccis.json'], [])]) {
    assert.deepEqual(await mergeWhenReady(() => blocked, () => { throw new Error('must not retry a failed gate'); }), blocked);
  }
  calls = 0;
  await assert.rejects(mergeWhenReady(() => { calls++; return pending; }, async () => {}), /six checks/);
  assert.equal(calls, 6);
});
