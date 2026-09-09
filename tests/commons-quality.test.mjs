import assert from "assert";
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import "./resource-ecosystem-contract.test.mjs";

const DATASET_PATH = resolve("data/commons-resource-dataset.json");
const MANIFEST_PATH = resolve("data/commons-candidate-manifest.json");
const INDEX_PATH = resolve("data/generated/commons-search-index.json");
const SCHEMA_PATH = resolve("data/schemas/commons-resource-schema.json");
const CATALOG_BOOTSTRAP_PATH = resolve("data/generated/catalog-bootstrap.json");

console.log("⚡ Running Control Commons Quality & Integrity Benchmark...");

// 1. Check file existence
assert.ok(existsSync(DATASET_PATH), "Dataset file exists");
assert.ok(existsSync(MANIFEST_PATH), "Candidate manifest exists");
assert.ok(existsSync(INDEX_PATH), "Generated search index exists");
assert.ok(existsSync(SCHEMA_PATH), "JSON schema exists");

const dataset = JSON.parse(readFileSync(DATASET_PATH, "utf-8"));
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf-8"));
const index = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"));

// 2. Validate against JSON Schema with AJV
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);
const valid = validate(dataset);

if (!valid) {
  console.error("AJV Validation Errors:", validate.errors);
  assert.fail("Commons dataset failed JSON schema validation");
}
console.log("  ✓ Schema Validation Passed");

// 3. Validate minimum resource count & category targets
// 2026-08-02: 13 official-lane resources removed — each duplicated a
// publication already canonically ingested as its own Catalog/Source
// (SP 800-53/53A/53B/37/171/172, CSF 2.0, AI RMF, SSDF, DISA STIG/SRG, CMMC
// rule, FedRAMP baselines). See docs/DATA_POLICY.md
// Phase 2a — an ingested publication must not also render as an ordinary
// Resource card.
assert.ok(dataset.resources.length >= 83, `Expected >= 83 resources, found ${dataset.resources.length}`);
console.log(`  ✓ Resource Count: ${dataset.resources.length} indexed resources`);

const officialCount = dataset.resources.filter(r => r.resourceLane === "official").length;
const openSourceCount = dataset.resources.filter(r => r.resourceLane === "open_source").length;
const practitionerCount = dataset.resources.filter(r => r.resourceLane === "practitioner" || r.resourceType === "community_forum").length;
const templateCount = dataset.resources.filter(r => r.resourceType === "template" || r.artifactTypes.includes("template")).length;
const toolCount = dataset.resources.filter(r => r.resourceType === "tool" || r.resourceLane === "open_source").length;
const datasetFeedCount = dataset.resources.filter(r => r.resourceType === "dataset" || r.resourceType === "specification" || r.formats.includes("JSON") || r.formats.includes("REST API")).length;
const commercialCount = dataset.resources.filter(r => r.resourceLane === "commercial" || r.costType === "freemium").length;
const legacyCount = dataset.resources.filter(r => r.resourceLane === "legacy" || r.maintenanceStatus === "archived").length;

assert.ok(officialCount >= 37, `Expected >= 37 official resources, found ${officialCount}`);
assert.ok(openSourceCount >= 32, `Expected >= 32 open-source resources, found ${openSourceCount}`);
assert.ok(practitionerCount >= 7, `Expected >= 7 practitioner resources, found ${practitionerCount}`);
assert.ok(templateCount >= 5, `Expected >= 5 resource templates after publication-owned starters moved to Library, found ${templateCount}`);
assert.ok(toolCount >= 33, `Expected >= 33 tool resources, found ${toolCount}`);
assert.ok(datasetFeedCount >= 7, `Expected >= 7 dataset/API resources, found ${datasetFeedCount}`);
assert.ok(commercialCount >= 3, `Expected >= 3 commercial resources, found ${commercialCount}`);
assert.ok(legacyCount >= 2, `Expected >= 2 legacy resource records after publication history moved to Library, found ${legacyCount}`);

console.log("  ✓ Category Breakdown Targets Passed:");
console.log(`    - Official: ${officialCount} | Open Source: ${openSourceCount} | Practitioner: ${practitionerCount}`);
console.log(`    - Templates: ${templateCount} | Tools: ${toolCount} | Datasets/APIs: ${datasetFeedCount}`);
console.log(`    - Commercial: ${commercialCount} | Legacy: ${legacyCount}`);

const idSet = new Set();
const urlSet = new Set();

for (const r of dataset.resources) {
  assert.ok(r.id, "Resource ID is present");
  assert.ok(!idSet.has(r.id), `Duplicate resource ID: ${r.id}`);
  idSet.add(r.id);

  assert.ok(r.canonicalUrl, `Resource ${r.id} missing canonicalUrl`);
  assert.ok(!urlSet.has(r.canonicalUrl), `Duplicate canonical URL: ${r.canonicalUrl}`);
  urlSet.add(r.canonicalUrl);

  assert.ok(r.resourceLane, `Resource ${r.id} missing resourceLane`);
  assert.ok(r.publisher, `Resource ${r.id} missing publisher`);
  if (r.overview) {
    assert.ok(r.overview.text?.trim().length >= 20, `Resource ${r.id} source-backed overview has useful text`);
    assert.ok(r.overview.sourceUrl?.startsWith("https://"), `Resource ${r.id} overview needs evidence URL`);
  }
  if (r.compatibility) {
    assert.equal(r.compatibility.status, "documented", `Resource ${r.id} only serializes documented compatibility`);
    assert.ok(r.compatibility.sourceUrl?.startsWith("https://"), `Resource ${r.id} compatibility needs evidence URL`);
    assert.ok(r.compatibility.note?.trim(), `Resource ${r.id} documented compatibility needs an evidence note`);
  }
  if (r.media) assert.equal(r.media.status, "available", `Resource ${r.id} only serializes available media`);
  for (const media of r.media?.items || []) {
    assert.ok(media.url.startsWith("https://"), `Resource ${r.id} media URL must be HTTPS`);
    assert.ok(media.sourceUrl.startsWith("https://"), `Resource ${r.id} media needs publisher evidence`);
    assert.ok(media.alt.trim(), `Resource ${r.id} media needs alt text`);
  }
  if (r.repositoryEvidence) {
    assert.ok(r.repositoryEvidence?.readmeUrl, `Resource ${r.id} repository needs README evidence`);
    assert.ok(r.repositoryEvidence?.facts?.defaultBranch, `Resource ${r.id} repository needs source-backed facts`);
  }
  assert.equal(
    Object.hasOwn(r, "editorialRecommendation"),
    false,
    `Resource ${r.id} must not carry an editorial recommendation`,
  );
  assert.doesNotMatch(
    r.whyIncluded || "",
    /\b(?:authoritative|essential|governing|leading|mandatory|popular|recommended|widely used|widely recognized|industry-standard|battle-tested|pioneering)\b/i,
    `Resource ${r.id} whyIncluded must state an observable inclusion reason`,
  );
  if (!r.openSource && r.license) {
    assert.doesNotMatch(r.license, /open source/i, `Resource ${r.id} must not claim an open-source license`);
  }
}
console.log("  ✓ Uniqueness and whyIncluded Statement Audits Passed");

for (const resource of dataset.resources) {
  assert.equal(resource.presentationProfile?.profileType, resource.resourceType, `${resource.id} profile type`);
  assert.ok(resource.presentationProfile?.template, `${resource.id} presentation template`);
  for (const field of ["whatItDoes", "whoItIsFor", "limitations"]) {
    const section = resource.presentationProfile?.[field];
    if (!section) continue;
    assert.equal(section.status, "documented", `${resource.id} ${field} status`);
    assert.ok(section.text && section.sourceUrl, `${resource.id} ${field} evidence`);
  }
}

const exactTools = dataset.resources.filter((resource) => resource.resourceType === "tool");
assert.ok(exactTools.length >= 40, "Every tool record receives the tool contract");
for (const resource of exactTools) {
  assert.notEqual(resource.currentVersion, "Current", `${resource.id} must not use a Current placeholder`);
  assert.ok(resource.toolProfile, `${resource.id} tool profile`);
  for (const field of ["inputs", "outputs", "formats", "integrations", "installation", "usage"]) {
    const section = resource.toolProfile[field];
    if (!section) continue;
    assert.equal(section.status, "documented", `${resource.id} ${field} status`);
    assert.ok(section.text && section.sourceUrl, `${resource.id} ${field} evidence`);
  }
  if (resource.toolProfile.maintenance) assert.notEqual(resource.toolProfile.maintenance.status, "unknown", `${resource.id} maintenance is evidence-backed`);
  if (resource.toolProfile.release) assert.notEqual(resource.toolProfile.release.status, "not_documented", `${resource.id} release is evidence-backed`);
}

const repositoryBackedTools = exactTools.filter((resource) => resource.repositoryEvidence);
// A live enrichment can add evidence for previously unenriched tools. Retain
// the reviewed coverage floor without rejecting those additional attestations.
assert.ok(repositoryBackedTools.length >= 36, "At least the 36 reviewed repository-backed tools retain repository evidence");
for (const resource of repositoryBackedTools) {
  const evidence = resource.repositoryEvidence;
  assert.match(evidence.commitSha, /^[a-f0-9]{40}$/i, `${resource.id} commit SHA`);
  assert.match(evidence.readmeSha256, /^sha256:[a-f0-9]{64}$/, `${resource.id} README checksum`);
  assert.ok(evidence.readmeByteLength > 0, `${resource.id} README byte length`);
  assert.ok(evidence.readmeUrl.includes(evidence.commitSha), `${resource.id} commit-pinned README URL`);
  assert.ok(["published", "not_published"].includes(evidence.release.status), `${resource.id} release disposition`);
}

for (const resource of dataset.resources) {
  for (const media of resource.media?.items || []) {
    assert.match(media.sha256, /^sha256:[a-f0-9]{64}$/, `${resource.id} media checksum`);
    assert.ok(media.byteLength > 0, `${resource.id} media byte length`);
    assert.ok(media.width > 0 && media.height > 0, `${resource.id} media dimensions`);
    assert.ok(media.license && media.licenseBasis, `${resource.id} media license basis`);
    assert.ok(media.retrievedAt && media.commitSha, `${resource.id} media retrieval provenance`);
  }
}

const paidProductEntries = dataset.resources.filter(
  (resource) => resource.costType === "commercial",
);
assert.deepEqual(
  paidProductEntries.map((resource) => resource.id),
  [],
  "Resources may list a commercial publisher only for a clearly accessible artifact, not a paywalled product or service",
);
const iAssure = dataset.resources.find((resource) => resource.id === "template-i-assure-ssp-worksheet");
assert.equal(iAssure?.canonicalUrl, "https://i-assure.com/products/rmf-templates/");
assert.equal(iAssure?.resourceType, "template");
assert.equal(iAssure?.costType, undefined);
assert.equal(iAssure?.publisherType, "commercial");
assert.match(iAssure?.officialStatus || "", /commercial publisher/i);
assert.match(iAssure?.whyIncluded || "", /paid service offerings are outside/i);
for (const resource of dataset.resources.filter((entry) => entry.resourceLane === "commercial")) {
  if (resource.officialStatus) assert.doesNotMatch(resource.officialStatus, /^community$/i, `${resource.id} must label publisher ownership accurately`);
}
for (const removedId of [
  "portal-tenable-audits",
  "docs-tenable-compliance",
  "community-tenable",
  "service-platform-one-party-bus",
  "service-platform-one-collabtools",
  "service-platform-one-edgeops",
]) {
  assert.equal(dataset.resources.some((resource) => resource.id === removedId), false, `${removedId} stays excluded as paid-product-only`);
}
console.log("  ✓ Accessible Artifact Boundary Passed (no paywalled product cards)");

// 3b. Ownership: an ingested Catalog publication must not also render as an
// ordinary Resource (docs/DATA_POLICY.md ownership rule;
// 2026-08-02 Phase 2a / Workstream 4). Each pattern is a distinctive token
// from a real ingested catalog's own name — specific enough that only a
// genuine duplicate-identity Resource would carry it too. Tool/template
// resources are exempt: a STIG viewer or an SSP template legitimately
// mentions its framework without duplicating the framework's own identity.
if (existsSync(CATALOG_BOOTSTRAP_PATH)) {
  const catalogBootstrap = JSON.parse(readFileSync(CATALOG_BOOTSTRAP_PATH, "utf-8"));
  const CATALOG_IDENTITY_TOKENS = {
    "cmmc-2": /\bcmmc\b.*\b(2\.0|32 cfr|170)\b/i,
    "csf-2": /\bcybersecurity framework\b.*\b2\.0\b|\bcsf\b.*\b2\.0\b/i,
    "disa-srg": /\bdisa\b.*\bsrg\b|\bsecurity requirements guides?\b/i,
    "disa-stig": /\bdisa\b.*\bstig\b|\bsecurity technical implementation guides?\b/i,
    "fedramp-rev5": /\bfedramp\b.*\bbaseline/i,
    "nist-800-171": /\bsp\s?800-171\b(?!a)/i,
    "nist-800-171-rev2": /\bsp\s?800-171\b.*\brev(?:ision)?\.?\s?2\b/i,
    "nist-800-172": /\bsp\s?800-172\b/i,
    "nist-800-37": /\bsp\s?800-37\b/i,
    "nist-800-53": /\bsp\s?800-53\b(?!a|b)/i,
    "nist-800-53a": /\bsp\s?800-53a\b/i,
    "nist-800-53b": /\bsp\s?800-53b\b/i,
    "nist-ai-rmf": /\bai rmf\b/i,
    "nist-ssdf": /\bssdf\b/i,
  };
  const PUBLICATION_IDENTITY_TYPES = new Set(["policy", "instruction", "specification", "historical_reference"]);

  for (const catalog of catalogBootstrap.catalog_bootstrap.catalogs) {
    const pattern = CATALOG_IDENTITY_TOKENS[catalog.id];
    if (!pattern) continue;
    const duplicate = dataset.resources.find(
      (r) =>
        r.resourceLane === "official" &&
        PUBLICATION_IDENTITY_TYPES.has(r.resourceType) &&
        pattern.test(r.name),
    );
    assert.equal(
      duplicate,
      undefined,
      `Resource '${duplicate?.id}' duplicates ingested catalog '${catalog.id}' (${catalog.name}, ${catalog.leaf_record_count} records) as an ordinary Resource — this publication already has a canonical Catalog/Source identity and must not have a second one.`,
    );
  }
  console.log("  ✓ Catalog Ownership Audit Passed (no ingested publication duplicated as a Resource)");
}

// 4. Validate collection integrity
assert.equal(dataset.collections.length, 17, "Seventeen curated resource collections ship");
const collectionIds = new Set(dataset.collections.map((collection) => collection.id));
assert.equal(collectionIds.size, dataset.collections.length, "Collection IDs are unique");
for (const collection of dataset.collections) {
  assert.ok(collection.title && collection.summary && collection.whyCurated && collection.icon, `Collection ${collection.id} has usable metadata`);
  assert.ok(collection.resourceIds.length > 0, `Collection ${collection.id} is not empty`);
  for (const resourceId of collection.resourceIds) assert.ok(idSet.has(resourceId), `Collection ${collection.id} references ${resourceId}`);
}
console.log(`  ✓ Collection Integrity Audit Passed (${dataset.collections.length} collections verified)`);

// 5. Candidate Manifest & Rejection Audit
assert.strictEqual(manifest.totalEvaluated, manifest.acceptedCount + manifest.rejectedCount, "Manifest total matches sum");
assert.ok(manifest.totalEvaluated >= 106, `Expected >= 106 total evaluated candidates, found ${manifest.totalEvaluated}`);
assert.ok(manifest.acceptedCount === dataset.resources.length, "Manifest accepted count matches dataset");
assert.ok(manifest.rejectedCandidates.length >= 10, "Manifest records rejected candidates");
for (const rej of manifest.rejectedCandidates) {
  assert.ok(rej.candidateName && rej.url && rej.reason && rej.evidence, "Rejected candidate missing identity, reason, or evidence");
  assert.match(rej.checkedAt, /^\d{4}-\d{2}-\d{2}$/, `${rej.candidateName} checked date`);
  assert.match(rej.recheckAt, /^\d{4}-\d{2}-\d{2}$/, `${rej.candidateName} recheck date`);
  assert.ok(rej.recheckAt > rej.checkedAt, `${rej.candidateName} recheck follows verification`);
}
console.log(`  ✓ Candidate Manifest Audit Passed (${manifest.totalEvaluated} total evaluated: ${manifest.acceptedCount} accepted, ${manifest.rejectedCount} rejected with rationale)`);

// 6. Search Index Relevance & Benchmark Audits
assert.strictEqual(index.documents.length, dataset.resources.length, "Index document count matches dataset");
assert.strictEqual(
  index.builtAt,
  new Date(`${dataset.lastUpdated}T00:00:00.000Z`).toISOString(),
  "Index build stamp is deterministic and follows the source dataset freshness date",
);

function testSearch(query, expectedId) {
  const q = query.toLowerCase();
  const matches = index.documents.filter((doc) =>
    doc.name.toLowerCase().includes(q) ||
    doc.shortName.toLowerCase().includes(q) ||
    doc.searchableText.includes(q)
  );
  assert.ok(matches.length > 0, `Search query '${query}' returned no results`);
  const found = matches.some((m) => m.id === expectedId);
  assert.ok(found, `Search query '${query}' did not contain expected resource ID '${expectedId}'`);
}

// CMMC 2.0, DISA STIG, and FedRAMP baselines are canonical Catalog/Source
// publications now, not ordinary Resources (see 2026-08-02 note above) —
// these queries assert against the Resources that legitimately remain.
testSearch("CMMC", "portal-dod-cmmc");
testSearch("STIG", "tool-disa-stig-viewer");
testSearch("OSCAL", "official-nist-oscal");
testSearch("FedRAMP", "official-fedramp-marketplace");
testSearch("Trestle", "tool-compliance-trestle");
testSearch("PowerSTIG", "tool-powerstig");

console.log("  ✓ Search Relevance & Benchmark Queries Passed");
console.log("\n🎉 Control Commons Quality & Integrity Benchmark: 100% SUCCESS!\n");
