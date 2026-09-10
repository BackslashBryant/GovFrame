import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { assertOfficialSourceUrl } from '../scripts/lib/source-url-policy.mjs';
import { fetchRangeWithCurl } from '../scripts/fetch-disa-stigs.mjs';
import { check } from '../scripts/check-commons-health.mjs';

test('Commons health reports denied destinations as unreachable without opening a connection', async () => {
  const result = await check({ id: 'unapproved', canonicalUrl: 'https://www.stigviewer.com/stigs' });
  assert.equal(result.ok, false);
  assert.equal(result.outcome, 'network_error');
  assert.match(result.note, /source URL policy/);
});

test('DISA curl denies unapproved URLs before spawning and enforces HTTPS with no redirects', async () => {
  let calls = 0;
  await assert.rejects(fetchRangeWithCurl('https://attacker.test/file.zip', 0, 2, 'unused', {
    execFileImpl: async () => { calls += 1; },
  }), /source URL policy/);
  assert.equal(calls, 0);
  const directory = mkdtempSync(join(process.cwd(), '.egress-test-'));
  const url = 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/test.zip';
  try {
    const bytes = await fetchRangeWithCurl(url, 0, 2, join(directory, 'fixture'), {
      execFileImpl: async (command, args) => {
        assert.equal(command, 'curl.exe');
        assert.equal(args[0], '--disable');
        assert.equal(args.includes('--location'), false);
        assert.equal(args[args.indexOf('--proto') + 1], '=https');
        assert.equal(args[args.indexOf('--max-redirs') + 1], '0');
        writeFileSync(args[args.indexOf('--output') + 1], 'zip');
        return { stdout: `206\n${url}` };
      },
    });
    assert.equal(bytes.toString(), 'zip');
    for (const stdout of [`302\n${url}`, '206\nhttps://attacker.test/file.zip']) {
      await assert.rejects(fetchRangeWithCurl(url, 0, 2, join(directory, 'fixture'), {
        execFileImpl: async () => ({ stdout }),
      }), /DISA curl rejected/);
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('source policy permits inventoried publishers and precise upstream repository endpoints', () => {
  for (const url of [
    'https://csrc.nist.gov/files/catalog.xlsx',
    'https://rai.acqbot.com/executive-summary',
    'https://api.github.com/repos/ansible-lockdown/.github/readme',
    'https://api.github.com/repos/oscal-compass/compliance-trestle',
    'https://api.github.com/repos/apache/caldera',
    'https://download.microsoft.com/download/Zero%20Trust.xlsx',
    'https://api.github.com/repos/NUWCDIVNPT/stig-manager',
    'https://api.github.com/repos/mitre/saf/commits/main',
    'https://api.github.com/repos/usnistgov/zero-trust-architecture/branches/main',
    'https://api.github.com/repos/cisagov/cset/readme?ref=123',
    'https://api.github.com/repos/cisagov/cset/releases/latest',
    'https://raw.githubusercontent.com/FedRAMP/rules/main/schemas/example.json',
    'https://github.com/usnistgov/oscal-content/blob/main/nist.gov/catalog.json',
  ]) assert.equal(assertOfficialSourceUrl(url).href, url);
});

test('source policy rejects non-publishers, unsafe transport and ambiguous paths', () => {
  for (const url of [
    'http://csrc.nist.gov/files/catalog.xlsx',
    'https://csrc.nist.gov:8443/files/catalog.xlsx',
    'https://user:password@csrc.nist.gov/',
    'https://csrc.nist.gov.attacker.test/',
    'https://csrc.nist.gov./',
    'https://attacker.test/?url=https://csrc.nist.gov',
    'https://www.stigviewer.com/stigs',
    'https://github.com/',
    'https://github.com/NUWCDIVNPT',
    'https://github.com/evil/oscal-content',
    'https://github.com/usnistgov/unapproved',
    'https://api.github.com/repos/usnistgov/oscal-content/issues',
    'https://api.github.com/repos/usnistgov/oscal-content/hooks',
    'https://github.com/usnistgov/oscal-content/settings',
    'https://github.com/usnistgov/oscal-content%2fattacker',
    'https://github.com/usnistgov/oscal-content/%2e%2e/unapproved',
    'https://github.com/usnistgov/oscal-content/%252e%252e/unapproved',
    'https://github.com/usnistgov%5coscal-content/',
    'https://github.com/usnistgov\\oscal-content/',
    'https://api.github.com/repositories/12345',
    'https://rai.acqbot.com/assessment/standard/intake',
    'https://api.github.com/repos/apache/unapproved',
    'https://raw.githubusercontent.com/usnistgov/unapproved/main/data.json',
  ]) assert.throws(() => assertOfficialSourceUrl(url), /source URL policy/, url);
});
