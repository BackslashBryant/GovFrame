import assert from 'node:assert/strict';
import test from 'node:test';
import { assertRefreshPaths, refreshMergeDecision } from '../tools/automerge-source-refresh.mjs';

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
