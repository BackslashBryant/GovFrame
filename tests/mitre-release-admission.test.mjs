import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { assertAttackCollectionVersion, fetchMitreData, resolveAttackRelease, resolveD3fendVersion,
  validateMitreReleaseAdmission } from '../scripts/fetch-mitre-data.mjs';
import { observeCatalog } from '../scripts/lib/source-baseline.mjs';

const api = 'https://api.github.com/repos/mitre-attack/attack-stix-data';
const sha = 'a'.repeat(40);
const response = (payload) => new Response(JSON.stringify(payload));
const release = { tag_name: 'v20.0', draft: false, prerelease: false,
  html_url: 'https://github.com/mitre-attack/attack-stix-data/releases/tag/v20.0' };
const commit = { sha, url: `${api}/commits/${sha}` };

test('official latest release resolves its tag to an immutable commit and both versioned domains', async () => {
  const requests = [];
  const result = await resolveAttackRelease(async (url) => {
    requests.push(url);
    return response(requests.length === 1 ? release : commit);
  });
  assert.deepEqual(requests, [`${api}/releases/latest`, `${api}/commits/v20.0`]);
  assert.equal(result.version, '20.0');
  assert.equal(result.commit, sha);
  assert.equal(result.enterpriseAttack, `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${sha}/enterprise-attack/enterprise-attack-20.0.json`);
  assert.equal(result.icsAttack, `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${sha}/ics-attack/ics-attack-20.0.json`);
});

test('missing, draft, prerelease and off-repository release metadata cannot label new bytes', async () => {
  for (const payload of [{}, { ...release, draft: true }, { ...release, prerelease: true },
    { ...release, tag_name: '../main' }, { ...release, html_url: 'https://github.com/attacker/repo/releases/tag/v20.0' }]) {
    await assert.rejects(resolveAttackRelease(async () => response(payload)), /publisher release metadata/);
  }
  for (const payload of [{ sha: 'main' }, { ...commit, url: 'https://api.github.com/repos/attacker/repo/commits/main' }]) {
    await assert.rejects(resolveAttackRelease(async (url) => response(url.endsWith('/latest') ? release : payload)), /publisher commit metadata/);
  }
});

test('required fresh MITRE refresh fails when release metadata is unavailable', async () => {
  await assert.rejects(fetchMitreData({ requireFresh: true, fetchImpl: async () => new Response('', { status: 503 }) }), /Fetch failed \(503\)/);
});

test('ATT&CK collection and D3FEND endpoint versions must be present and truthful', () => {
  assert.doesNotThrow(() => assertAttackCollectionVersion({ objects: [{ type: 'x-mitre-collection', x_mitre_version: '20.0' }] }, '20.0'));
  for (const payload of [{}, { objects: [] }, { objects: [{ type: 'x-mitre-collection', x_mitre_version: '19.2' }] }]) {
    assert.throws(() => assertAttackCollectionVersion(payload, '20.0'), /publisher collection version/);
  }
  assert.equal(resolveD3fendVersion({ ontology_version: '1.7.0' }), '1.7.0');
  for (const value of [null, '', 1.7, 'latest']) assert.throws(() => resolveD3fendVersion({ ontology_version: value }), /publisher version/);
});

const hash = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
function catalogFixture(domain = 'enterprise', legacy = false) {
  const version = domain === 'd3fend' ? '1.7.0' : '20.0';
  const url = domain === 'd3fend' ? 'https://d3fend.mitre.org/ontologies/d3fend.json'
    : `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${sha}/${domain}-attack/${domain}-attack-${version}.json`;
  const document = { source_artifact: url, source_version: version, checksum: hash('publisher'),
    checksum_basis: legacy ? 'canonical_json' : 'raw_bytes', source_artifact_byte_length: 9,
    records: [{ id: 'T0001' }],
  };
  if (!legacy) document.publisher_inventory = { source_url: url, source_sha256: document.checksum,
    source_byte_length: 9, publisher_version: version, raw_count: 1, eligible_count: 1, imported_count: 1,
    excluded: [], raw_identity_sha256: hash(JSON.stringify(['T0001'])),
    imported_identity_sha256: hash(JSON.stringify(['T0001'])),
  };
  const bytes = Buffer.from(JSON.stringify(document));
  return { domain, document, bytes, accepted: observeCatalog(bytes), source: {
    owner: 'MITRE', provenance_class: 'mitre_published', artifact_url: url, version, checksum: document.checksum,
  } };
}

test('new publisher releases pass when registry, inventory and accepted baseline agree', () => {
  for (const domain of ['enterprise', 'ics', 'd3fend']) assert.deepEqual(validateMitreReleaseAdmission(catalogFixture(domain)), []);
});

test('legacy accepted snapshots pass only at their exact recorded normalized hash', () => {
  const fixture = catalogFixture('d3fend', true);
  fixture.accepted.publisher_version = null;
  assert.deepEqual(validateMitreReleaseAdmission(fixture), []);
  fixture.bytes = Buffer.from(`${fixture.bytes.toString()} `);
  assert.match(validateMitreReleaseAdmission(fixture).join(';'), /accepted baseline/);
});

test('registry relabeling, mutable or foreign sources and inconsistent publisher inventories fail admission', () => {
  for (const mutate of [
    (f) => { f.source.version = '19.2'; },
    (f) => { f.source.owner = 'Impostor'; },
    (f) => { f.document.source_artifact = f.document.source_artifact.replace(sha, 'master'); },
    (f) => { f.document.source_artifact = f.document.source_artifact.replace('mitre-attack/', 'attacker/'); },
    (f) => { f.document.publisher_inventory.publisher_version = '19.2'; },
    (f) => { f.document.publisher_inventory.source_sha256 = hash('different'); },
  ]) {
    const fixture = catalogFixture();
    mutate(fixture);
    assert.ok(validateMitreReleaseAdmission(fixture).length > 0);
  }
  const d3fend = catalogFixture('d3fend');
  d3fend.document.publisher_inventory.publisher_version = '1.6.0';
  assert.match(validateMitreReleaseAdmission(d3fend).join(';'), /publisher inventory/);
});
