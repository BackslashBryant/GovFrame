import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { planAlertChanges, reportRefreshAlerts } from '../tools/report-refresh-alerts.mjs';

const run = 'https://github.com/RAMBULLS/control-atlas/actions/runs/123';
const failure = { sourceId: 'nist-catalog', status: 'quarantined', attempts: 2, error: 'HTTP 503' };
const marker = '<!-- control-atlas-refresh:nist-catalog -->\n';
const issue = { number: 12, state: 'open', title: 'Old title', body: `${marker}Prior failure` };

test('a quarantined source creates one alert and repeated identical failures are idempotent', () => {
  const [change] = planAlertChanges([failure, failure], [], run);
  assert.equal(change.type, 'create');
  assert.match(change.payload.body, /HTTP 503/);
  assert.match(change.payload.body, /Attempts: 2/);
  const existing = { ...change.payload, number: 12, state: 'open' };
  assert.deepEqual(planAlertChanges([failure], [existing], run), []);
  assert.deepEqual(planAlertChanges([failure], [existing], run.replace('123', '456')), []);
  assert.equal(planAlertChanges([{ ...failure, error: 'HTTP 404' }], [existing], run.replace('123', '456')).length, 1);
});

test('recurring quarantine updates or reopens the same issue and consolidates duplicate generated alerts', () => {
  const changes = planAlertChanges([failure], [{ ...issue, number: 30 }, { ...issue, state: 'closed' }], run);
  assert.equal(changes.length, 2);
  assert.equal(changes[0].number, 12);
  assert.equal(changes[0].payload.state, 'open');
  assert.equal(changes[1].number, 30);
  assert.equal(changes[1].payload.state, 'closed');
});

test('accepted recovery closes only matching generated open issues', () => {
  const changes = planAlertChanges([{ sourceId: failure.sourceId, status: 'accepted' }], [
    issue, { ...issue, number: 13, state: 'closed' },
    { ...issue, number: 14, body: 'Human issue discussing source failure' },
    { ...issue, number: 15, pull_request: {} },
    { ...issue, number: 16, body: '<!-- control-atlas-refresh:other-source -->\nFailure' },
  ], run);
  assert.equal(changes.length, 1);
  assert.equal(changes[0].number, 12);
  assert.equal(changes[0].payload.state_reason, 'completed');
});

test('unknown, absent and untouched source outcomes never close an issue', () => {
  for (const results of [undefined, null, [], [{ sourceId: failure.sourceId, status: 'running' }],
    [{ sourceId: 'other-source', status: 'accepted' }]]) {
    assert.deepEqual(planAlertChanges(results, [issue], run), []);
  }
});

test('malformed identities and conflicting source outcomes fail closed', () => {
  assert.throws(() => planAlertChanges([{ ...failure, sourceId: 'evil\n<!-- marker -->' }]), /Invalid refresh source ID/);
  assert.throws(() => planAlertChanges([failure, { ...failure, status: 'accepted' }]), /Conflicting source results/);
  assert.throws(() => planAlertChanges([failure], [], 'https://attacker.test/run'), /Invalid GitHub Actions run URL/);
});

test('issue diagnostics escape Markdown, suppress mentions, and redact recognizable credential values', () => {
  const [change] = planAlertChanges([{ ...failure,
    error: '<script> @someone [click](https://bad.test) ghp_exampleToken Authorization: Bearer sensitive',
  }]);
  assert.ok(change.payload.body.includes('&lt;script&gt;'));
  assert.ok(change.payload.body.includes('\\[click\\]'));
  assert.ok(!change.payload.body.includes('@someone'));
  assert.ok(!change.payload.body.includes('exampleToken'));
  assert.ok(!change.payload.body.includes('sensitive'));
  assert.equal(change.payload.title, 'Source refresh quarantined: nist-catalog');
});

test('reporter paginates issue reads and sends JSON on stdin without invoking a shell', () => {
  const directory = mkdtempSync(join(process.cwd(), '.refresh-alert-test-'));
  const reportPath = join(directory, 'results.json');
  try {
    writeFileSync(reportPath, JSON.stringify({ schema_version: '1.0', results: [failure] }));
    const calls = [];
    const changes = reportRefreshAlerts({ reportPath, repository: 'RAMBULLS/control-atlas', runUrl: run,
      execFileImpl: (command, args, options) => {
        calls.push({ command, args, options });
        return calls.length === 1 ? JSON.stringify([[], [issue]]) : '{}';
      },
    });
    assert.equal(changes[0].type, 'update');
    assert.equal(calls.length, 2);
    assert.ok(calls[0].args.includes('--paginate'));
    assert.ok(calls[0].args.includes('--slurp'));
    assert.ok(calls[1].args.includes('PATCH'));
    assert.deepEqual(calls[1].args.slice(-2), ['--input', '-']);
    assert.equal(JSON.parse(calls[1].options.input).state, 'open');
    assert.equal(calls[1].options.shell, undefined);
    assert.throws(() => reportRefreshAlerts({ reportPath, repository: 'RAMBULLS/control-atlas', runUrl: run,
      execFileImpl: () => { throw new Error('API unavailable'); },
    }), /API unavailable/);
    assert.deepEqual(reportRefreshAlerts({ reportPath: join(directory, 'absent.json'),
      execFileImpl: () => { throw new Error('Must not contact GitHub'); },
    }), []);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
