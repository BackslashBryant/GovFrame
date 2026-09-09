import assert from 'node:assert/strict';
import test from 'node:test';
import { validateRecovery } from '../tools/recover-refresh-pr.mjs';

const sha = 'a'.repeat(40);
function proof() {
  return {
    expectedSha: sha, commit: { sha, parents: [{ sha: 'b'.repeat(40) }] },
    run: { head_branch: 'main', head_sha: 'b'.repeat(40), path: '.github/workflows/ci.yml', event: 'workflow_dispatch', status: 'completed' },
    jobs: [{ name: 'Weekly validated data refresh', steps: ['Refresh validated build-time data', 'Verify refreshed repository', 'Run npm run sbom:generate'].map((name) => ({ name, conclusion: 'success' })) }],
    paths: ['data/source-registry.json', 'maps/olir/1.json'],
    log: `job\tRun peter-evans/create-pull-request@pin\ttime [command]/usr/bin/git rev-parse automation/source-refresh\njob\tRun peter-evans/create-pull-request@pin\ttime ${sha}`,
  };
}
test('validated snapshot can be recovered after PR creation fails', () => assert.deepEqual(validateRecovery(proof()), []));
test('recovery rejects changed snapshots, missing gates, arbitrary logs and code changes', () => {
  const mutations = [
    (p) => { p.commit.sha = 'c'.repeat(40); },
    (p) => { p.commit.parents[0].sha = 'c'.repeat(40); },
    (p) => { p.jobs[0].steps[1].conclusion = 'failure'; },
    (p) => { p.jobs[0].steps.pop(); },
    (p) => { p.paths.push('scripts/refresh-data.mjs'); },
    (p) => { p.paths.push('data/generated/untracked.json'); },
    (p) => { p.paths = []; },
    (p) => { p.log = sha; },
    (p) => { p.run.head_branch = 'untrusted'; },
    (p) => { p.run.path = '.github/workflows/other.yml'; },
  ];
  for (const mutate of mutations) {
    const candidate = proof();
    mutate(candidate);
    assert.ok(validateRecovery(candidate).length, mutate.toString());
  }
});
