#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, 'data', 'source-registry.json');
const CURATED = join(ROOT, 'data', 'curated', 'nist-zt');
const STRUCTURED_CURATED = join(ROOT, 'data', 'curated', 'nist-structured-catalogs');
const DOD_CURATED = join(ROOT, 'data', 'curated', 'dod-zt');
const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
const nistManifest = JSON.parse(readFileSync(join(CURATED, 'nist-source-manifest.json'), 'utf8'));
const workbookManifest = JSON.parse(readFileSync(join(CURATED, 'structured-source-manifest.json'), 'utf8'));
const structuredManifest = JSON.parse(readFileSync(join(STRUCTURED_CURATED, 'source-manifest.json'), 'utf8'));
const dodManifest = JSON.parse(readFileSync(join(DOD_CURATED, 'source-manifest.json'), 'utf8'));
const dodOverlayMap = JSON.parse(readFileSync(join(ROOT, 'maps', '800-53-to-dod-zt-overlays.json'), 'utf8'));

function upsert(list, record, key = 'id') {
  const index = list.findIndex((entry) => entry[key] === record[key]);
  if (index >= 0) {
    const existing = list[index];
    // `metadata` is a nested object, so a plain spread replaces it wholesale and
    // silently drops every key this sync does not itself set -- including
    // metadata.identity_kind, which the registry validator requires on every
    // publication, and metadata.canonical_publication_id, which supplemental and
    // mapping identities require. Merge one level deeper so this sync only
    // overwrites the fields it actually manages.
    const metadata = existing.metadata || record.metadata
      ? { metadata: { ...(existing.metadata || {}), ...(record.metadata || {}) } }
      : {};
    list[index] = { ...existing, ...record, ...metadata };
  } else list.push(record);
}

function publication({ id, name, displayName, group, owner, provenance = 'federal_published', authority = 'publisher', version, versionUnknownReason = null, retrievedAt, method, url, frameworks, parser, license = 'NIST Public Access and Copyright Notice', lifecycle = 'active', mandateBasis = null, metadata = {} }) {
  return {
    id, name, display_name: displayName, display_group: group, owner,
    authority_class: authority, provenance_class: provenance,
    // Only assert a mandate basis when this sync actually knows one. Emitting a
    // hardcoded [] made every run erase curated values it does not manage --
    // the DoD Zero Trust Strategy citation on dod-zt-strategy was being wiped
    // on each refresh. Omitting the key lets the upsert merge leave it alone,
    // while a genuinely new publication still gets an explicit empty list.
    ...(mandateBasis ? { mandate_basis: mandateBasis } : {}),
    license_or_use: license, lifecycle_status: lifecycle, eligibility_status: 'eligible', access_status: 'public',
    version, retrieved_at: retrievedAt, retrieval_method: method, artifact_url: url, catalog_browse_url: url,
    federal_referenced_by: [], graph_eligible: true,
    metadata: { frameworks, parser, ...(versionUnknownReason ? { version_unknown_reason: versionUnknownReason } : {}), ...metadata },
  };
}

function artifact({ id, publicationSourceId, name, role, authority = 'publisher', format, version, versionUnknownReason = null, retrievedAt, method, url, bytes, sha256, parser, count, relationships = 0, license = 'NIST Public Access and Copyright Notice', lifecycle = 'active' }) {
  return {
    id, publication_source_id: publicationSourceId, name, display_name: name, source_role: role,
    authority_class: authority, format, version, lifecycle_status: lifecycle, retrieval_method: method,
    retrieved_at: retrievedAt, artifact_url: url, byte_length: bytes, sha256, parser, parser_version: '1.0.0',
    record_count: count, relationship_count: relationships, license_or_use: license,
    ...(versionUnknownReason ? { metadata: { version_unknown_reason: versionUnknownReason } } : {}),
  };
}

const sp800207 = nistManifest.sources.find((entry) => entry.source_key === 'nist-sp-800-207');
const sp800207A = nistManifest.sources.find((entry) => entry.source_key === 'nist-sp-800-207a');
const sp180035 = nistManifest.sources.find((entry) => entry.source_key === 'nist-sp-1800-35');
const microsoft = workbookManifest.sources.find((entry) => entry.source_key === 'microsoft-zero-trust-maturity-questionnaire-v1-1');
const mappingWorkbooks = workbookManifest.sources.filter((entry) => entry.mapping_kind);
const structuredSource = (key) => structuredManifest.sources.find((entry) => entry.source_key === key);
const iot80053 = structuredSource('nist-iot-requirements-80053-mapping-draft');
const iotCsf = structuredSource('nist-iot-requirements-csf11-mapping-draft');
const mtcJson = structuredSource('nist-mobile-threat-catalogue');
const mtcCsv = structuredSource('nist-mobile-threat-catalogue-cve-list');
const sp180035Pages = nistManifest.sources.filter((entry) => /^SP180035-/.test(entry.source_key));
const dodDocument = (key) => {
  const document = dodManifest.documents.find((entry) => entry.source_key === key);
  if (!document) throw new Error(`Missing DoD Zero Trust source manifest entry: ${key}`);
  return document;
};
const DOD_LICENSE = 'Official DoD CIO public release';
const dodSources = [
  {
    key: 'dod-zt-reference-architecture-v2', name: 'DoD Zero Trust Reference Architecture Version 2.0',
    displayName: 'DoD Zero Trust Reference Architecture', version: '2.0 (July 2022)', role: 'primary_data',
    records: 13, relationships: 0,
  },
  {
    key: 'dod-zt-strategy', name: 'DoD Zero Trust Strategy', displayName: 'DoD Zero Trust Strategy',
    version: 'October 21, 2022', role: 'primary_data', records: 1, relationships: 0,
  },
  {
    key: 'dod-zt-capabilities', name: 'DoD Zero Trust Capabilities and Activities',
    displayName: 'DoD Zero Trust Capabilities and Activities', version: null,
    versionUnknownReason: 'The publisher PDF does not state a release version.',
    url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-CapabilitiesActivities.pdf',
    role: 'primary_data', records: 198, relationships: 0,
  },
  {
    key: 'dod-zt-execution-roadmap', name: 'DoD Zero Trust Capability Execution Roadmap v1.1',
    displayName: 'DoD Zero Trust Execution Roadmap', version: '1.1 (November 22, 2024)',
    role: 'primary_data', records: 1, relationships: 0,
  },
  {
    key: 'dod-zt-overlays-2024', name: 'DoD Zero Trust Overlays', displayName: 'DoD Zero Trust Overlays',
    version: '1.0 (February 2024)', role: 'mapping', records: 1,
    relationships: dodOverlayMap.relationships.length, lifecycle: 'historical',
    metadata: {
      retirement_reason: 'The previously published artifact URL now returns HTTP 404 and is no longer listed by DoD CIO.',
      successor_not_identified: true,
    },
  },
  {
    key: 'dod-zt-operational-technology', name: 'Zero Trust for Operational Technology Activities and Outcomes',
    displayName: 'DoD Zero Trust for Operational Technology', version: 'Version 2',
    role: 'primary_data', records: 106, relationships: 0,
  },
  {
    key: 'dod-zt-newsletter-2024-11', name: 'DoD Zero Trust PfMO Newsletter — November 2024',
    displayName: 'DoD Zero Trust Newsletter', version: 'November 2024',
    role: 'enrichment', records: 0, relationships: 0,
  },
  {
    key: 'dod-zt-strategy-placemats', name: 'DoD Zero Trust Strategy Placemats',
    displayName: 'DoD Zero Trust Strategy Placemats', version: null,
    versionUnknownReason: 'The publisher placemat PDF does not state a release version.',
    role: 'enrichment', records: 0, relationships: 0,
  },
].map((entry) => ({ ...entry, document: dodDocument(entry.key) }));

function sp180035PageArtifactId(entry) {
  const match = entry.source_key.match(/^SP180035-(.+)-(architecture|implementation_guide)$/);
  if (!match) throw new Error(`Unexpected SP 1800-35 source key: ${entry.source_key}`);
  const [, buildCode, role] = match;
  return `artifact-nist-sp-1800-35-${buildCode.toLowerCase()}-${role === 'implementation_guide' ? 'guide' : role}`;
}

const publications = [
  publication({ id: 'nist-sp-800-207', name: 'NIST SP 800-207 Zero Trust Architecture', displayName: 'NIST Zero Trust Architecture', group: 'NIST', owner: 'NIST', version: 'August 2020', retrievedAt: sp800207.retrieved_at.slice(0, 10), method: 'extracted_from_official_publication', url: sp800207.url, frameworks: ['nist-zt'], parser: 'pdfplumber-located-lines' }),
  publication({ id: 'nist-sp-800-207a', name: 'NIST SP 800-207A Zero Trust Access Control for Cloud-Native Applications', displayName: 'NIST Zero Trust Cloud-Native Access Control', group: 'NIST', owner: 'NIST', version: 'September 2023', retrievedAt: sp800207A.retrieved_at.slice(0, 10), method: 'extracted_from_official_publication', url: sp800207A.url, frameworks: ['nist-zt'], parser: 'pdfplumber-located-lines' }),
  publication({ id: 'nist-sp-1800-35', name: 'NIST SP 1800-35 Implementing a Zero Trust Architecture', displayName: 'NIST Zero Trust Implementations', group: 'NIST', owner: 'NIST NCCoE', version: 'June 2025', retrievedAt: sp180035.retrieved_at.slice(0, 10), method: 'extracted_from_official_publication', url: sp180035.url, frameworks: ['nist-zt'], parser: 'explicit-html-markup' }),
  publication({ id: microsoft.source_key, name: 'Microsoft Zero Trust Maturity Questionnaire v1.1', displayName: 'Microsoft Zero Trust Maturity Questionnaire', group: 'Microsoft', owner: 'Microsoft', provenance: 'third_party_published', authority: 'validated_third_party', version: '1.1', retrievedAt: microsoft.retrieved_at.slice(0, 10), method: 'official_structured_export', url: microsoft.url, frameworks: ['microsoft-zt-maturity'], parser: 'zero-trust-questionnaire-xlsx', license: 'Microsoft Download Center terms' }),
  ...mappingWorkbooks.map((entry) => publication({ id: entry.source_key, name: `NIST SP 1800-35 ${entry.url.split('/').at(-1)}`, displayName: 'NIST SP 1800-35 Mapping Workbook', group: 'NIST', owner: 'NIST NCCoE', authority: 'publisher_supplement', version: 'June 2025', retrievedAt: entry.retrieved_at.slice(0, 10), method: 'official_structured_export', url: entry.url, frameworks: ['nist-zt'], parser: 'nist-zero-trust-mapping-xlsx' })),
  publication({ id: 'nist-iot-device-cybersecurity-requirement-catalogs', name: 'NIST IoT Device Cybersecurity Requirement Catalogs', displayName: 'NIST IoT Device Cybersecurity', group: 'NIST', owner: 'NIST', version: 'Spring 2021', retrievedAt: iot80053.retrieved_at.slice(0, 10), method: 'official_structured_export', url: 'https://pages.nist.gov/IoT-Device-Cybersecurity-Requirement-Catalogs/', frameworks: ['nist-iot-cybersecurity'], parser: 'nist-iot-requirement-xlsx', lifecycle: 'active' }),
  publication({ id: iot80053.source_key, name: 'NIST IoT Requirement Catalog to SP 800-53 Mapping', displayName: 'NIST IoT to SP 800-53 Workbook', group: 'NIST', owner: 'NIST', authority: 'publisher_supplement', version: 'Draft', retrievedAt: iot80053.retrieved_at.slice(0, 10), method: 'official_structured_export', url: iot80053.url, frameworks: ['nist-iot-cybersecurity'], parser: 'nist-iot-requirement-xlsx', lifecycle: 'draft' }),
  publication({ id: iotCsf.source_key, name: 'NIST IoT Requirement Catalog to CSF 1.1 Mapping', displayName: 'NIST IoT to CSF 1.1 Workbook', group: 'NIST', owner: 'NIST', authority: 'publisher_supplement', version: 'Draft', retrievedAt: iotCsf.retrieved_at.slice(0, 10), method: 'official_structured_export', url: iotCsf.url, frameworks: ['nist-iot-cybersecurity'], parser: 'nist-iot-requirement-xlsx', lifecycle: 'draft' }),
  publication({ id: 'nist-mobile-threat-catalogue', name: 'NIST Mobile Threat Catalogue', displayName: 'NIST Mobile Threat Catalogue', group: 'NIST', owner: 'NIST', version: 'Current published data', retrievedAt: mtcJson.retrieved_at.slice(0, 10), method: 'official_structured_export', url: mtcJson.url, frameworks: ['nist-mobile-threats'], parser: 'nist-mobile-threat-json' }),
  publication({ id: mtcCsv.source_key, name: 'NIST Mobile Threat Catalogue CVE List', displayName: 'NIST Mobile Threat CVE List', group: 'NIST', owner: 'NIST', authority: 'publisher_supplement', version: 'Current published data', retrievedAt: mtcCsv.retrieved_at.slice(0, 10), method: 'official_structured_export', url: mtcCsv.url, frameworks: ['nist-mobile-threats'], parser: 'nist-mobile-threat-cve-csv' }),
  ...dodSources.map((entry) => publication({
    id: entry.key,
    name: entry.name,
    displayName: entry.displayName,
    group: 'DoD CIO',
    owner: 'Department of Defense Chief Information Officer',
    version: entry.version,
    versionUnknownReason: entry.versionUnknownReason,
    retrievedAt: entry.document.retrieved_at,
    method: 'extracted_from_official_publication',
    url: entry.url || entry.document.source_url,
    frameworks: ['dod-zt'],
    parser: 'pdfplumber-located-lines',
    license: DOD_LICENSE,
    lifecycle: entry.lifecycle || 'active',
    metadata: entry.metadata || {},
  })),
];
for (const record of publications) upsert(registry.publications, record);

const artifacts = [
  artifact({ id: 'artifact-nist-sp-800-207', publicationSourceId: 'nist-sp-800-207', name: 'NIST SP 800-207 PDF', role: 'primary_data', format: 'pdf', version: 'August 2020', retrievedAt: sp800207.retrieved_at.slice(0, 10), method: 'extracted_from_official_publication', url: sp800207.url, bytes: sp800207.byte_length, sha256: sp800207.sha256, parser: 'pdfplumber-located-lines', count: 19 }),
  artifact({ id: 'artifact-nist-sp-800-207a', publicationSourceId: 'nist-sp-800-207a', name: 'NIST SP 800-207A PDF', role: 'primary_data', format: 'pdf', version: 'September 2023', retrievedAt: sp800207A.retrieved_at.slice(0, 10), method: 'extracted_from_official_publication', url: sp800207A.url, bytes: sp800207A.byte_length, sha256: sp800207A.sha256, parser: 'pdfplumber-located-lines', count: 12 }),
  artifact({ id: 'artifact-nist-sp-1800-35', publicationSourceId: 'nist-sp-1800-35', name: 'NIST SP 1800-35 Root Page', role: 'primary_data', format: 'html', version: 'June 2025', retrievedAt: sp180035.retrieved_at.slice(0, 10), method: 'repository_snapshot', url: sp180035.artifact_url || sp180035.url, bytes: sp180035.byte_length, sha256: sp180035.sha256, parser: 'explicit-html-markup', count: 1 }),
  ...sp180035Pages.map((entry) => artifact({
    id: sp180035PageArtifactId(entry),
    publicationSourceId: 'nist-sp-1800-35',
    name: `NIST SP 1800-35 ${entry.source_key.replace(/^SP180035-/, '').replace(/-/g, ' ')}`,
    role: 'enrichment',
    format: 'html',
    version: 'June 2025',
    retrievedAt: entry.retrieved_at.slice(0, 10),
    method: 'repository_snapshot',
    url: entry.artifact_url || entry.url,
    bytes: entry.byte_length,
    sha256: entry.sha256,
    parser: 'explicit-html-markup',
    count: entry.sections,
  })),
  artifact({ id: `artifact-${microsoft.source_key}`, publicationSourceId: microsoft.source_key, name: 'Microsoft Zero Trust Maturity Questionnaire v1.1 Workbook', role: 'primary_data', authority: 'validated_third_party', format: 'spreadsheet', version: '1.1', retrievedAt: microsoft.retrieved_at.slice(0, 10), method: 'official_structured_export', url: microsoft.url, bytes: microsoft.byte_length, sha256: microsoft.sha256, parser: 'zero-trust-questionnaire-xlsx', count: microsoft.parsed_records, license: 'Microsoft Download Center terms' }),
  ...mappingWorkbooks.map((entry) => artifact({ id: `artifact-${entry.source_key}`, publicationSourceId: entry.source_key, name: `NIST SP 1800-35 ${entry.url.split('/').at(-1)}`, role: 'mapping', format: 'spreadsheet', version: 'June 2025', retrievedAt: entry.retrieved_at.slice(0, 10), method: 'official_structured_export', url: entry.url, bytes: entry.byte_length, sha256: entry.sha256, parser: 'nist-zero-trust-mapping-xlsx', count: entry.parsed_records, relationships: entry.parsed_records })),
  artifact({ id: `artifact-${iot80053.source_key}`, publicationSourceId: iot80053.source_key, name: 'NIST IoT Requirements to SP 800-53 Workbook', role: 'mapping', format: 'spreadsheet', version: 'Draft', retrievedAt: iot80053.retrieved_at.slice(0, 10), method: 'official_structured_export', url: iot80053.url, bytes: iot80053.byte_length, sha256: iot80053.sha256, parser: 'nist-iot-requirement-xlsx', count: structuredManifest.reconciliation.iot.records, relationships: structuredManifest.reconciliation.iot.graph_eligible_80053_relationships, lifecycle: 'draft' }),
  artifact({ id: `artifact-${iotCsf.source_key}`, publicationSourceId: iotCsf.source_key, name: 'NIST IoT Requirements to CSF 1.1 Workbook', role: 'mapping', format: 'spreadsheet', version: 'Draft', retrievedAt: iotCsf.retrieved_at.slice(0, 10), method: 'official_structured_export', url: iotCsf.url, bytes: iotCsf.byte_length, sha256: iotCsf.sha256, parser: 'nist-iot-requirement-xlsx', count: structuredManifest.reconciliation.iot.records, lifecycle: 'draft' }),
  artifact({ id: `artifact-${mtcJson.source_key}`, publicationSourceId: 'nist-mobile-threat-catalogue', name: 'NIST Mobile Threat Catalogue JSON', role: 'primary_data', format: 'json', version: 'Current published data', retrievedAt: mtcJson.retrieved_at.slice(0, 10), method: 'official_structured_export', url: mtcJson.url, bytes: mtcJson.byte_length, sha256: mtcJson.sha256, parser: 'nist-mobile-threat-json', count: structuredManifest.reconciliation.mobile_threats.total_records }),
  artifact({ id: `artifact-${mtcCsv.source_key}`, publicationSourceId: mtcCsv.source_key, name: 'NIST Mobile Threat Catalogue CVE CSV', role: 'enrichment', format: 'csv', version: 'Current published data', retrievedAt: mtcCsv.retrieved_at.slice(0, 10), method: 'official_structured_export', url: mtcCsv.url, bytes: mtcCsv.byte_length, sha256: mtcCsv.sha256, parser: 'nist-mobile-threat-cve-csv', count: structuredManifest.reconciliation.mobile_threats.unique_cves_reconciled }),
  ...dodSources.map((entry) => artifact({
    id: `artifact-${entry.key}`,
    publicationSourceId: entry.key,
    name: entry.name,
    role: entry.role,
    format: 'pdf',
    version: entry.version,
    versionUnknownReason: entry.versionUnknownReason,
    retrievedAt: entry.document.retrieved_at,
    method: 'extracted_from_official_publication',
    url: entry.url || entry.document.source_url,
    bytes: entry.document.byte_length,
    sha256: entry.document.checksum,
    parser: 'pdfplumber-located-lines',
    count: entry.records,
    relationships: entry.relationships,
    license: DOD_LICENSE,
    lifecycle: entry.lifecycle || 'active',
  })),
];
for (const record of artifacts) upsert(registry.artifacts, record);

upsert(registry.catalog_source_bundles, {
  catalog_id: 'nist-zt', publication_source_id: 'nist-sp-800-207',
  primary_artifact_ids: ['artifact-nist-sp-800-207', 'artifact-nist-sp-800-207a', 'artifact-nist-sp-1800-35'],
  enrichment_artifact_ids: sp180035Pages.map(sp180035PageArtifactId), mapping_source_ids: mappingWorkbooks.map((entry) => `artifact-${entry.source_key}`),
  assessment_source_ids: [], automation_source_ids: [], reconciliation_source_ids: [],
}, 'catalog_id');
upsert(registry.catalog_source_bundles, {
  catalog_id: 'nist-iot-cybersecurity', publication_source_id: 'nist-iot-device-cybersecurity-requirement-catalogs',
  primary_artifact_ids: [], enrichment_artifact_ids: [], mapping_source_ids: [`artifact-${iot80053.source_key}`, `artifact-${iotCsf.source_key}`],
  assessment_source_ids: [], automation_source_ids: [], reconciliation_source_ids: [],
  expected_inventory: {
    basis: 'Unique NIST IoT catalog records normalized from the two publisher mapping workbooks and reconciled by exact record path. The catalog page supplies publication identity; the draft workbooks supply mapping data.',
    evidence_class: 'publisher_mapping_inventory',
    primary_extraction_status: 'not_performed',
    evidence_locator: 'data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.iot.records',
    imported_evidence_locator: 'data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.iot.records',
    exclusions: [],
  },
}, 'catalog_id');
upsert(registry.catalog_source_bundles, {
  catalog_id: 'nist-mobile-threats', publication_source_id: 'nist-mobile-threat-catalogue',
  primary_artifact_ids: [`artifact-${mtcJson.source_key}`], enrichment_artifact_ids: [`artifact-${mtcCsv.source_key}`], mapping_source_ids: [],
  assessment_source_ids: [], automation_source_ids: [], reconciliation_source_ids: [],
  expected_inventory: {
    basis: 'All nonblank threat records plus explicit threat categories from the official JSON; CVE identifiers reconcile exactly to the official CSV.',
    evidence_locator: 'data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.mobile_threats.expected_records',
    imported_evidence_locator: 'data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.mobile_threats.total_records',
    exclusions: [{ count: 7, reason: 'Seven publisher JSON entries contain no threat ID, category, title, or content.' }],
  },
}, 'catalog_id');
upsert(registry.catalog_source_bundles, {
  catalog_id: 'microsoft-zt-maturity', publication_source_id: microsoft.source_key,
  primary_artifact_ids: [`artifact-${microsoft.source_key}`], enrichment_artifact_ids: [], mapping_source_ids: [],
  assessment_source_ids: [], automation_source_ids: [], reconciliation_source_ids: [],
  expected_inventory: {
    basis: 'Questions parsed from the six numbered worksheets in the publisher workbook.',
    evidence_locator: 'data/curated/nist-zt/structured-source-manifest.json#reconciliation.questionnaire_records',
    imported_evidence_locator: 'data/curated/nist-zt/structured-source-manifest.json#reconciliation.questionnaire_records',
    exclusions: [],
  },
}, 'catalog_id');
upsert(registry.catalog_source_bundles, {
  catalog_id: 'dod-zt',
  publication_source_id: 'dod-zt-reference-architecture-v2',
  primary_artifact_ids: dodSources.filter((entry) => entry.role === 'primary_data').map((entry) => `artifact-${entry.key}`),
  enrichment_artifact_ids: dodSources.filter((entry) => entry.role === 'enrichment').map((entry) => `artifact-${entry.key}`),
  mapping_source_ids: dodSources.filter((entry) => entry.role === 'mapping').map((entry) => `artifact-${entry.key}`),
  assessment_source_ids: [], automation_source_ids: [], reconciliation_source_ids: [],
  expected_inventory: {
    basis: 'Six official DoD Zero Trust publications produce Atlas records; the newsletter and placemats are supporting Resources. All eight PDFs and 636 pages are extraction-accounted.',
    evidence_locator: 'data/curated/dod-zt/source-manifest.json#reconciliation.atlas_records_expected',
    imported_evidence_locator: 'data/dod-zt.json#record_count',
    exclusions: [],
  },
}, 'catalog_id');

registry.quarantine = (registry.quarantine || []).filter((entry) => entry.id !== 'artifact-dod-zt-overlays-2024');

registry.publications.sort((a, b) => a.id.localeCompare(b.id));
registry.artifacts.sort((a, b) => a.id.localeCompare(b.id));
registry.catalog_source_bundles.sort((a, b) => a.catalog_id.localeCompare(b.catalog_id));
writeJsonAtomically(REGISTRY_PATH, registry);
console.log(`Registered ${publications.length} structured sources, ${artifacts.length} artifacts, and 5 catalogs.`);
