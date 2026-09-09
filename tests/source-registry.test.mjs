import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { loadSourceRegistry, validateSourceRegistry } from '../tools/validators/source-registry.mjs';
import { assertPublisherVolume } from './helpers/publisher-volume.mjs';

const registry = JSON.parse(readFileSync('data/source-registry.json', 'utf8'));

test('source registry schema 5.0 validates the federal source contract', () => {
  const errors = validateSourceRegistry(registry);
  assert.deepEqual(errors, []);
  assert.equal(registry.schema_version, '5.0');
  assert.ok(Array.isArray(registry.publications));
  assert.ok(Array.isArray(registry.artifacts));
  assert.ok(Array.isArray(registry.catalog_source_bundles));
  assert.ok(registry.publications.every((pub) => pub.authority_class));
  assert.ok(registry.publications.every((pub) => pub.owner));
  assert.ok(registry.publications.every((pub) => pub.lifecycle_status));
  assert.ok(registry.publications.every((pub) => pub.access_status));
  assert.ok(registry.publications.every((pub) => pub.license_or_use));
});

test('DoDI 8510.01 is a canonical official publication rather than a Resource', () => {
  const publication = registry.publications.find(
    (entry) => entry.id === 'authority-dodi-8510-01',
  );
  assert.ok(publication);
  assert.equal(publication.display_name, 'DoDI 8510.01');
  assert.equal(publication.entity_kind, 'publication');
  assert.equal(publication.lifecycle_status, 'active');
  assert.equal(publication.version, 'July 19, 2022');
  assert.equal(
    publication.artifact_url,
    'https://www.esd.whs.mil/Portals/54/Documents/DD/issuances/dodi/851001p.pdf',
  );
  assert.equal(
    publication.catalog_browse_url,
    'https://www.esd.whs.mil/Directives/issuances/dodi/',
  );
});

test('artifact publishers inherit from their declared parent publication', () => {
  const { artifacts, byId } = loadSourceRegistry(registry);
  for (const artifact of artifacts) {
    const loaded = byId.get(artifact.id);
    const parent = byId.get(artifact.publication_source_id);
    assert.ok(parent, `${artifact.id} parent publication is unresolved`);
    assert.equal(loaded.owner, artifact.owner || parent.owner, artifact.id);
    assert.equal(
      loaded.metadata.owner_resolution,
      artifact.owner ? 'artifact' : 'parent_publication',
      artifact.id,
    );
    assert.notEqual(loaded.owner, 'Publisher not recorded', artifact.id);
  }
});

test('loaded sources expose additive freshness fields', () => {
  const { byId } = loadSourceRegistry(registry);
  assert.equal(byId.get('nist-oscal').sync_model, 'auto_synced');
  assert.equal(byId.get('nist-oscal').stale_after_days, 45);
  assert.equal(byId.get('community-cci-research').last_imported, null);
  assert.equal(byId.get('community-cci-research').hash, null);
});

test('missing verification dates stay missing instead of receiving a generated fallback', () => {
  const withoutDate = structuredClone(registry);
  const freshness = withoutDate.freshness.sources[0];
  delete freshness.last_checked;
  const loaded = loadSourceRegistry(withoutDate);
  assert.equal(loaded.byId.get(freshness.source_id).last_checked, null);
});

test('reviewed publication identity stays distinct from parser artifacts', () => {
  const { byId } = loadSourceRegistry(registry);

  const rai = byId.get('dod-rai-toolkit');
  assert.equal(rai.version, null);
  assert.equal(
    rai.catalog_browse_url,
    'https://www.ai.mil/Latest/Blog/Article-Display/Article/3940314/responsible-ai-toolkit/',
  );
  assert.equal(
    rai.artifact_url,
    'https://www.ai.mil/Latest/Blog/Article-Display/Article/3940314/responsible-ai-toolkit/',
  );
  assert.match(rai.metadata.version_unknown_reason, /do not expose a release version/);
  assert.match(rai.metadata.provenance_note, /official CDAO Responsible AI Toolkit article is canonical/);

  const derivedCatalog = registry.sources.find((entry) => entry.id === 'dod-rai-toolkit');
  assert.equal(derivedCatalog.provenance_class, 'control_atlas_derived');
  assert.match(derivedCatalog.metadata.provenance_note, /not verbatim publisher records/);

  assert.match(
    byId.get('artifact-ai-mil-responsible-ai').metadata.version_unknown_reason,
    /does not expose a release version/,
  );
  assert.match(
    byId.get('artifact-dod-rai-toolkit').metadata.version_unknown_reason,
    /does not expose a release version/,
  );
  assert.equal(byId.get('artifact-dod-rai-toolkit').source_role, 'reference_only');

  const d3fend = byId.get('mitre-d3fend-ontology');
  assert.equal(d3fend.version, '1.6.0');
  assert.equal(d3fend.catalog_browse_url, 'https://d3fend.mitre.org/');
  assert.equal(d3fend.artifact_url, 'https://d3fend.mitre.org/ontologies/d3fend.json');

  const assessment = byId.get('nist-800-53a-assessment-procedures');
  assert.equal(assessment.version, 'Revision 5, Release 5.2.0');
  assert.equal(assessment.catalog_browse_url, 'https://csrc.nist.gov/pubs/sp/800/53/a/r5/final');
  assert.match(assessment.artifact_url, /NIST_SP-800-53_rev5_catalog\.json$/);

  const iot = byId.get('nist-iot-device-cybersecurity-requirement-catalogs');
  assert.equal(iot.version, 'Spring 2021');
  assert.equal(iot.lifecycle_status, 'active');
  assert.equal(byId.get('nist-iot-requirements-80053-mapping-draft').lifecycle_status, 'draft');
  assert.equal(byId.get('nist-iot-requirements-csf11-mapping-draft').lifecycle_status, 'draft');

  assert.equal(
    byId.get('nist-800-53b-baselines').artifact_url,
    'https://github.com/usnistgov/oscal-content/tree/main/nist.gov/SP800-53/rev5',
  );
  assert.equal(byId.get('nist-800-53b-baselines').version, 'Revision 5, Release 5.2.0');
});

test('SP 800-171 and SP 800-172 publication identities stay distinct from source artifacts', () => {
  const publicationById = new Map(registry.publications.map((entry) => [entry.id, entry]));
  const artifactById = new Map(registry.artifacts.map((entry) => [entry.id, entry]));

  const rev2 = publicationById.get('nist-800-171-rev2');
  assert.equal(rev2.name, 'SP 800-171 Rev. 2');
  assert.equal(rev2.display_name, 'SP 800-171 Rev. 2');
  assert.equal(rev2.metadata.identity_kind, 'publication');
  assert.equal(rev2.profile_id, 'publication.publication');

  const rev3 = publicationById.get('nist-800-172-rev3');
  assert.equal(rev3.name, 'SP 800-172 Rev. 3');
  assert.equal(rev3.display_name, 'SP 800-172 Rev. 3');
  assert.equal(rev3.metadata.identity_kind, 'publication');
  assert.equal(rev3.profile_id, 'publication.publication');

  const mapping = publicationById.get('nist-800-171-oscal-mappings');
  assert.equal(mapping.name, 'NIST SP 800-171 Rev. 3 OSCAL Control References');
  assert.equal(mapping.display_name, 'SP 800-171 Rev. 3 OSCAL Control References');
  assert.equal(mapping.metadata.identity_kind, 'mapping');
  assert.equal(mapping.metadata.canonical_publication_id, 'nist-800-171');
  assert.equal(mapping.profile_id, 'publication.mapping');

  const expectedArtifacts = {
    'artifact-nist-800-171-rev2': {
      name: 'NIST SP 800-171 Rev. 2 Security Requirements CSV Artifact',
      publicationSourceId: 'nist-800-171-rev2',
      sourceRole: 'primary_data',
      format: 'csv',
      artifactUrl: 'https://csrc.nist.gov/files/pubs/sp/800/171/r2/upd1/final/docs/sp800-171r2-security-reqs.csv',
      parser: 'csv',
      catalogId: 'nist-800-171-rev2',
      catalogPath: 'data/requirements-800-171-rev2.json',
    },
    'artifact-nist-800-172-rev3': {
      name: 'NIST SP 800-172 Rev. 3 OSCAL Catalog Artifact',
      publicationSourceId: 'nist-800-172-rev3',
      sourceRole: 'primary_data',
      format: 'oscal_json',
      artifactUrl: 'https://raw.githubusercontent.com/usnistgov/oscal-content/v1.5.0/nist.gov/SP800-172/rev3/json/NIST_SP800-172_rev3_catalog.json',
      parser: 'oscal-json',
      catalogId: 'nist-800-172',
      catalogPath: 'data/requirements-800-172.json',
    },
    'artifact-nist-800-171-oscal-mappings': {
      name: 'NIST SP 800-171 Rev. 3 OSCAL Control References Artifact',
      publicationSourceId: 'nist-800-171-oscal-mappings',
      sourceRole: 'mapping',
      format: 'oscal_json',
      artifactUrl: 'https://raw.githubusercontent.com/usnistgov/oscal-content/v1.5.0/nist.gov/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json',
      parser: 'oscal-json',
      catalogId: 'nist-800-171',
      catalogPath: 'data/requirements-800-171.json',
    },
  };

  const hydration = new Map(JSON.parse(readFileSync('data/artifact-hydration-manifest.json', 'utf8')).results.map((entry) => [entry.id, entry]));
  for (const [id, expected] of Object.entries(expectedArtifacts)) {
    const artifact = artifactById.get(id);
    assert.ok(artifact, `${id} must remain registered`);
    assert.equal(artifact.name, expected.name, id);
    assert.equal(artifact.publication_source_id, expected.publicationSourceId, id);
    assert.equal(artifact.source_role, expected.sourceRole, id);
    assert.equal(artifact.format, expected.format, id);
    const actualUrl = new URL(artifact.artifact_url);
    const expectedUrl = new URL(expected.artifactUrl);
    assert.equal(actualUrl.origin, expectedUrl.origin, `${id}: publisher authority`);
    if (expectedUrl.hostname === 'raw.githubusercontent.com') {
      // Publisher release refs can advance; owner, repository and artifact path cannot drift.
      const actualPath = actualUrl.pathname.split('/');
      const expectedPath = expectedUrl.pathname.split('/');
      assert.ok(actualPath[3], `${id}: publisher repository ref is required`);
      actualPath[3] = expectedPath[3];
      assert.deepEqual(actualPath, expectedPath, `${id}: publisher artifact identity`);
    } else {
      assert.equal(actualUrl.href, expectedUrl.href, id);
    }
    assert.equal(artifact.parser, expected.parser, id);
    const observed = assertPublisherVolume(expected.catalogId, expected.catalogPath);
    const evidence = hydration.get(id);
    assert.equal(evidence?.status, 'OK', `${id}: retained hydration evidence is required`);
    assert.match(artifact.sha256, /^sha256:[a-f0-9]{64}$/, id);
    assert.ok(Number.isSafeInteger(artifact.byte_length) && artifact.byte_length > 0, id);
    assert.ok(Number.isSafeInteger(artifact.record_count) && artifact.record_count >= observed.record_count, id);
    assert.ok(Number.isSafeInteger(artifact.relationship_count) && artifact.relationship_count > 0, id);
    assert.equal(artifact.sha256, evidence.sha256, `${id}: registry and retrieval evidence agree`);
    assert.equal(artifact.byte_length, evidence.byte_length, id);
    assert.equal(artifact.record_count, evidence.record_count, id);
  }
});

test('source registry rejects invalid or incomplete freshness metadata', () => {
  const invalid = structuredClone(registry);
  invalid.freshness.sources[0].last_checked = '2026-02-30';
  invalid.freshness.sources[1].hash = 'sha256:placeholder';
  invalid.freshness.sources.find((entry) => entry.sync_model === 'link_out').last_imported = '2026-01-01';
  invalid.freshness.sources.pop();
  const errors = validateSourceRegistry(invalid);
  assert.ok(errors.some((error) => error.includes('last_checked')));
  assert.ok(errors.some((error) => error.includes('sha256 digest')));
  assert.ok(errors.some((error) => error.includes('link-out source')));
  assert.ok(errors.some((error) => error.includes('missing freshness entry')));
});

test('manual review records never fabricate content checksums', () => {
  const invalid = structuredClone(registry);
  const manual = invalid.sources.find(
    (source) => source.retrieval_method === 'manual_review',
  );
  manual.checksum = 'sha256:publication_identity_placeholder';
  const errors = validateSourceRegistry(invalid);
  assert.ok(
    errors.some(
      (error) =>
        error.includes(`manual-review source ${manual.id}`) &&
        error.includes('null or a sha256 digest'),
    ),
  );

  for (const source of registry.sources.filter(
    (entry) => entry.retrieval_method === 'manual_review',
  )) {
    assert.ok(
      source.checksum === null || /^sha256:[a-f0-9]{64}$/.test(source.checksum),
      `${source.id} has a fabricated checksum`,
    );
  }
});

test('source provenance and eligibility remain separate', () => {
  const { sources } = loadSourceRegistry(registry);
  assert.ok(sources.length >= 35);
  assert.ok(!sources.some((source) => source.provenance_class === 'inferred'));
  assert.ok(!sources.some((source) => source.provenance_class === 'excluded'));
  assert.ok(sources.some((source) => source.eligibility_status === 'excluded'));
});

test('ingestion sources cannot publish records as publication identities', () => {
  const { byId } = loadSourceRegistry(registry);
  for (const id of ['nist-oscal', 'nist-ssdf-oscal']) {
    assert.equal(byId.get(id).metadata.identity_kind, 'ingestion');
    assert.equal(byId.get(id).graph_eligible, false);
  }
  for (const id of ['nist-800-53', 'nist-800-171', 'nist-csf-2', 'nist-ssdf']) {
    assert.equal(byId.get(id).metadata.identity_kind, 'publication');
    assert.equal(byId.get(id).graph_eligible, true);
  }
});

test('required federal sources are registered', () => {
  const ids = new Set(registry.sources.map((source) => source.id));
  for (const id of [
    'nist-csf-53-supplemental',
    'nist-csf11-csf20-crosswalk',
    'nist-800-171-oscal-mappings',
    'disa-cci-nist-references',
    'nist-800-53b-baselines',
    'nist-fips-199',
    'nist-fips-200',
    'nist-800-37-rev2',
    'nist-800-53a-assessment-procedures',
    'nist-800-171-rev2',
    'nist-800-172-rev3',
    'isoo-cui-regulation',
    'nara-cui-registry',
    'disa-stig-library',
    'disa-srg-library',
    'disa-stig-srg-cci-references',
    'cyber-mil-stig-compilations',
    'cyber-mil-stig-downloads',
    'cyber-mil-stig-gpo',
    'stigviewer-catalog',
    'stigviewer-clkb-api',
    'nuwcdivnpt-github-org',
    'nuwcdivnpt-stig-manager',
    'fedramp-2026-rules',
    'fedramp-rev5',
  ]) {
    assert.ok(ids.has(id), `missing source ${id}`);
  }
});

test('official DISA sources record source-tier precedence metadata', () => {
  const { byId } = loadSourceRegistry(registry);
  for (const id of ['disa-stig-library', 'disa-srg-library', 'disa-stig-srg-cci-references']) {
    const source = byId.get(id);
    assert.equal(source.metadata.source_authority.tier, 'gold');
    assert.equal(source.metadata.source_authority.resolved_from, 'gold');
    assert.ok(Array.isArray(source.metadata.source_authority.fallbacks));
  }
});

test('supplemental STIG acquisition sources record non-gold fallback tiers', () => {
  const { byId } = loadSourceRegistry(registry);
  assert.equal(byId.get('stigviewer-catalog').metadata.source_authority.tier, 'silver');
  assert.equal(byId.get('stigviewer-clkb-api').metadata.source_authority.tier, 'silver');
  assert.equal(byId.get('nuwcdivnpt-stig-manager').metadata.source_authority.tier, 'silver');
});

test('release 2 sources keep revision boundaries and avoid a draft-only bridge source', () => {
  const { sources } = loadSourceRegistry(registry);
  const ids = new Set(sources.map((source) => source.id));
  assert.ok(ids.has('nist-800-171-rev2'));
  assert.ok(ids.has('nist-800-171-oscal-mappings'));
  assert.ok(ids.has('nist-800-172-rev3'));
  assert.ok(!ids.has('nist-800-171-rev2-rev3-bridge'));
});

test('registry rejects inferred or excluded as source provenance classes', () => {
  const invalid = structuredClone(registry);
  invalid.sources[0].provenance_class = 'inferred';
  invalid.sources[1].provenance_class = 'excluded';
  const errors = validateSourceRegistry(invalid);
  assert.ok(errors.some((error) => error.includes('unsupported provenance_class: inferred')));
  assert.ok(errors.some((error) => error.includes('unsupported provenance_class: excluded')));
});

test('excluded sources cannot publish graph records', () => {
  const invalid = structuredClone(registry);
  invalid.sources[0].eligibility_status = 'excluded';
  invalid.sources[0].graph_eligible = true;
  const errors = validateSourceRegistry(invalid);
  assert.ok(errors.some((error) => error.includes('excluded source') && error.includes('graph_eligible')));
});

test('restricted, limited, and excluded sources still require full provenance metadata', () => {
  const invalid = structuredClone(registry);
  invalid.sources[0].eligibility_status = 'limited';
  invalid.sources[0].access_status = 'restricted';
  invalid.sources[0].license_or_use = '';
  invalid.sources[0].lifecycle_status = 'deprecated';
  const errors = validateSourceRegistry(invalid);
  assert.ok(errors.some((error) => error.includes('missing required field: license_or_use')));
});

test('current, historical, mapping, and immutable source roles remain explicit', () => {
  const current = registry.publications.find((entry) => entry.id === 'fedramp-2026-rules');
  const historical = registry.publications.find((entry) => entry.id === 'fedramp-rev5');
  assert.equal(current.lifecycle_status, 'active');
  assert.equal(historical.lifecycle_status, 'historical');
  const iot = registry.catalog_source_bundles.find((entry) => entry.catalog_id === 'nist-iot-cybersecurity');
  assert.deepEqual(iot.primary_artifact_ids, []);
  assert.equal(iot.mapping_source_ids.length, 2);
  assert.equal(iot.expected_inventory.primary_extraction_status, 'not_performed');
  const d3fend = registry.artifacts.find((entry) => entry.id === 'artifact-mitre-d3fend-ontology');
  assert.equal(d3fend.version, '1.6.0');
  assert.match(d3fend.sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(d3fend.metadata.immutable_capture_path, 'data/d3fend-countermeasures.json');
});
