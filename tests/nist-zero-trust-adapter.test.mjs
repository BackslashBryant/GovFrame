import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parseSp800207A, parseSp800207Core } from '../tools/importers/nist-zero-trust-adapter.mjs';
import { buildNistZeroTrustCatalog } from '../tools/importers/framework-adapters.mjs';
import { assertPublisherVolume } from './helpers/publisher-volume.mjs';

const manifest = JSON.parse(readFileSync('data/curated/nist-zt/nist-source-manifest.json', 'utf8'));
const builds = JSON.parse(readFileSync('data/curated/nist-zt/sp1800-35-builds.json', 'utf8')).records;
const mappings = JSON.parse(readFileSync('data/curated/nist-zt/mappings.json', 'utf8')).records;

test('SP 800-207 parser extracts the seven tenets and eleven logical components from located lines', () => {
  const fragments = JSON.parse(readFileSync('data/curated/nist-zt/source-fragments/sp800-207.json', 'utf8'));
  const parsed = parseSp800207Core(fragments);
  assert.equal(parsed.tenets.length, 7);
  assert.equal(parsed.components.length, 11);
  assert.equal(parsed.components.filter((entry) => entry.component_class === 'core').length, 3);
  assert.ok([...parsed.tenets, ...parsed.components].every((entry) => entry.source_fragments.length > 0));
});

test('SP 800-207A parser extracts every labeled cloud-native zero trust requirement', () => {
  const fragments = JSON.parse(readFileSync('data/curated/nist-zt/source-fragments/sp800-207a.json', 'utf8'));
  const parsed = parseSp800207A(fragments);
  assert.equal(parsed.requirements.length, 11);
  assert.deepEqual(parsed.requirements.map((entry) => entry.id), [
    'ID-SEG-REC-1', 'ID-SEG-REC-2', 'ID-SEG-REC-3', 'ID-SEG-REC-4', 'ID-SEG-REC-5',
    'MON-CNA-REQ-1', 'MON-CNA-REQ-2', 'MON-CNA-REQ-3', 'MON-CNA-REQ-4',
    'MON-DATA-USE-1', 'MON-DATA-USE-2',
  ]);
  assert.ok(parsed.requirements.every((entry) => entry.source_fragments.length > 0));
});

test('NIST SP 1800-35 corpus reconciles discovered builds and both page types', () => {
  const pages = manifest.sources.filter((source) => /^SP180035-/.test(source.source_key));
  assert.ok(builds.length > 0);
  assert.equal(new Set(builds.map((build) => build.id)).size, builds.length);
  assert.equal(new Set(pages.map((page) => page.source_key)).size, pages.length);
  assert.equal(manifest.reconciliation.sp1800_35_builds_discovered, builds.length);
  assert.equal(manifest.reconciliation.sp800_207a_requirements, 11);
  assert.equal(manifest.reconciliation.sp1800_35_builds_ingested, builds.length);
  assert.equal(manifest.reconciliation.sp1800_35_architecture_pages, pages.filter((page) => page.role === 'architecture').length);
  assert.equal(manifest.reconciliation.sp1800_35_implementation_guides, pages.filter((page) => page.role === 'implementation_guide').length);
  assert.equal(manifest.reconciliation.failed_pages, 0);
  assert.equal(manifest.reconciliation.synthetic_records, 0);
  assert.match(manifest.repository.commit, /^[a-f0-9]{40}$/);
  assert.deepEqual(pages.map((page) => page.source_key).sort(), builds.flatMap((build) =>
    ['architecture', 'implementation_guide'].map((role) => `${build.id}-${role}`)).sort());
  assert.ok(manifest.sources.filter((source) => /^SP180035-/.test(source.source_key))
    .every((source) => source.artifact_url.includes(`/${manifest.repository.commit}/`)));
  // This compares retained ingestion evidence; original discovery HTML is not
  // retained, so it does not claim independent raw publisher enumeration.
  for (const build of builds) {
    assert.equal(build.id, `SP180035-${build.code}`);
    assert.deepEqual(build.source_pages.map((page) => page.role).sort(), ['architecture', 'implementation_guide']);
    for (const page of build.source_pages) {
      const source = pages.find((entry) => entry.source_key === `${build.id}-${page.role}`);
      for (const field of ['url', 'artifact_url', 'sha256', 'byte_length', 'sections']) assert.equal(page[field], source[field]);
      assert.equal(page.sections, (page.role === 'architecture' ? build.architecture_sections : build.implementation_sections).length);
    }
  }
  assert.ok(builds.every((build) => build.architecture_sections.length > 0 && build.implementation_sections.length > 0));
  assert.deepEqual(builds.find((build) => build.code === 'E1B3').related_build_codes, ['E1B2']);
  assert.ok(builds.every((build) => build.source_pages.every((page) => /^sha256:[a-f0-9]{64}$/.test(page.sha256) && page.artifact_url.includes(`/${manifest.repository.commit}/`))));
});

test('NIST SP 1800-35 keeps the official collaborator roster distinct from mapping-workbook labels', () => {
  const catalog = buildNistZeroTrustCatalog('2026-08-13', 'data/curated/nist-zt');
  assertPublisherVolume('nist-zt', 'data/nist-zt.json', catalog.records.length);
  const roster = catalog.records.filter((record) => record.type === 'zt_collaborator');
  const mappingContributors = catalog.records.filter((record) => record.type === 'zt_mapping_contributor');
  assert.equal(roster.length, 24);
  assert.deepEqual(roster.map((record) => record.title), [
    'Appgate', 'IBM', 'PC Matic', 'AWS', 'Ivanti', 'Ping Identity', 'Broadcom', 'Lookout',
    'Radiant Logic', 'Cisco', 'Mandiant', 'SailPoint', 'DigiCert', 'Microsoft', 'Tenable', 'F5',
    'Okta', 'Trellix', 'Forescout', 'Omnissa', 'Zimperium', 'Google Cloud', 'Palo Alto Networks', 'Zscaler',
  ]);
  assert.deepEqual(mappingContributors.map((record) => record.title).sort(),
    [...new Set(mappings.map((mapping) => mapping.collaborator).filter(Boolean))].sort());
  assert.ok(mappingContributors.every((record) => record.metadata.publisher_field === 'Collaborator'));
  assert.ok(catalog.records.filter((record) => record.type === 'zt_product_component')
    .every((record) => mappingContributors.some((contributor) => contributor.id === record.metadata.parent_id)));
});
