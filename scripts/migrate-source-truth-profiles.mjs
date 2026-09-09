#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomically } from "./lib/write-json-atomically.mjs";
import {
  artifactProfileId,
  publicationProfileId,
  resourceProfileId,
} from "../src/shared/entity-profiles.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const resourcePath = join(ROOT, "data", "commons-resource-dataset.json");
const sourcePath = join(ROOT, "data", "source-registry.json");
const fedramp2026Path = join(ROOT, "data", "fedramp-2026-catalog.json");
const profilePath = join(ROOT, "data", "profiles", "profile-registry.json");
const adapterPath = join(ROOT, "data", "profiles", "source-adapter-registry.json");
const organizationPath = join(ROOT, "data", "organizations.json");
const mitreCatalogPaths = new Map([
  ["mitre-attack-enterprise", join(ROOT, "data", "attack-techniques-enterprise.json")],
  ["mitre-attack-ics", join(ROOT, "data", "attack-techniques-ics.json")],
  ["mitre-d3fend-ontology", join(ROOT, "data", "d3fend-countermeasures.json")],
  ["mitre-d3fend-mappings", join(ROOT, "maps", "attack-to-d3fend.json")],
]);
const duplicateDescriptionPaths = [
  join(ROOT, "data", "nist-iot-cybersecurity.json"),
  join(ROOT, "data", "requirements-800-171.json"),
  join(ROOT, "data", "requirements-800-172.json"),
];
const genericAbsence = /(?:not documented|not stated|not available|no additional limitations|didn't state)/i;
const genericInclusion = /^Provides a current, source-backed destination to\b/i;
const atlasGeneratedDescriptions = new Set([
  "device cybersecurity capabilities published for iot devices.",
  "supporting capabilities published for iot device manufacturers.",
]);
const sourceBackedAccessNotes = new Map([
  ["service-censys", "Some searches are public; expanded query, API, and export capabilities require an account or paid plan."],
  ["commercial-cis-benchmarks-free", "Free PDF downloads require a no-cost CIS account; paid membership formats and tools are outside this card."],
  ["community-crowdstrike", "Community access requires authentication and may depend on a CrowdStrike customer relationship."],
  ["service-disa-deas", "The support page is public; authentication services and administrative capabilities require authorized government access."],
  ["service-disa-deos", "The offering page is public; service access and onboarding require authorized DoD credentials."],
  ["service-disa-acas", "Service access and support may require DoD credentials, CAC, and an authorized ACAS role."],
  ["catalog-disa-products", "The product catalog is public; ordering, onboarding, and some product details require an authorized DISA Connect account."],
  ["portal-disa-servicenow", "The public DISA Support page explains the service. The ticketing destination requires NIPRNet or NIPRNet VPN."],
  ["service-disa-vms", "The public offering page is viewable, while service onboarding and use require authorized DoD access."],
  ["service-dod-rmf-knowledge-service", "CAC or other authorized DoD credentials are required; use the landing page for access."],
  ["service-greynoise-visualizer", "Community lookups are limited; additional context and API access depend on account level."],
  ["service-dcsa-nisp-emass", "Authorized NISP users need required training and an approved account; this is a government workflow, not a paid product."],
  ["service-disa-pdisp", "Ordering and connection actions require authorized DoD access."],
  ["service-shodan", "Search depth, API access, and export features vary by account and subscription."],
  ["service-sprs-cyber-reports", "PIEE registration and the appropriate SPRS Cyber Vendor or government role are required; this is not a paid product."],
  ["community-tanium", "Tanium community resources require authentication and may depend on a customer relationship."],
  ["catalog-tenable-audit-files", "Audit metadata is publicly searchable, while downloading or operational use may require a Tenable product, account, or customer entitlement."],
  ["community-tenable-connect", "Some content is public, while registration and restricted support areas require Tenable credentials and may require a customer ID."],
  ["service-urlscan", "Public scans and search are available; private scans and expanded API capacity require an account or plan."],
  ["service-virustotal", "Basic lookups are available publicly; account, quota, licensing, and sharing limits vary by feature."],
]);
const sourceBackedLifecycle = new Map([
  ["legacy-diacap-transition", { status: "archived", replacedBy: "authority-dodi-8510-01" }],
  ["directory-dodin-apl", { status: "deprecated" }],
  ["reference-microsoft-stigrepo", { status: "archived" }],
  ["legacy-opencontrol-compliance-masonry", { status: "archived", replacedBy: "official-nist-oscal" }],
  ["tool-terrascan", { status: "archived" }],
]);
const sourceIdentityCorrections = new Map([
  ["nist-800-171-rev2", {
    name: "SP 800-171 Rev. 2",
  }],
  ["nist-800-172-rev3", {
    name: "SP 800-172 Rev. 3",
  }],
  ["nist-800-171-oscal-mappings", {
    name: "NIST SP 800-171 Rev. 3 OSCAL Control References",
    displayName: "SP 800-171 Rev. 3 OSCAL Control References",
    identityKind: "mapping",
  }],
]);
const optionalUnknownFields = [
  "officialStatus",
  "maturity",
  "freshnessStatus",
  "currentVersion",
  "publisherUpdatedAt",
  "lastReleaseAt",
  "lastCommitAt",
  "license",
  "supersededBy",
  "editorialNotes",
  "legacyReason",
];

function normalized(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function evidenceLocator(resource, id, locatorType = "canonical_url", locator = null) {
  return {
    id,
    sourceUrl: resource.sourceEvidence || resource.canonicalUrl,
    locatorType,
    locator: locator || resource.canonicalUrl,
    retrievedAt: resource.lastCheckedAt,
    reviewStatus: "reviewed",
  };
}

function claim(fieldPath, origin, evidenceRefs, transformation = null) {
  return {
    fieldPath,
    origin,
    evidenceRefs: evidenceRefs.filter(Boolean),
    ...(transformation ? { transformation } : {}),
    reviewStatus: "reviewed",
  };
}

function migrateResources() {
  const dataset = JSON.parse(readFileSync(resourcePath, "utf8"));
  dataset.schemaVersion = "4.0";
  dataset.evidenceCatalog = [];
  for (const resource of dataset.resources) {
    const sourceUrl = resource.sourceEvidence || resource.canonicalUrl;
    const lifecycleClaim = sourceBackedLifecycle.get(resource.id);
    const declaredMaintenanceStatus = lifecycleClaim?.status || resource.maintenanceStatus;
    const declaredSupersededBy = lifecycleClaim?.replacedBy || resource.supersededBy;
    const identityEvidenceId = `resource:${resource.id}:publisher-destination`;
    const productRecordId = resource.id === "service-disa-pdisp"
      ? "01t83000000GvquAAC"
      : null;
    const repositoryCommit = resource.repositoryEvidence?.commitSha;
    dataset.evidenceCatalog.push(repositoryCommit
      ? {
          id: identityEvidenceId,
          sourceUrl: resource.repositoryEvidence.commitUrl,
          locatorType: "repository_commit",
          locator: repositoryCommit,
          retrievedAt: resource.repositoryEvidence.capturedAt || resource.lastCheckedAt,
          reviewStatus: "reviewed",
        }
      : evidenceLocator(
          resource,
          identityEvidenceId,
          productRecordId ? "publisher_product_record" : "canonical_url",
          productRecordId || resource.canonicalUrl,
        ));
    const accessBoundaryNote = sourceBackedAccessNotes.get(resource.id);
    const accessEvidenceId = `resource:${resource.id}:access-boundary`;
    if (accessBoundaryNote) {
      dataset.evidenceCatalog.push(evidenceLocator(
        resource,
        accessEvidenceId,
        productRecordId ? "publisher_product_record" : "publisher_access_boundary",
        productRecordId || sourceUrl,
      ));
    }
    const historical = resource.resourceLane === "legacy"
      || ["archived", "deprecated", "retired", "sunset", "superseded"].includes(declaredMaintenanceStatus);
    const lifecycleEvidenceId = `resource:${resource.id}:lifecycle-notice`;
    if (historical) {
      dataset.evidenceCatalog.push(evidenceLocator(
        resource,
        lifecycleEvidenceId,
        repositoryCommit ? "repository_commit" : "publisher_lifecycle_notice",
        repositoryCommit || sourceUrl,
      ));
    }

    // Existing cost and access values were populated without field locators.
    // Preserve neither until a source-specific adapter can prove the claim.
    delete resource.costType;
    delete resource.accessType;
    delete resource.accountRequired;
    delete resource.authenticationRequired;
    if (accessBoundaryNote) resource.publicAccessNotes = accessBoundaryNote;
    else delete resource.publicAccessNotes;
    if (resource.audiences?.length === 1 && resource.audiences[0] === "Cybersecurity Practitioner") resource.audiences = [];
    if (JSON.stringify(resource.lifecycleStages) === JSON.stringify(["Implement", "Assess", "Monitor"])) resource.lifecycleStages = [];
    if (JSON.stringify(resource.technologyScopes) === JSON.stringify(["general_it"])) resource.technologyScopes = [];
    if (JSON.stringify(resource.platforms) === JSON.stringify(["all"])) resource.platforms = [];
    if (genericAbsence.test(resource.publicAccessNotes || "")) delete resource.publicAccessNotes;
    if (["official", "publisher-operated", "community"].includes(resource.officialStatus)) delete resource.officialStatus;
    if (resource.maturity === "stable") delete resource.maturity;
    if (resource.freshnessStatus === "current") delete resource.freshnessStatus;
    if (resource.maintenanceStatus === "active" && !resource.repositoryEvidence?.facts?.lastPushedAt) {
      resource.maintenanceStatus = "unknown";
    }
    if (!historical && !resource.repositoryEvidence) delete resource.maintenanceStatus;
    if (historical && declaredMaintenanceStatus) resource.maintenanceStatus = declaredMaintenanceStatus;
    if (declaredSupersededBy) resource.supersededBy = declaredSupersededBy;
    else delete resource.supersededBy;

    for (const field of optionalUnknownFields) {
      if (resource[field] == null || resource[field] === "unknown") delete resource[field];
    }
    if (resource.maintenanceStatus === "unknown") delete resource.maintenanceStatus;
    if (normalized(resource.cardPurpose) === normalized(resource.summary)) delete resource.cardPurpose;
    if (resource.overview && normalized(resource.overview.text) === normalized(resource.summary)) delete resource.overview;
    if (resource.presentationProfile?.whatItDoes
      && normalized(resource.presentationProfile.whatItDoes.text) === normalized(resource.summary)) {
      delete resource.presentationProfile.whatItDoes;
    }
    if (genericInclusion.test(resource.whyIncluded || "")) delete resource.whyIncluded;

    // The PDISP product page is public, while service ordering and connection
    // actions require authorization. A blanket "CAC required" label wrongly
    // described the page and the service as the same access boundary.
    for (const key of ["whoItIsFor", "limitations"]) {
      if (resource.presentationProfile?.[key]?.status !== "documented"
        || genericAbsence.test(resource.presentationProfile?.[key]?.text || "")) {
        delete resource.presentationProfile?.[key];
      }
    }
    if (resource.toolProfile) {
      for (const key of ["inputs", "outputs", "formats", "integrations", "installation", "usage", "license"]) {
        if (resource.toolProfile[key]?.status !== "documented"
          || genericAbsence.test(resource.toolProfile[key]?.text || "")) {
          delete resource.toolProfile[key];
        }
      }
      if (genericAbsence.test(resource.toolProfile.maintenance?.text || "")) delete resource.toolProfile.maintenance;
    }
    if (resource.compatibility?.status !== "documented") delete resource.compatibility;
    if (resource.media?.status !== "available") delete resource.media;
    if (resource.toolProfile?.release?.status !== "published") delete resource.toolProfile?.release;
    if (!resource.accessType) {
      if (resource.accountRequired === false) delete resource.accountRequired;
      if (resource.authenticationRequired === false) delete resource.authenticationRequired;
    }
    for (const [field, value] of Object.entries(resource)) {
      if (value === null) delete resource[field];
    }

    resource.entityKind = "resource";
    resource.profileId = resourceProfileId(resource.resourceType);
    resource.origin = "atlas_editorial";
    resource.sourceRefs = [identityEvidenceId];
    const maintenanceEvidenceId = historical ? lifecycleEvidenceId : identityEvidenceId;
    resource.lifecycle = {
      status: historical
        ? (declaredMaintenanceStatus || "historical")
        : resource.maintenanceStatus || "unknown",
      evidenceRefs: resource.maintenanceStatus ? [maintenanceEvidenceId] : [],
      ...(declaredSupersededBy ? { replacedBy: [declaredSupersededBy] } : {}),
    };
    resource.claimEvidence = [
      claim("/name", "publisher_normalized", [identityEvidenceId]),
      claim("/publisher", "publisher_normalized", [identityEvidenceId]),
      claim("/canonicalUrl", "publisher_exact", [identityEvidenceId]),
      ...(resource.summary ? [claim("/summary", "atlas_editorial", [], "Concise Control Atlas directory context based on the linked publisher destination.")] : []),
      ...(resource.whyIncluded ? [claim("/whyIncluded", "atlas_editorial", [], "Human-reviewed Control Atlas inclusion rationale.")] : []),
      ...(resource.accessType ? [claim("/accessType", "publisher_normalized", [identityEvidenceId])] : []),
      ...(resource.publicAccessNotes ? [claim("/publicAccessNotes", "publisher_normalized", [accessEvidenceId])] : []),
      ...(resource.costType ? [claim("/costType", "publisher_normalized", [identityEvidenceId])] : []),
      ...(resource.maintenanceStatus ? [claim("/maintenanceStatus", "publisher_normalized", [maintenanceEvidenceId])] : []),
      ...(resource.officialStatus && historical ? [claim("/officialStatus", "publisher_normalized", [lifecycleEvidenceId])] : []),
      ...(resource.legacyReason && historical ? [claim("/legacyReason", "publisher_normalized", [lifecycleEvidenceId])] : []),
      ...(declaredSupersededBy ? [claim("/lifecycle/replacedBy", "publisher_normalized", [lifecycleEvidenceId])] : []),
    ];
  }
  dataset.evidenceCatalog.sort((left, right) => left.id.localeCompare(right.id));
  writeJsonAtomically(resourcePath, dataset);
}

function migrateSourceRegistry() {
  const registry = JSON.parse(readFileSync(sourcePath, "utf8"));
  const fedramp2026 = JSON.parse(readFileSync(fedramp2026Path, "utf8"));
  const mitreCatalogs = new Map([...mitreCatalogPaths].map(([id, path]) => [id, JSON.parse(readFileSync(path, "utf8"))]));
  writeJsonAtomically(sourcePath, migrateSourceRegistryDocument(registry, fedramp2026, mitreCatalogs));
}

export function migrateSourceRegistryDocument(registry, fedramp2026, mitreCatalogs) {
  const syncMitreIdentity = (entry, catalog, kind) => {
    entry.version = catalog.source_version;
    entry.retrieved_at = catalog.snapshot_date;
    entry.artifact_url = catalog.source_artifact;
    if (kind === "artifact") {
      entry.sha256 = catalog.checksum;
      entry.byte_length = catalog.source_artifact_byte_length;
      entry.record_count = catalog.records?.length || 0;
      entry.relationship_count = catalog.relationships?.length || 0;
      entry.retrieval_method = "direct_file_import";
      entry.metadata = { ...(entry.metadata || {}), checksum_basis: catalog.checksum_basis || "canonical_json" };
    }
    if (kind === "source") entry.checksum = catalog.checksum;
  };
  for (const publication of registry.publications || []) {
    const identityCorrection = sourceIdentityCorrections.get(publication.id);
    if (identityCorrection) {
      publication.name = identityCorrection.name;
      if (identityCorrection.displayName) {
        publication.display_name = identityCorrection.displayName;
      }
      if (identityCorrection.identityKind) {
        publication.metadata = {
          ...(publication.metadata || {}),
          identity_kind: identityCorrection.identityKind,
        };
      }
    }
    const mitreCatalog = mitreCatalogs.get(publication.id);
    if (mitreCatalog) syncMitreIdentity(publication, mitreCatalog, "publication");
    if (publication.id === "fedramp-rev5") publication.lifecycle_status = "historical";
    if (publication.id === "fedramp-2026-rules") {
      publication.graph_eligible = true;
      publication.eligibility_status = "eligible";
      publication.metadata = {
        ...(publication.metadata || {}),
        frameworks: ["fedramp-2026", "fedramp-20x", "fedramp-rev5"],
        identity_kind: "publication",
      };
      delete publication.metadata.canonical_publication_id;
    }
    if (publication.id === "nist-iot-device-cybersecurity-requirement-catalogs") {
      publication.metadata = {
        ...(publication.metadata || {}),
        provenance_note: "The official catalog page establishes publication identity. Indexed records were normalized from NIST's two draft mapping workbooks; Control Atlas does not claim an independent catalog extraction.",
      };
    }
    if (publication.id === "mitre-d3fend-ontology") {
      publication.metadata = {
        ...(publication.metadata || {}),
        provenance_note: "The official destination is mutable. Control Atlas binds version 1.5.0 to the committed ontology capture and its SHA-256 checksum.",
      };
    }
    if (publication.id === "dod-rai-toolkit") {
      publication.artifact_url = "https://www.ai.mil/Latest/Blog/Article-Display/Article/3940314/responsible-ai-toolkit/";
      publication.catalog_browse_url = publication.artifact_url;
      publication.metadata = {
        ...(publication.metadata || {}),
        provenance_note: "The official CDAO Responsible AI Toolkit article is canonical. Operational or secondary toolkit destinations are supporting links only.",
      };
    }
    const identityKind = publication.metadata?.identity_kind || "publication";
    publication.entity_kind = "publication";
    publication.profile_id = publicationProfileId(identityKind);
    publication.origin = identityKind === "editorial" ? "atlas_editorial" : "publisher_normalized";
  }
  for (const artifact of registry.artifacts || []) {
    const sourceId = artifact.id.replace(/^artifact-/, "");
    const mitreCatalog = mitreCatalogs.get(sourceId);
    if (mitreCatalog) syncMitreIdentity(artifact, mitreCatalog, "artifact");
    if (artifact.id === "artifact-fedramp-rev5") {
      artifact.lifecycle_status = "historical";
      artifact.source_role = "historical";
    }
    if (artifact.id === "artifact-fedramp-2026-rules") {
      artifact.source_role = "primary_data";
      artifact.record_count = fedramp2026.record_count;
    }
    if (artifact.id === "artifact-nist-iot-requirements-80053-mapping-draft") {
      artifact.publication_source_id = "nist-iot-requirements-80053-mapping-draft";
      artifact.source_role = "mapping";
      artifact.lifecycle_status = "draft";
    }
    if (artifact.id === "artifact-nist-iot-requirements-csf11-mapping-draft") {
      artifact.source_role = "mapping";
      artifact.lifecycle_status = "draft";
    }
    if (artifact.id === "artifact-mitre-d3fend-ontology") {
      artifact.metadata = {
        ...(artifact.metadata || {}),
        immutable_capture_path: "data/d3fend-countermeasures.json",
        version_binding: "The committed, checksummed ontology capture identifies publisher version 1.5.0.",
      };
    }
    if (artifact.id === "artifact-dod-rai-toolkit") {
      artifact.source_role = "reference_only";
      artifact.metadata = {
        ...(artifact.metadata || {}),
        provenance_note: "Supporting operational toolkit capture. The official ai.mil CDAO article is canonical for publication identity.",
      };
    }
    artifact.entity_kind = "artifact";
    if (artifact.lifecycle_status === "final") {
      artifact.metadata = { ...(artifact.metadata || {}), release_status: "final" };
      artifact.lifecycle_status = "active";
    }
    artifact.profile_id = artifactProfileId(artifact.format);
    artifact.origin = artifact.id === "artifact-dod-rai-toolkit"
      ? "publisher_derived"
      : artifact.authority_class === "publisher" ? "publisher_exact" : "publisher_normalized";
  }
  for (const source of registry.sources || []) {
    if (source.id === "nist-800-171-oscal-mappings") {
      source.display_name = "SP 800-171 Rev. 3 OSCAL Artifact";
    }
    const mitreCatalog = mitreCatalogs.get(source.id);
    if (mitreCatalog) syncMitreIdentity(source, mitreCatalog, "source");
    if (source.id === "fedramp-rev5") source.lifecycle_status = "historical";
    if (source.id === "dod-rai-toolkit") {
      const officialArtifact = registry.artifacts?.find((entry) => entry.id === "artifact-ai-mil-responsible-ai");
      source.artifact_url = "https://www.ai.mil/Latest/Blog/Article-Display/Article/3940314/responsible-ai-toolkit/";
      source.provenance_class = "control_atlas_derived";
      source.checksum = officialArtifact?.sha256 || source.checksum;
      source.retrieved_at = officialArtifact?.retrieved_at || source.retrieved_at;
      source.metadata = {
        ...(source.metadata || {}),
        provenance_note: "Catalog records are deterministic Atlas projections reconciled to the official CDAO Responsible AI Toolkit article; they are not verbatim publisher records.",
      };
    }
    source.entity_kind = "artifact";
    source.profile_id = artifactProfileId(source.artifact_type || "other");
    source.origin = source.provenance_class === "control_atlas_derived" ? "atlas_editorial" : "publisher_normalized";
  }
  for (const bundle of registry.catalog_source_bundles || []) {
    bundle.entity_kind = "assertion";
    bundle.profile_id = "assertion.source_bundle";
    bundle.origin = "atlas_editorial";
    if (bundle.catalog_id === "fedramp-rev5") {
      bundle.enrichment_artifact_ids = (bundle.enrichment_artifact_ids || [])
        .filter((id) => id !== "artifact-fedramp-2026-rules");
    }
    if (bundle.catalog_id === "nist-iot-cybersecurity") {
      bundle.primary_artifact_ids = [];
      bundle.mapping_source_ids = [
        "artifact-nist-iot-requirements-80053-mapping-draft",
        "artifact-nist-iot-requirements-csf11-mapping-draft",
      ];
      bundle.expected_inventory = {
        basis: "Unique NIST IoT catalog records normalized from the two publisher mapping workbooks and reconciled by exact record path. The catalog page supplies publication identity; the draft workbooks supply mapping data.",
        evidence_class: "publisher_mapping_inventory",
        primary_extraction_status: "not_performed",
        evidence_locator: "data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.iot.records",
        imported_evidence_locator: "data/curated/nist-structured-catalogs/source-manifest.json#reconciliation.iot.records",
        exclusions: [],
      };
    }
  }
  const fedrampBundle = {
    catalog_id: "fedramp-2026",
    publication_source_id: "fedramp-2026-rules",
    primary_artifact_ids: ["artifact-fedramp-2026-rules"],
    enrichment_artifact_ids: [],
    mapping_source_ids: [],
    assessment_source_ids: [],
    automation_source_ids: [],
    reconciliation_source_ids: [],
    expected_inventory: {
      basis: "Every native control-context, definition, rule, and key security indicator with publisher text in the official Consolidated Rules JSON.",
      evidence_class: "native_json_inventory",
      evidence_locator: "data/fedramp-2026-catalog.json#source_inventory.total",
      imported_evidence_locator: "data/fedramp-2026-catalog.json#record_count",
      exclusions: [],
    },
    entity_kind: "assertion",
    profile_id: "assertion.source_bundle",
    origin: "atlas_editorial",
  };
  const fedrampBundleIndex = (registry.catalog_source_bundles || []).findIndex((bundle) => bundle.catalog_id === "fedramp-2026");
  if (fedrampBundleIndex >= 0) registry.catalog_source_bundles[fedrampBundleIndex] = fedrampBundle;
  else registry.catalog_source_bundles.push(fedrampBundle);
  registry.catalog_source_bundles.sort((left, right) => left.catalog_id.localeCompare(right.catalog_id));
  // Reconciliation owns freshness hashes and check/import dates. Publisher
  // checksums and snapshot dates above describe identity, not refresh execution.
  return registry;
}

function removeCopiedDescriptions() {
  for (const path of duplicateDescriptionPaths) {
    const document = JSON.parse(readFileSync(path, "utf8"));
    for (const record of document.records || []) {
      if ((normalized(record.title) && normalized(record.title) === normalized(record.description))
        || atlasGeneratedDescriptions.has(normalized(record.description))) {
        delete record.description;
      }
    }
    writeJsonAtomically(path, document);
  }
}

function upgradeProfileRegistry() {
  const registry = JSON.parse(readFileSync(profilePath, "utf8"));
  registry.schema_version = "2.0";
  const predicates = [...new Set((registry.profiles || [])
    .filter((profile) => profile.entity_kind === "assertion" && profile.native_type !== "assertion")
    .map((profile) => profile.native_type))]
    .sort();
  const sourceTypesByKind = {
    organization: ["registry", "publication", "html"],
    publication: ["publication", "pdf", "html", "json", "xml"],
    artifact: ["api", "csv", "git", "html", "json", "json_ld", "oscal_json", "oscal_xml", "other", "pdf", "spreadsheet", "stix", "xccdf", "xml"],
    content_record: ["api", "csv", "html", "json", "json_ld", "oscal_json", "oscal_xml", "pdf", "spreadsheet", "stix", "xccdf", "xml"],
    resource: ["api", "git", "html", "publication"],
    assertion: ["editorial", "graph", "structured_mapping"],
  };
  const titleFieldByKind = {
    organization: "title",
    publication: "title",
    artifact: "title",
    content_record: "title",
    resource: "name",
    assertion: "predicate",
  };
  for (const profile of registry.profiles || []) {
    if (profile.parent_profile_id) continue;
    profile.prohibited_fields ||= [];
    profile.conditional_fields ||= profile.entity_kind === "resource"
      ? [{ field: "supersededBy", when_field: "maintenanceStatus", operator: "equals", value: "superseded" }]
      : [];
    profile.field_origins ||= Object.fromEntries((profile.required_fields || []).map((field) => [field, profile.allowed_origins || registry.origin_classes]));
    profile.evidence_rules ||= Object.fromEntries((profile.evidence_required_fields || []).map((field) => [field, {
      required: true,
      locator_types: ["artifact_path", "captured_fragment", "canonical_url", "heading_path", "object_path", "page_fragment", "publisher_product_record", "repository_commit", "spreadsheet_cell"],
    }]));
    profile.lifecycle_rules ||= {
      allowed_statuses: registry.lifecycle_statuses,
      replacement_requires_evidence: true,
    };
    profile.source_expectations ||= {
      accepted_source_types: sourceTypesByKind[profile.entity_kind],
      parser_required: !["organization", "resource"].includes(profile.entity_kind),
      failure_policy: ["resource", "organization"].includes(profile.entity_kind) ? "omit_optional_fields" : "fail_closed",
    };
    profile.search_presentation ||= {
      title_field: titleFieldByKind[profile.entity_kind],
      subtitle_fields: profile.entity_kind === "assertion" ? ["authority"] : ["publisher_id", "profile_id"],
      filter_fields: ["entity_kind", "profile_id", "publisher_id", "lifecycle.status"],
      badge_fields: ["lifecycle.status", "origin"],
    };
    profile.display_rules ||= { omit_empty_sections: true, label_atlas_content: true };
    profile.allowed_incoming_predicates ||= predicates;
    profile.allowed_outgoing_predicates ||= predicates;
    profile.validation ||= { severity: "error", review_required: profile.entity_kind === "resource" };
  }
  const resourceBase = registry.profiles.find((profile) => profile.profile_id === "resource.base");
  if (resourceBase) {
    resourceBase.required_fields = ["id", "name", "canonicalUrl", "publisher", "resourceType", "sourceEvidence"];
    resourceBase.optional_fields = [...new Set([
      ...(resourceBase.optional_fields || []),
      "summary", "whyIncluded", "cardPurpose", "accessType", "costType", "maintenanceStatus", "repositoryUrl", "license", "publicAccessNotes", "officialStatus", "maturity", "currentVersion", "publisherUpdatedAt", "lastReleaseAt", "lastCommitAt", "supersededBy",
    ])];
    resourceBase.evidence_required_fields = ["name", "canonicalUrl", "publisher", "accessType", "costType", "maintenanceStatus", "supersededBy"];
  }
  writeJsonAtomically(profilePath, registry);
}

function buildOrganizations() {
  const resources = JSON.parse(readFileSync(resourcePath, "utf8")).resources || [];
  const sources = JSON.parse(readFileSync(sourcePath, "utf8"));
  const organizations = new Map();
  const add = (title, sourceRef) => {
    const clean = String(title || "").trim();
    if (!clean) return;
    const id = `organization.${clean.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;
    const existing = organizations.get(id) || { title: clean, source_refs: new Set() };
    if (sourceRef) existing.source_refs.add(sourceRef);
    organizations.set(id, existing);
  };
  for (const publication of sources.publications || []) add(publication.owner, publication.id);
  for (const resource of resources) add(resource.publisher, `resource:${resource.id}:publisher-destination`);
  const entities = [...organizations.entries()].map(([id, entry]) => ({
    schema_version: "1.0",
    id,
    entity_kind: "organization",
    profile_id: "organization.base",
    title: entry.title,
    lifecycle: { status: "unknown", evidence_refs: [] },
    source_refs: [...entry.source_refs].sort(),
    origin: "publisher_normalized",
    payload: {},
    operational: {
      retrieved_at: null,
      checked_at: null,
      parser_id: "source-truth-organization-index",
      parser_version: "1.0.0",
      review_status: "reviewed",
    },
  })).sort((left, right) => left.id.localeCompare(right.id));
  writeJsonAtomically(organizationPath, { schema_version: "1.0", organizations: entities });
}

function upgradeAdapterRegistry() {
  const registry = JSON.parse(readFileSync(adapterPath, "utf8"));
  registry.schema_version = "2.0";
  const catalogsByAdapter = {
    "fedramp-consolidated-rules-json": ["fedramp-2026"],
    "fedramp-rev5-workbook": ["fedramp-rev5"],
    "mitre-attack-stix": ["mitre-attack", "mitre-attack-ics"],
    "mitre-d3fend-json-ld": ["mitre-d3fend"],
    "nist-oscal-profile": ["nist-800-53b"],
    "nist-iot-capability-workbooks": ["nist-iot-cybersecurity"],
    "nist-800-171-172-oscal": ["nist-800-171", "nist-800-171-rev2", "nist-800-172"],
    "github-resource-evidence": [],
    "disa-product-resource": [],
  };
  for (const adapter of registry.adapters || []) adapter.catalog_ids = catalogsByAdapter[adapter.adapter_id] || adapter.catalog_ids || [];
  const fedrampRulesAdapter = (registry.adapters || [])
    .find((adapter) => adapter.adapter_id === "fedramp-consolidated-rules-json");
  if (fedrampRulesAdapter) {
    fedrampRulesAdapter.produced_profile_ids = [
      "record.control_context",
      "record.definition",
      "record.key_security_indicator",
      "record.rule",
    ];
  }
  const additions = [
    {
      adapter_id: "fedramp-rev5-workbook",
      adapter_version: "1.0.0",
      catalog_ids: ["fedramp-rev5"],
      accepted_source_types: ["spreadsheet"],
      produced_profile_ids: ["record.baseline"],
      field_transformations: ["preserve legacy baseline identifiers and control membership without treating the workbook as current rules"],
      relationship_rules: ["transition relationships to the Consolidated Rules remain Atlas-authored assertions with explicit evidence"],
      fixture_set: "tests/fedramp-transition.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "The Rev. 5 workbook is historical transition material and is never the primary artifact for current FedRAMP rules.",
    },
    {
      adapter_id: "nist-oscal-catalog",
      adapter_version: "2.0.0",
      catalog_ids: ["csf-2", "nist-800-53", "nist-800-53a", "nist-ssdf"],
      accepted_source_types: ["oscal_json"],
      produced_profile_ids: ["record.control", "record.control_enhancement", "record.assessment_procedure", "record.category", "record.function", "record.requirement"],
      field_transformations: ["preserve publisher identifiers, hierarchy, prose, parameters, and source paths"],
      relationship_rules: ["publisher OSCAL containment remains structural; published mappings retain artifact locators"],
      fixture_set: "tests/oscal-normalize.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "Validate publisher OSCAL before projection; omit absent optional prose.",
    },
    {
      adapter_id: "disa-xccdf-cci",
      adapter_version: "2.0.0",
      catalog_ids: ["disa-cci", "disa-srg", "disa-stig"],
      accepted_source_types: ["xccdf", "xml"],
      produced_profile_ids: ["record.benchmark", "record.srg_requirement", "record.stig_rule", "record.requirement"],
      field_transformations: ["decode XCCDF and CCI text as UTF-8", "preserve benchmark, rule, check, fix, release, and package boundaries"],
      relationship_rules: ["CCI references and benchmark containment retain publisher locators"],
      fixture_set: "tests/disa-stig-importer.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "A successful compilation does not assert publisher completeness.",
    },
    {
      adapter_id: "atlas-reviewed-publication-projection",
      adapter_version: "2.0.0",
      catalog_ids: ["cmmc-2", "cui-policy", "dod-rai", "fips-199", "fips-200", "nist-800-37"],
      accepted_source_types: ["html", "pdf", "publication"],
      produced_profile_ids: ["record.baseline", "record.category", "record.impact_category", "record.policy", "record.requirement", "record.rmf_step"],
      field_transformations: ["project reviewed source fragments into concise Atlas records labeled publisher-derived"],
      relationship_rules: ["only explicit publisher relationships are published mappings; Atlas organization remains navigation"],
      fixture_set: "tests/data-trust-contracts.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "Never present Atlas-authored summaries as verbatim publisher text.",
    },
    {
      adapter_id: "zero-trust-source-family",
      adapter_version: "2.0.0",
      catalog_ids: ["dod-zt", "microsoft-zt-maturity", "nist-zt"],
      accepted_source_types: ["html", "pdf", "spreadsheet"],
      produced_profile_ids: ["record.zt_activity", "record.zt_assessment_question", "record.zt_build", "record.zt_capability", "record.zt_document", "record.zt_pillar", "record.zt_tenet"],
      field_transformations: ["preserve source-specific hierarchy and precise page, table, cell, or heading locators"],
      relationship_rules: ["mapping workbook assertions remain publisher-derived and source-scoped"],
      fixture_set: "tests/zero-trust-workbook-adapter.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "Each publisher remains a separate publication and authority boundary.",
    },
    {
      adapter_id: "nist-ai-rmf-playbook",
      adapter_version: "2.0.0",
      catalog_ids: ["nist-ai-rmf"],
      accepted_source_types: ["json"],
      produced_profile_ids: ["record.requirement"],
      field_transformations: ["preserve playbook action identity and publisher category structure"],
      relationship_rules: [],
      fixture_set: "tests/record-taxonomy.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "AI RMF records map to the AI RMF taxonomy, never the CSF taxonomy.",
    },
    {
      adapter_id: "nist-mobile-threat-catalog",
      adapter_version: "2.0.0",
      catalog_ids: ["nist-mobile-threats"],
      accepted_source_types: ["csv", "json"],
      produced_profile_ids: ["record.mobile_threat", "record.mobile_threat_category"],
      field_transformations: ["preserve publisher title and structured threat fields without generated descriptions"],
      relationship_rules: [],
      fixture_set: "tests/nist-structured-catalog-adapter.test.mjs",
      failure_policy: "fail_closed",
      source_policy: "Title-only entries remain title-only.",
    },
  ];
  const byId = new Map((registry.adapters || []).map((adapter) => [adapter.adapter_id, adapter]));
  for (const adapter of additions) byId.set(adapter.adapter_id, adapter);
  registry.adapters = [...byId.values()].sort((left, right) => left.adapter_id.localeCompare(right.adapter_id));
  writeJsonAtomically(adapterPath, registry);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  migrateResources();
  migrateSourceRegistry();
  removeCopiedDescriptions();
  upgradeProfileRegistry();
  buildOrganizations();
  upgradeAdapterRegistry();
  console.log("Migrated resource and source inventories to explicit entity profiles.");
}
