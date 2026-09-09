#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INGESTION_STAGES } from './lib/ingestion-pipeline.mjs';
import { preserveGeneratedAt } from './lib/stable-generated-at.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8'));
const dataset = readJson('data/commons-resource-dataset.json');
const candidates = readJson('data/commons-candidate-manifest.json');
const searchIndex = readJson('data/generated/commons-search-index.json');
const outputPath = join(ROOT, 'data/generated/resource-ingestion-ledger.json');
const errors = [];

const acceptedByUrl = new Map((candidates.acceptedCandidates || []).map((entry) => [entry.url, entry]));
const publishedIds = new Set((searchIndex.documents || []).map((entry) => entry.id));
const collectionIds = new Set((dataset.collections || []).map((entry) => entry.id));
const complete = (evidence) => ({ status: 'complete', evidence });
const notApplicable = (reason) => ({ status: 'not_applicable', reason });
const failed = (reason) => ({ status: 'failed', reason });

function presentationStage(resource) {
  const overview = resource.overview;
  const compatibility = resource.compatibility;
  const media = resource.media;
  if (overview && (!overview.text || !overview.sourceUrl || !overview.sourceType)) {
    return failed('serialized overview evidence is incomplete');
  }
  if (compatibility && (compatibility.status !== 'documented' || !compatibility.sourceUrl || !compatibility.note)) {
    return failed('documented compatibility evidence is incomplete');
  }
  if (media && (media.status !== 'available' || !(media.items || []).length)) {
    return failed('media is marked available without an attributable item');
  }
  if (resource.presentationProfile?.profileType !== resource.resourceType
    || !resource.presentationProfile?.template) {
    return failed('type-specific presentation profile is incomplete');
  }
  for (const section of Object.values(resource.presentationProfile || {})) {
    if (section && typeof section === 'object'
      && ('status' in section || 'text' in section)
      && (section.status !== 'documented' || !section.text || !section.sourceUrl)) {
      return failed('serialized presentation section lacks documented source evidence');
    }
  }
  if (resource.toolProfile && Object.values(resource.toolProfile).some((section) => section?.status === 'not_documented')) {
    return failed('tool presentation profile contains an unsupported placeholder');
  }
  if ((media?.items || []).some((item) => !/^sha256:[a-f0-9]{64}$/.test(item.sha256 || '')
    || !item.byteLength || !item.width || !item.height || !item.license || !item.commitSha)) {
    return failed('published media lacks byte, dimension, license, or commit evidence');
  }
  return complete('the type profile is assigned and every serialized optional section carries source evidence');
}

const resources = (dataset.resources || []).map((resource) => {
  const accepted = acceptedByUrl.get(resource.canonicalUrl);
  const repositoryEvidence = resource.repositoryEvidence;
  const featuredCollections = resource.featuredCollections || [];
  const unresolvedCollections = featuredCollections.filter((id) => !collectionIds.has(id));
  const relationshipCount = (resource.companionResources || []).length
    + (resource.childResourceIds || []).length
    + (resource.parentEcosystemId ? 1 : 0);
  const presentation = presentationStage(resource);
  const stages = {
    discover: accepted
      ? complete('accepted candidate manifest contains the canonical URL')
      : failed('resource is absent from the accepted candidate manifest'),
    acquire: repositoryEvidence?.capturedAt && repositoryEvidence?.readmeUrl
      ? complete('repository API facts and README evidence were captured')
      : notApplicable('external locator is curated; upstream bytes are not copied into Control Atlas'),
    attest: resource.sourceEvidence && resource.lastCheckedAt && resource.verificationMethod
      ? complete('source locator, review date, and verification method are recorded')
      : failed('source attestation fields are incomplete'),
    parse: repositoryEvidence?.overviewExcerpt
      ? complete('README-derived fields were extracted by the resource enrichment adapter')
      : notApplicable('publisher locator is represented by reviewed metadata rather than parsed publisher content'),
    normalize: resource.id && resource.slug && resource.resourceType && resource.resourceLane
      ? complete('resource conforms to the normalized Commons record contract')
      : failed('normalized resource identity or classification is incomplete'),
    structure: unresolvedCollections.length
      ? failed(`unresolved collection membership(s): ${unresolvedCollections.join(', ')}`)
      : complete('resource lane, type, and collection memberships use the Commons directory taxonomy'),
    relationships: relationshipCount
      ? complete(`${relationshipCount} explicit ecosystem or companion relationship(s)`)
      : notApplicable('publisher resource declares no directory relationships'),
    presentation,
    reconcile: accepted
      && accepted.candidateName === resource.name
      && accepted.lane === resource.resourceLane
      ? complete('accepted candidate name, URL, and lane reconcile to the published resource')
      : failed('accepted candidate disposition does not reconcile to the published resource'),
    publish: publishedIds.has(resource.id)
      ? complete('resource is present in the generated Commons search index')
      : failed('resource is missing from the generated Commons search index'),
  };

  for (const [stage, result] of Object.entries(stages)) {
    if (result.status === 'failed') errors.push(`${resource.id} ${stage}: ${result.reason}`);
  }
  return { resource_id: resource.id, source_url: resource.canonicalUrl, stages };
});

const ledger = preserveGeneratedAt(outputPath, {
  schema_version: '1.0',
  generated_at: new Date().toISOString(),
  status: errors.length ? 'FAILED' : 'COMPLETE',
  stage_contract: INGESTION_STAGES,
  resources,
  findings: errors,
});
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');

if (errors.length) {
  console.error(`FAIL: resource ingestion contract has ${errors.length} finding(s):`);
  console.error(errors.slice(0, 80).map((error) => `- ${error}`).join('\n'));
  process.exit(1);
}
console.log(`PASS: resource ingestion contract covers ${resources.length} resources and all ${INGESTION_STAGES.length} stages.`);
