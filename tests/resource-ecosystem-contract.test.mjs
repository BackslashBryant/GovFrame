import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { check } from "../scripts/check-commons-health.mjs";

import { searchDirectoryResources } from "../src/ui/lib/resourcesDirectory.mjs";

const dataset = JSON.parse(readFileSync("data/commons-resource-dataset.json", "utf8"));
const manifest = JSON.parse(readFileSync("data/commons-candidate-manifest.json", "utf8"));
const disposition = JSON.parse(readFileSync("data/resource-ecosystem-disposition.json", "utf8"));
const health = JSON.parse(readFileSync("data/commons-health-report.json", "utf8"));
const byId = new Map(dataset.resources.map((resource) => [resource.id, resource]));
const expectedCollections = [
  "dod-cybersecurity-portals",
  "reciprocity-authorization-reuse",
  "implementation-assessment-tools",
  "product-assurance-approved-products",
  "cloud-devsecops-software-factories",
  "cmmc-defense-industrial-base",
  "cyber-workforce-training",
  "practitioner-communities",
  "vulnerability-management-prioritization",
  "detection-soc",
  "threat-intelligence-investigation",
  "dfir-threat-hunting",
  "stig-configuration-automation",
  "network-security-analysis",
  "devsecops-supply-chain",
  "identity-access-security",
  "disa-services-capabilities",
];

test("required collections are populated and mutually resolvable", () => {
  assert.deepEqual(dataset.collections.map((collection) => collection.id), expectedCollections);
  for (const collection of dataset.collections) {
    assert.ok(collection.resourceIds.length >= 4, `${collection.id} has useful coverage`);
    for (const id of collection.resourceIds) {
      assert.ok(byId.has(id), `${collection.id} resolves ${id}`);
      assert.ok(byId.get(id).featuredCollections.includes(collection.id), `${id} links back to ${collection.id}`);
    }
  }
});

test("every card has identity and review metadata while optional editorial claims stay optional", () => {
  const wordCount = (value) => value ? value.trim().split(/\s+/).length : 0;
  for (const resource of dataset.resources) {
    if (resource.cardPurpose) assert.ok(resource.cardPurpose.length >= 20, `${resource.id} card purpose`);
    assert.ok(resource.publisherType, `${resource.id} publisher type`);
    if (resource.officialStatus) assert.equal(typeof resource.officialStatus, "string", `${resource.id} optional official status`);
    assert.ok(resource.brandKey, `${resource.id} brand key`);
    assert.ok(resource.sourceEvidence, `${resource.id} source evidence`);
    assert.ok(resource.verificationMethod, `${resource.id} verification method`);
    assert.match(resource.lastCheckedAt, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(resource.lastCheckedAt <= dataset.lastUpdated, `${resource.id} review date is not in the future`);
    assert.ok(Array.isArray(resource.technologyScopes));
    assert.ok(Array.isArray(resource.searchAliases));
    assert.ok(Array.isArray(resource.featuredCollections));
    assert.ok(wordCount(resource.summary) <= 25, `${resource.id} summary exceeds 25 words`);
    assert.ok(wordCount(resource.whyIncluded) <= 35, `${resource.id} why listed exceeds 35 words`);
    if (resource.cardPurpose) assert.ok(wordCount(resource.cardPurpose) <= 18, `${resource.id} card purpose exceeds 18 words`);

    const hostname = new URL(resource.canonicalUrl).hostname;
    assert.doesNotMatch(hostname, /(^|\.)(example\.(com|org|net)|invalid|localhost)$/i, `${resource.id} uses a non-canonical test domain`);
  }
});

test("parent and child ecosystem relationships resolve without becoming publication duplicates", () => {
  for (const resource of dataset.resources) {
    if (resource.parentEcosystemId) assert.ok(byId.has(resource.parentEcosystemId), `${resource.id} parent resolves`);
    for (const childId of resource.childResourceIds) assert.ok(byId.has(childId), `${resource.id} child resolves`);
  }
  assert.equal(byId.get("directory-common-criteria-products").parentEcosystemId, "ecosystem-common-criteria");
  assert.equal(byId.get("tool-platform-one-ironbank").parentEcosystemId, "ecosystem-platform-one");
  assert.equal(byId.get("portal-disa-servicenow").parentEcosystemId, "portal-disa-connect");
  assert.equal(byId.get("portal-disa-servicenow").accessType, undefined);
  assert.match(byId.get("portal-disa-servicenow").publicAccessNotes, /NIPRNet or NIPRNet VPN/);
});

test("aliases find current resources and removed publications stay out of Resources", () => {
  assert.equal(searchDirectoryResources(dataset.resources, "Repo One")[0]?.id, "tool-platform-one-ironbank");
  assert.ok(searchDirectoryResources(dataset.resources, "8140").some((resource) => resource.id === "official-dod-8140-matrix"));
  assert.ok(searchDirectoryResources(dataset.resources, "FedVTE").some((resource) => resource.id === "training-cisa-learning"));
  for (const removed of ["official-dodi-8510-01", "official-nist-sp800-171a", "official-cisa-cpgs", "official-eo-14028"]) {
    assert.equal(byId.has(removed), false, `${removed} remains Library-owned`);
  }
});

test("communities carry one exact safety warning and rejected candidates remain auditable", () => {
  const warning = "Do not post CUI, credentials, system details, assessment evidence, or other non-public organizational information.";
  for (const resource of dataset.resources.filter((entry) => entry.resourceType === "community_forum")) {
    assert.equal(resource.warnings.filter((entry) => entry === warning).length, 1, `${resource.id} warning exactly once`);
  }
  assert.equal(manifest.acceptedCount, dataset.resources.length);
  assert.equal(disposition.candidates.length, manifest.totalEvaluated);
  assert.ok(manifest.acceptedCandidates.some((candidate) => /Tenable Audit Files/.test(candidate.candidateName)));
  assert.ok(manifest.acceptedCandidates.some((candidate) => candidate.candidateName === "Tenable Connect"));
  assert.ok(manifest.rejectedCandidates.some((candidate) => candidate.candidateName === "Evaluate-STIG"));
  assert.ok(manifest.acceptedCandidates.some((candidate) => candidate.candidateName === "Microsoft StigRepo" && candidate.lane === "legacy"));
  assert.ok(manifest.rejectedCandidates.some((candidate) => /Platform One Party Bus/.test(candidate.candidateName)));
});

test("protected destinations remain explicit expected-access checks", () => {
  const disaServiceNow = health.results.find((result) => result.id === "portal-disa-servicenow");
  assert.equal(disaServiceNow?.outcome, "manual_expected_access");
  assert.equal(disaServiceNow?.ok, true);
  assert.match(disaServiceNow?.note ?? "", /NIPRNet or NIPRNet VPN/);
});

test("normalized restricted records retain their access boundary without a network request", async () => {
  const resource = byId.get("portal-disa-servicenow");
  assert.equal(resource.accessType, undefined);
  const result = await check(resource, () => { throw new Error("Restricted destination was probed"); });
  assert.equal(result.outcome, "manual_expected_access");
  assert.equal(result.status, null);
  assert.equal(result.note, resource.publicAccessNotes);
});

test("public destinations and unsupported restriction claims still report network failures", async () => {
  for (const overrides of [
    { verificationMethod: "automated" },
    { publicAccessNotes: undefined },
  ]) {
    let calls = 0;
    const result = await check({ ...byId.get("portal-disa-servicenow"), ...overrides }, async () => {
      calls += 1;
      throw new Error("Network unavailable");
    });
    assert.equal(calls, 1);
    assert.equal(result.outcome, "network_error");
    assert.equal(result.ok, false);
  }
});
