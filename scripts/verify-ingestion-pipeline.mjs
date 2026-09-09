#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readGeneratedCollection } from './lib/generated-graph-artifacts.mjs';
import { INGESTION_STAGES, validateIngestionPipelineDefinition } from './lib/ingestion-pipeline.mjs';
import { validateDataTrustContracts, validateRecordPresentation } from './build-framework-data.mjs';
import { DATA_TRUST_CONTRACT_VERSION } from '../src/shared/data-trust-contracts.mjs';
import { catalogStructureProfile } from '../src/shared/catalog-structure.mjs';
import { preserveGeneratedAt } from './lib/stable-generated-at.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/generated/ingestion-stage-ledger.json');
const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
const registry = readJson('data/source-registry.json');
const hydration = readJson('data/artifact-hydration-manifest.json');
const naraManifest = readJson('data/nara-cui-registry-manifest.json');
const countLedger = readJson('data/generated/source-count-ledger.json');
const nodesRaw = readGeneratedCollection(ROOT, 'nodes');
const edgesRaw = readGeneratedCollection(ROOT, 'edges');
const nodes = Array.isArray(nodesRaw) ? nodesRaw : nodesRaw.nodes;
const edges = Array.isArray(edgesRaw) ? edgesRaw : edgesRaw.edges;
const errors = [...validateIngestionPipelineDefinition()];
const registeredArtifactIds = new Set((registry.artifacts || []).map((artifact) => artifact.id));
const registeredReferenceIds = new Set([
  ...(registry.publications || []).map((entry) => entry.id),
  ...(registry.sources || []).map((entry) => entry.id),
  ...registeredArtifactIds,
]);

const complete = (evidence) => ({ status: 'complete', evidence });
const notApplicable = (reason) => ({ status: 'not_applicable', reason });
const failed = (reason) => ({ status: 'failed', reason });
const attested = new Map((hydration.results || []).filter((entry) => entry.status === 'OK').map((entry) => [entry.id, entry]));
if (naraManifest?.list_page?.sha256) {
  attested.set('artifact-nara-cui-registry', {
    id: 'artifact-nara-cui-registry',
    status: 'OK',
    sha256: `sha256:${naraManifest.list_page.sha256.replace(/^sha256:/, '')}`,
    evidence: 'data/nara-cui-registry-manifest.json',
  });
}
const artifactCounts = new Map((countLedger.artifacts || []).map((entry) => [entry.artifact_id, entry]));
const catalogCounts = new Map((countLedger.catalogs || []).map((entry) => [entry.catalog_id, entry]));
const bundleMembership = new Map();
for (const bundle of registry.catalog_source_bundles || []) {
  for (const field of ['primary_artifact_ids', 'enrichment_artifact_ids', 'mapping_source_ids', 'assessment_source_ids', 'automation_source_ids', 'reconciliation_source_ids']) {
    for (const artifactId of bundle[field] || []) {
      const memberships = bundleMembership.get(artifactId) || [];
      memberships.push({ catalog_id: bundle.catalog_id, role: field });
      bundleMembership.set(artifactId, memberships);
    }
  }
}

let presentationFailure = null;
try {
  validateRecordPresentation(nodes);
} catch (error) {
  presentationFailure = String(error.message || error);
  errors.push(presentationFailure);
}

const dataTrustFailures = validateDataTrustContracts(nodes, edges);
errors.push(...dataTrustFailures);
const dataTrustCounts = {
  source_record_envelopes: nodes.filter((node) => node.metadata?.source_locator && node.metadata?.item_id).length,
  publisher_structure_memberships: edges.filter((edge) => edge.relationship_class === 'structural').length,
  source_fragments: nodes.reduce((count, node) => count + (node.metadata?.source_fragments?.length || 0), 0),
};

const artifactEntries = (registry.artifacts || []).map((artifact) => {
  const counts = artifactCounts.get(artifact.id)?.counts;
  const execution = attested.get(artifact.id);
  const memberships = bundleMembership.get(artifact.id) || [];
  const hasRuntimeRecords = (counts?.runtime_node_citations || 0) > 0;
  const hasRuntimeRelationships = (counts?.runtime_edge_citations || 0) > 0;
  const primaryWithMissingRuntime = artifact.source_role === 'primary_data'
    && artifact.record_count > 0
    && !hasRuntimeRecords;
  const stages = {
    discover: memberships.length && artifact.artifact_url
      ? complete(`source-registry.json artifact and ${memberships.length} catalog bundle membership(s)`)
      : (artifact.metadata?.pipeline_scope && artifact.metadata?.pipeline_scope_reason
        ? notApplicable(`${artifact.metadata.pipeline_scope}: ${artifact.metadata.pipeline_scope_reason}`)
        : failed('artifact is not discoverable through a catalog bundle and evidence URL')),
    acquire: execution?.sha256 === artifact.sha256
      ? complete('data/artifact-hydration-manifest.json exact checksum attestation')
      : failed('no matching acquisition attestation'),
    attest: artifact.sha256 && artifact.byte_length > 0 && artifact.retrieved_at
      ? complete('checksum, byte length, and retrieval date recorded')
      : failed('artifact evidence fields are incomplete'),
    parse: artifact.parser
      ? complete(`${artifact.parser}@${artifact.parser_version}`)
      : failed('parser identity missing'),
    normalize: hasRuntimeRecords
      ? complete(`${counts.runtime_node_citations} runtime node citation(s)`)
      : (primaryWithMissingRuntime ? failed('parsed primary records produced no runtime nodes') : notApplicable(`${artifact.source_role} artifact produces no standalone catalog records`)),
    structure: hasRuntimeRecords
      ? complete('generated nodes passed publisher structure validation')
      : notApplicable('artifact produces no standalone structural records'),
    relationships: hasRuntimeRelationships
      ? complete(`${counts.runtime_edge_citations} runtime edge citation(s)`)
      : (artifact.relationship_count > 0 ? failed('published relationships produced no runtime edges') : notApplicable('publisher artifact declares no relationships')),
    presentation: hasRuntimeRecords
      ? (presentationFailure ? failed('record presentation validation failed') : complete('record type profile and required source fields validated'))
      : notApplicable('artifact produces no standalone record page'),
    reconcile: counts
      ? complete('data/generated/source-count-ledger.json separates source and runtime counts')
      : failed('source count ledger entry missing'),
    publish: (hasRuntimeRecords || hasRuntimeRelationships)
      ? complete('artifact contributes to generated public runtime data')
      : notApplicable(`${artifact.source_role} evidence is retained without a standalone catalog object`),
  };
  for (const [stage, result] of Object.entries(stages)) {
    if (result.status === 'failed') errors.push(`${artifact.id} ${stage}: ${result.reason}`);
  }
  return {
    artifact_id: artifact.id,
    publication_source_id: artifact.publication_source_id,
    format: artifact.format,
    parser: artifact.parser,
    catalog_memberships: memberships,
    stages,
  };
});

const catalogEntries = (registry.catalog_source_bundles || []).map((bundle) => {
  const profile = catalogStructureProfile(bundle.catalog_id);
  const counts = catalogCounts.get(bundle.catalog_id)?.counts;
  const sourceIds = [
    ...(bundle.primary_artifact_ids || []), ...(bundle.enrichment_artifact_ids || []),
    ...(bundle.mapping_source_ids || []), ...(bundle.assessment_source_ids || []),
    ...(bundle.automation_source_ids || []), ...(bundle.reconciliation_source_ids || []),
  ];
  const artifactIds = sourceIds.filter((id) => registeredArtifactIds.has(id));
  const unresolvedIds = sourceIds.filter((id) => !registeredReferenceIds.has(id));
  const stages = {
    discover: bundle.expected_inventory?.evidence_locator ? complete(bundle.expected_inventory.evidence_locator) : failed('independent expected inventory locator missing'),
    acquire: artifactIds.length && artifactIds.every((id) => attested.get(id)?.status === 'OK')
      ? complete(`${artifactIds.length} acquired artifact(s) attested; reference-only sources do not require local acquisition`)
      : failed('one or more acquired artifacts lack acquisition attestation'),
    attest: sourceIds.length && !unresolvedIds.length
      ? complete('catalog source bundle resolves to registered artifacts and reference sources')
      : failed(unresolvedIds.length ? `unresolved source reference(s): ${unresolvedIds.join(', ')}` : 'catalog source bundle contains no sources'),
    parse: artifactIds.length ? complete('source-specific adapters recorded on bundled artifacts') : failed('no source adapters'),
    normalize: Number.isInteger(counts?.normalized_records) ? complete(`${counts.normalized_records} normalized record(s)`) : failed('normalized record count missing'),
    structure: profile ? complete(`${profile.paths.length} publisher-native path contract(s)`) : failed('CatalogStructureProfile missing'),
    relationships: Number.isInteger(counts?.graph_edges_incident) ? complete(`${counts.graph_edges_incident} incident graph edge(s)`) : failed('graph relationship count missing'),
    presentation: presentationFailure
      ? failed('record presentation validation failed')
      : complete('every generated record page has an approved presentation profile; semantic navigation groups are explicitly non-record pages'),
    reconcile: Number.isInteger(counts?.discovered_expected_records) && Number.isInteger(counts?.normalized_records)
      ? complete('discovered and normalized counts recorded separately')
      : failed('discovered or normalized count is unresolved'),
    publish: existsSync(join(ROOT, `data/generated/catalog-records/${bundle.catalog_id}.json`))
      ? complete('generated catalog browsing payload exists')
      : failed('generated catalog browsing payload missing'),
  };
  for (const [stage, result] of Object.entries(stages)) {
    if (result.status === 'failed') errors.push(`${bundle.catalog_id} ${stage}: ${result.reason}`);
  }
  return { catalog_id: bundle.catalog_id, stages };
});

const ledger = preserveGeneratedAt(OUT, {
  schema_version: '1.0',
  generated_at: new Date().toISOString(),
  status: errors.length ? 'FAILED' : 'COMPLETE',
  stage_contract: INGESTION_STAGES,
  data_trust_contracts: {
    version: DATA_TRUST_CONTRACT_VERSION,
    status: dataTrustFailures.length ? 'FAILED' : 'COMPLETE',
    counts: dataTrustCounts,
  },
  artifacts: artifactEntries,
  catalogs: catalogEntries,
  findings: errors,
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

if (errors.length) {
  console.error(`FAIL: ingestion pipeline contract has ${errors.length} finding(s):`);
  console.error(errors.slice(0, 80).map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}
console.log(`PASS: ingestion pipeline contract covers ${artifactEntries.length} artifacts, ${catalogEntries.length} catalogs, and all ${INGESTION_STAGES.length} stages.`);
