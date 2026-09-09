#!/usr/bin/env node
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import {
  assertionEnvelopeForEdge,
  assertionProfileId,
  effectiveProfile,
  recordProfileId,
} from "../src/shared/entity-profiles.mjs";
import {
  missingRequiredRecordFields,
  recordPresentationContract,
  undeclaredCapturedRecordFields,
} from "../src/shared/record-presentation.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (relativePath) => JSON.parse(readFileSync(join(ROOT, relativePath), "utf8"));
const failures = [];
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const absencePattern = /\b(?:not documented|were not documented|was not documented|not stated|no additional limitations|publisher destination was reviewed|documentation (?:was|were) not found)\b/i;

function fail(message) {
  failures.push(message);
}

function readShards(kind) {
  const directory = join(ROOT, "data", "generated", "graph-data", kind);
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .flatMap((file) => JSON.parse(readFileSync(join(directory, file), "utf8"))[kind] || []);
}

function displayStrings(value, trail = []) {
  if (typeof value === "string") return [{ trail, value }];
  if (Array.isArray(value)) return value.flatMap((item, index) => displayStrings(item, [...trail, index]));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, item]) => displayStrings(item, [...trail, key]));
}

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateAssertion = ajv.compile(readJson("data/schemas/atlas-assertion.schema.json"));
const validateClaimEvidence = ajv.compile(readJson("data/schemas/claim-evidence.schema.json"));
const validateEntity = ajv.compile(readJson("data/schemas/atlas-entity.schema.json"));
const dataset = readJson("data/commons-resource-dataset.json");
const sourceRegistry = readJson("data/source-registry.json");
const organizations = readJson("data/organizations.json").organizations || [];
const adapterRegistry = readJson("data/profiles/source-adapter-registry.json");
const migrationManifest = readJson("data/profiles/source-truth-migration-manifest.json");
const nodes = readShards("nodes");
const edges = readShards("edges");
const evidence = readShards("evidence");
const nodeIds = new Set(nodes.map((node) => node.id));
const evidenceById = new Map(evidence.map((entry) => [entry.id, entry]));
const sourcesById = new Map([...(sourceRegistry.sources || []), ...(sourceRegistry.artifacts || []), ...(sourceRegistry.publications || [])].map((entry) => [entry.id, entry]));
const resourceIds = new Set((dataset.resources || []).map((entry) => entry.id));
const publicationIds = new Set((sourceRegistry.publications || []).map((entry) => entry.id));
const resourceEvidenceById = new Map((dataset.evidenceCatalog || []).map((entry) => [entry.id, entry]));

function validateEntityEnvelope(entity, label) {
  if (!validateEntity(entity)) fail(`${label}: ${ajv.errorsText(validateEntity.errors)}`);
}

function entityEnvelope({ id, entityKind, profileId, title, lifecycleStatus, lifecycleEvidence = [], sourceRefs, origin, payload, parserId, parserVersion, retrievedAt = null, checkedAt = null }) {
  return {
    schema_version: "1.0",
    id,
    entity_kind: entityKind,
    profile_id: profileId,
    title,
    lifecycle: { status: lifecycleStatus || "unknown", evidence_refs: lifecycleEvidence },
    source_refs: sourceRefs,
    origin,
    payload,
    operational: {
      retrieved_at: retrievedAt,
      checked_at: checkedAt,
      parser_id: parserId,
      parser_version: parserVersion,
      review_status: "reviewed",
    },
  };
}

if (dataset.schemaVersion !== "4.0") fail(`resource dataset schemaVersion is ${dataset.schemaVersion}, expected 4.0`);
if (sourceRegistry.schema_version !== "5.0") fail(`source registry schema_version is ${sourceRegistry.schema_version}, expected 5.0`);
const requiredAdapterFields = ["adapter_id", "adapter_version", "catalog_ids", "accepted_source_types", "produced_profile_ids", "field_transformations", "relationship_rules", "fixture_set", "failure_policy"];
const coveredCatalogs = new Set();
for (const adapter of adapterRegistry.adapters || []) {
  for (const field of requiredAdapterFields) if (adapter[field] == null) fail(`${adapter.adapter_id || "adapter"} lacks ${field}`);
  for (const profileId of adapter.produced_profile_ids || []) if (!effectiveProfile(profileId)) fail(`${adapter.adapter_id} produces unknown ${profileId}`);
  for (const catalogId of adapter.catalog_ids || []) coveredCatalogs.add(catalogId);
}
for (const bundle of sourceRegistry.catalog_source_bundles || []) if (!coveredCatalogs.has(bundle.catalog_id)) fail(`${bundle.catalog_id} has no declared source adapter`);
const manifestProfiles = new Set((migrationManifest.mappings || []).map((mapping) => mapping.profile_id));

for (const resource of dataset.resources || []) {
  if (resource.costType === "free" || resource.costType === "no_cost") fail(`${resource.id} retains unsupported cost default ${resource.costType}`);
  const primaryCopy = [resource.summary, resource.cardPurpose, resource.overview?.text, resource.presentationProfile?.whatItDoes?.text]
    .filter(Boolean)
    .map((value) => String(value).trim().toLowerCase().replace(/\s+/g, " "));
  if (new Set(primaryCopy).size !== primaryCopy.length) fail(`${resource.id} repeats primary copy across presentation fields`);
  if (/^Provides a current, source-backed destination to\b/i.test(resource.whyIncluded || "")) fail(`${resource.id} retains generic inclusion filler`);
  for (const [field, value] of Object.entries(resource)) {
    if (value === null || value === "unknown") fail(`${resource.id}.${field} serializes an unknown optional value`);
  }
  // Presence of the key is not the claim. compatibility and media are recorded
  // on every enriched resource, including the explicit negative dispositions
  // (not_stated, not_applicable, not_available), which the schema permits and
  // verify-resource-ingestion accepts. What must not be serialized is a
  // disposition outside that vocabulary, or a negative one that fails to say why.
  if (resource.compatibility && !["documented", "not_stated", "not_applicable"].includes(resource.compatibility.status)) {
    fail(`${resource.id} serializes unsupported compatibility disposition`);
  }
  if (resource.compatibility && resource.compatibility.status !== "documented" && !resource.compatibility.note) {
    fail(`${resource.id} serializes an undocumented compatibility without a reason`);
  }
  if (resource.media && !["available", "not_available"].includes(resource.media.status)) {
    fail(`${resource.id} serializes unsupported media disposition`);
  }
  if (resource.media && resource.media.status === "not_available" && !resource.media.reason) {
    fail(`${resource.id} serializes unavailable media without a reason`);
  }
  for (const field of ["presentationProfile", "toolProfile"]) {
    for (const entry of displayStrings(resource[field], [field])) {
      if (absencePattern.test(entry.value)) fail(`${resource.id}.${entry.trail.join(".")} contains visible absence prose`);
    }
  }
  for (const section of Object.values(resource.presentationProfile || {})) {
    if (section && typeof section === "object" && section.status && section.status !== "documented") {
      fail(`${resource.id} serializes non-documented presentation section ${section.status}`);
    }
  }
  for (const section of Object.values(resource.toolProfile || {})) {
    if (section && typeof section === "object" && section.status === "not_documented") {
      fail(`${resource.id} serializes unsupported tool placeholder`);
    }
  }
  const evidencePaths = new Set();
  for (const claim of resource.claimEvidence || []) {
    evidencePaths.add(claim.fieldPath);
    const envelope = {
      entity_id: resource.id,
      field_path: claim.fieldPath,
      origin: claim.origin,
      evidence_refs: claim.evidenceRefs || [],
      ...(claim.transformation ? { transformation: claim.transformation } : {}),
      ...(claim.confidence != null ? { confidence: claim.confidence } : {}),
      review_status: claim.reviewStatus,
    };
    if (!validateClaimEvidence(envelope)) {
      fail(`${resource.id}${claim.fieldPath}: ${ajv.errorsText(validateClaimEvidence.errors)}`);
    }
    for (const evidenceId of claim.evidenceRefs || []) {
      if (!resourceEvidenceById.has(evidenceId)) fail(`${resource.id}${claim.fieldPath} references missing evidence ${evidenceId}`);
    }
    if (["/accessType", "/publicAccessNotes", "/costType", "/maintenanceStatus", "/lifecycle/replacedBy", "/supersededBy"].includes(claim.fieldPath)) {
      const locators = (claim.evidenceRefs || []).map((id) => resourceEvidenceById.get(id)?.locatorType).filter(Boolean);
      if (!locators.some((type) => type !== "canonical_url")) fail(`${resource.id}${claim.fieldPath} lacks a claim-specific publisher locator`);
    }
  }
  for (const field of ["/name", "/publisher", "/canonicalUrl"]) {
    if (!evidencePaths.has(field)) fail(`${resource.id} lacks claim evidence for ${field}`);
  }
  for (const [field, path] of [["summary", "/summary"], ["whyIncluded", "/whyIncluded"], ["accessType", "/accessType"], ["publicAccessNotes", "/publicAccessNotes"], ["maintenanceStatus", "/maintenanceStatus"]]) {
    if (resource[field] && !evidencePaths.has(path)) fail(`${resource.id} displays ${field} without claim evidence`);
  }
  if (resource.costType && !evidencePaths.has("/costType")) fail(`${resource.id} displays cost without field evidence`);
  const lifecycleReplacements = resource.lifecycle?.replacedBy || [];
  if (resource.supersededBy && lifecycleReplacements[0] !== resource.supersededBy) {
    fail(`${resource.id} has mismatched lifecycle.replacedBy and supersededBy values`);
  }
  const replacements = [...new Set([
    ...lifecycleReplacements,
    ...(resource.supersededBy ? [resource.supersededBy] : []),
  ])];
  for (const replacementId of replacements) {
    if (!resourceIds.has(replacementId) && !publicationIds.has(replacementId)) {
      fail(`${resource.id} references unresolved replacement ${replacementId}`);
    }
  }
  if (replacements.length && !evidencePaths.has("/lifecycle/replacedBy") && !evidencePaths.has("/supersededBy")) {
    fail(`${resource.id} names a replacement without explicit claim evidence`);
  }
  validateEntityEnvelope(entityEnvelope({
    id: resource.id,
    entityKind: "resource",
    profileId: resource.profileId,
    title: resource.name,
    lifecycleStatus: resource.lifecycle?.status,
    lifecycleEvidence: resource.lifecycle?.evidenceRefs || [],
    sourceRefs: resource.sourceRefs || [],
    origin: resource.origin,
    payload: { resourceType: resource.resourceType },
    parserId: "commons-resource-curation",
    parserVersion: "2.0.0",
    retrievedAt: resource.lastCheckedAt || null,
    checkedAt: resource.lastCheckedAt || null,
  }), resource.id);
}

for (const organization of organizations) validateEntityEnvelope(organization, organization.id);

for (const artifact of sourceRegistry.artifacts || []) {
  if (!sha256Pattern.test(artifact.sha256 || "")) fail(`${artifact.id} lacks a valid acquired-artifact checksum`);
  if (!artifact.version && !artifact.metadata?.version_unknown_reason) fail(`${artifact.id} lacks a version or explicit version-unknown disposition`);
  validateEntityEnvelope(entityEnvelope({
    id: artifact.id,
    entityKind: "artifact",
    profileId: artifact.profile_id,
    title: artifact.display_name || artifact.name,
    lifecycleStatus: artifact.lifecycle_status,
    sourceRefs: [artifact.artifact_url].filter(Boolean),
    origin: artifact.origin,
    payload: { format: artifact.format },
    parserId: artifact.parser || "artifact-acquisition",
    parserVersion: artifact.parser_version || "1.0.0",
    retrievedAt: artifact.retrieved_at || null,
    checkedAt: artifact.retrieved_at || null,
  }), artifact.id);
}
for (const source of sourceRegistry.sources || []) {
  if (!sha256Pattern.test(source.checksum || "")) fail(`${source.id} lacks a valid checksum`);
  if (!source.version && !source.metadata?.version_unknown_reason) fail(`${source.id} lacks a source version or explicit version-unknown disposition`);
  validateEntityEnvelope(entityEnvelope({
    id: source.id,
    entityKind: "artifact",
    profileId: source.profile_id,
    title: source.display_name || source.name,
    lifecycleStatus: source.lifecycle_status,
    sourceRefs: [source.artifact_url].filter(Boolean),
    origin: source.origin,
    payload: { format: source.artifact_type || "other" },
    parserId: source.metadata?.parser || "source-acquisition",
    parserVersion: source.parser_version || "1.0.0",
    retrievedAt: source.retrieved_at || null,
    checkedAt: source.retrieved_at || null,
  }), source.id);
}
for (const publication of sourceRegistry.publications || []) {
  validateEntityEnvelope(entityEnvelope({
    id: publication.id,
    entityKind: "publication",
    profileId: publication.profile_id,
    title: publication.display_name || publication.name,
    lifecycleStatus: publication.lifecycle_status,
    sourceRefs: [publication.artifact_url || publication.catalog_browse_url].filter(Boolean),
    origin: publication.origin,
    payload: { publisher: publication.owner || "" },
    parserId: publication.metadata?.parser || "publication-registry",
    parserVersion: "1.0.0",
    retrievedAt: publication.retrieved_at || null,
    checkedAt: publication.retrieved_at || null,
  }), publication.id);
}

for (const node of nodes) {
  const expectedProfile = recordProfileId(node.node_type);
  if (node.entity_kind !== "content_record" || node.profile_id !== expectedProfile) fail(`${node.id} lacks explicit ${expectedProfile} envelope fields`);
  if (!effectiveProfile(expectedProfile)) fail(`${node.id} resolves unknown profile ${expectedProfile}`);
  if (!manifestProfiles.has(expectedProfile)) fail(`${node.id} profile ${expectedProfile} is absent from the migration manifest`);
  if (!node.metadata?.origin) fail(`${node.id} lacks origin classification`);
  const presentation = recordPresentationContract(node.metadata?.catalog_id, node.node_type);
  const missingPresentationFields = missingRequiredRecordFields(presentation, node.metadata || {});
  if (missingPresentationFields.length) fail(`${node.id} lacks required presentation fields: ${missingPresentationFields.join(", ")}`);
  const undeclaredPresentationFields = undeclaredCapturedRecordFields(presentation, node.metadata || {});
  if (undeclaredPresentationFields.length) fail(`${node.id} lacks presentation dispositions for: ${undeclaredPresentationFields.join(", ")}`);
  const claimPaths = new Set();
  for (const claim of node.claim_evidence || []) {
    claimPaths.add(claim.field_path);
    if (!validateClaimEvidence(claim)) fail(`${node.id}${claim.field_path}: ${ajv.errorsText(validateClaimEvidence.errors)}`);
  }
  for (const section of presentation.sections || []) {
    const value = node.metadata?.[section.field];
    const displayed = Array.isArray(value) ? value.length > 0 : Boolean(String(value || "").trim());
    if (displayed && !claimPaths.has(`/metadata/${section.field}`)) fail(`${node.id} displays ${section.field} without field-level evidence`);
  }
  const replacementIds = node.metadata?.replaced_by || node.metadata?.superseded_by || [];
  if ((Array.isArray(replacementIds) ? replacementIds.length : Boolean(replacementIds)) && !(node.source_refs?.length || node.metadata?.authority_source_refs?.length || node.artifact_ids?.length)) {
    fail(`${node.id} names a replacement without a source reference`);
  }
  const source = sourcesById.get(node.source_id) || {};
  validateEntityEnvelope(entityEnvelope({
    id: node.id,
    entityKind: "content_record",
    profileId: node.profile_id,
    title: node.metadata?.title || node.label,
    lifecycleStatus: node.lifecycle_status,
    sourceRefs: node.source_refs || [],
    origin: node.metadata.origin,
    payload: node.metadata || {},
    parserId: source.metadata?.parser || source.parser || "catalog-adapter",
    parserVersion: source.parser_version || "1.0.0",
    retrievedAt: source.retrieved_at || null,
    checkedAt: source.last_checked || source.retrieved_at || null,
  }), node.id);
}

for (const edge of edges) {
  const expectedProfile = assertionProfileId(edge.relationship_type);
  if (edge.relationship_type === "Concept Crosswalk") fail(`${edge.id} retains uncontrolled Concept Crosswalk predicate`);
  if (edge.entity_kind !== "assertion" || edge.profile_id !== expectedProfile) fail(`${edge.id} lacks explicit ${expectedProfile} envelope fields`);
  if (!edge.assertion_class || !edge.authority_class || !edge.status) fail(`${edge.id} lacks relationship class, authority, or lifecycle`);
  if (!nodeIds.has(edge.source_node_id) || !nodeIds.has(edge.target_node_id)) fail(`${edge.id} references a missing endpoint`);
  const envelope = assertionEnvelopeForEdge(edge);
  if (!validateAssertion(envelope)) fail(`${edge.id}: ${ajv.errorsText(validateAssertion.errors)}`);
  if (!["structural", "atlas_navigation"].includes(envelope.assertion_class)) {
    const matchingEvidence = (edge.evidence_ids || []).map((id) => evidenceById.get(id)).filter(Boolean);
    if (!edge.source_refs?.length && !matchingEvidence.length) fail(`${edge.id} has no resolvable evidence`);
  }
}

for (const entry of evidence) {
  if (!entry.source_version) fail(`${entry.id} lacks retrieval version context`);
  if (!entry.checksum && !["editorial", "locator_only"].includes(entry.integrity_status)) fail(`${entry.id} lacks checksum or an explicit integrity disposition`);
  if (entry.checksum && !sha256Pattern.test(entry.checksum)) fail(`${entry.id} has invalid checksum`);
}

for (const id of ["mitre-attack-enterprise", "mitre-attack-ics"]) {
  const source = sourceRegistry.sources.find((entry) => entry.id === id);
  if (!source || /\/master\//.test(source.artifact_url || "") || !/6cda5ad8462c79e14fbb872f4e09059b18e0cfc4/.test(source.artifact_url || "")) {
    fail(`${id} is not pinned to the reviewed ATT&CK 19.2 commit`);
  }
}
const d3fend = sourceRegistry.sources.find((entry) => entry.id === "mitre-d3fend-ontology");
if (d3fend?.artifact_url !== "https://d3fend.mitre.org/ontologies/d3fend.json" || d3fend.version !== "1.6.0") fail("D3FEND is not sourced from the reviewed 1.6.0 ontology JSON-LD artifact");
const fedrampLegacy = sourceRegistry.sources.find((entry) => entry.id === "fedramp-rev5");
const fedrampCurrent = sourceRegistry.sources.find((entry) => entry.id === "fedramp-2026-rules");
if (fedrampLegacy?.lifecycle_status !== "historical" || fedrampCurrent?.lifecycle_status !== "active") fail("FedRAMP current and historical source roles are not explicit");
const dodRai = sourceRegistry.sources.find((entry) => entry.id === "dod-rai-toolkit");
if (!/^https:\/\/www\.ai\.mil\//.test(dodRai?.artifact_url || "") || dodRai?.provenance_class !== "control_atlas_derived") {
  fail("DoD Responsible AI is not reconciled to the official CDAO source with derived catalog content labeled correctly");
}

for (const path of ["data/nist-iot-cybersecurity.json", "data/requirements-800-171.json", "data/requirements-800-172.json"]) {
  const document = readJson(path);
  for (const record of document.records || []) {
    const title = String(record.title || "").trim().toLowerCase().replace(/\s+/g, " ");
    const description = String(record.description || "").trim().toLowerCase().replace(/\s+/g, " ");
    if (title && title === description) fail(`${path} copies ${record.id} title into description`);
  }
}

const publicAbsenceCopy = /\b(?:not documented|not recorded|not stated|no published mappings yet|no published rationale was supplied|no narrative text was published)\b/i;
for (const path of [
  "src/ui/pages/ObjectDetailPage.tsx",
  "src/ui/pages/CommonsDetailPage.tsx",
  "src/ui/pages/SourcesPage.tsx",
  "src/ui/lib/searchPresentation.tsx",
  "src/ui/lib/relationshipProvenance.ts",
  "src/ui/lib/resourceBrands.mjs",
]) {
  if (publicAbsenceCopy.test(readFileSync(join(ROOT, path), "utf8"))) fail(`${path} contains public absence narration`);
}

if (failures.length) {
  console.error(`FAIL: source-truth verification found ${failures.length} issue(s):`);
  console.error(failures.slice(0, 200).map((failure) => `- ${failure}`).join("\n"));
  if (failures.length > 200) console.error(`- …and ${failures.length - 200} more`);
  process.exit(1);
}

console.log(`PASS: source truth verified across ${organizations.length} organizations, ${dataset.resources.length} resources, ${nodes.length} records, ${edges.length} assertions, ${evidence.length} evidence rows, and ${sourceRegistry.artifacts.length + sourceRegistry.sources.length} artifacts.`);
