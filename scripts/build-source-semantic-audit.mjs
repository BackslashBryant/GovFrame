#!/usr/bin/env node

// This report deliberately keeps structural reconciliation separate from a
// semantic-review verdict. A parser can prove counts and declared containment;
// it cannot prove that a terse publisher record contains all the context a
// practitioner wants. Keeping the latter explicit prevents green ingestion
// gates from being misread as a completed source-content audit.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { CATALOG_STRUCTURE_PROFILES } from "../src/shared/catalog-structure.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const readJson = (path) => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

const coverage = readJson("data/source-coverage-manifest.json");
const inventory = readJson("data/generated/catalog-source-inventory.json");
const ledger = readJson("data/generated/source-count-ledger.json");
const sourceRegister = readJson("data/generated/sources.json").sources;
const reviewManifest = readJson("data/source-review-manifest.json");
const reviewSchema = readJson("data/schemas/source-review-manifest.schema.json");
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const validateReviewManifest = ajv.compile(reviewSchema);

if (!validateReviewManifest(reviewManifest)) {
  throw new Error(`Invalid source review manifest: ${ajv.errorsText(validateReviewManifest.errors)}`);
}

const reviewByCatalog = new Map();
for (const review of reviewManifest.catalogs) {
  if (reviewByCatalog.has(review.catalog_id)) {
    throw new Error(`Duplicate source review catalog: ${review.catalog_id}`);
  }
  if (review.representative_samples.length < reviewManifest.review_policy.minimum_samples_per_catalog) {
    throw new Error(`Insufficient source review samples for ${review.catalog_id}`);
  }
  reviewByCatalog.set(review.catalog_id, review);
}

const coveredCatalogIds = new Set(coverage.catalogs.map((entry) => entry.catalog_id));
const reviewedCatalogIds = new Set(reviewByCatalog.keys());
const missingReviews = [...coveredCatalogIds].filter((catalogId) => !reviewedCatalogIds.has(catalogId));
const extraReviews = [...reviewedCatalogIds].filter((catalogId) => !coveredCatalogIds.has(catalogId));
if (missingReviews.length || extraReviews.length) {
  throw new Error(
    `Source review coverage mismatch; missing=[${missingReviews.join(", ")}], extra=[${extraReviews.join(", ")}]`,
  );
}
const sourcesByCatalog = new Map();

for (const source of sourceRegister) {
  for (const catalogId of source.metadata?.frameworks || []) {
    const entries = sourcesByCatalog.get(catalogId) || [];
    entries.push({
      source_id: source.id,
      display_name: source.display_name || source.name,
      version: source.version || null,
      retrieved_at: source.retrieved_at || null,
      last_checked: source.last_checked || null,
      artifact_url: source.artifact_url || null,
      checksum: source.hash || source.checksum || null,
      parser: source.metadata?.parser || null,
    });
    sourcesByCatalog.set(catalogId, entries);
  }
}

const auditRows = coverage.catalogs.map((entry) => {
  const catalogId = entry.catalog_id;
  const structuralProfile = CATALOG_STRUCTURE_PROFILES[catalogId];
  const sourceInventory = inventory.catalogs[catalogId];
  const review = reviewByCatalog.get(catalogId);
  const counts = ledger.catalogs[catalogId]?.counts || {};
  const sourceEntries = (sourcesByCatalog.get(catalogId) || [])
    .sort((left, right) => left.source_id.localeCompare(right.source_id));
  const countReconciled =
    entry.completeness_status === "reconciled" &&
    entry.expected_records === entry.imported_records + entry.excluded_records &&
    entry.missing_records === 0 &&
    sourceInventory?.unique_record_ids === sourceInventory?.normalized_records;
  const normalizedSource = readJson(sourceInventory.source_file);
  const normalizedRecords = normalizedSource.records;
  const normalizedById = new Map(normalizedRecords.map((record) => [record.id, record]));
  const representativeSamples = review.representative_samples.map((sample) => {
    const record = normalizedById.get(sample.record_id);
    if (!record) {
      throw new Error(`Reviewed sample ${catalogId}/${sample.record_id} is absent from ${sourceInventory.source_file}`);
    }
    return {
      record_id: sample.record_id,
      source_key: record.source?.key || normalizedSource.source_key || null,
      source_locator: record.source?.locator || record.locator || null,
      review_note: sample.review_note,
    };
  });

  return {
    catalog_id: catalogId,
    automated_evidence: {
      status: countReconciled ? "reconciled" : "attention_required",
      expected_records: entry.expected_records,
      imported_records: entry.imported_records,
      excluded_records: entry.excluded_records,
      exclusions: entry.exclusions,
      missing_records: entry.missing_records,
      source_inventory: sourceInventory || null,
      published_source_relationships: counts.published_source_relationships || 0,
      graph_nodes: counts.graph_nodes || 0,
      graph_edges_incident: counts.graph_edges_incident || 0,
    },
    declared_publisher_structure: structuralProfile
      ? {
          containment_paths: structuralProfile.paths,
          multi_parent_node_types: structuralProfile.multiParentNodeTypes,
          classification: "publisher_native_containment_only",
        }
      : null,
    publisher_artifacts: sourceEntries,
    evidence_boundary: {
      reviewed_at: review.reviewed_at,
      semantic_content_review: review.semantic_content_review,
      locator_only_review: review.locator_only_review,
      upstream_currentness_review: review.upstream_currentness_review,
      representative_samples: representativeSamples,
      official_sources: review.official_sources,
      rationale: review.rationale,
      follow_up: review.follow_up,
      statement:
        "Automated reconciliation and the recorded human review are separate evidence classes. The review covers the named samples and currentness sources; it is not a claim that automation proved semantic completeness or that every publisher record was manually re-authored.",
    },
  };
});

const report = {
  schema_version: "2.0",
  generated_from: {
    source_coverage_manifest: coverage.generated_at,
    catalog_source_inventory: inventory.generated_at,
    source_count_ledger: ledger.generated_at,
  },
  purpose:
    "Per-catalog audit boundary for publisher structure, parser reconciliation, artifact provenance, representative semantic review, locator disposition, and official-source currentness review.",
  catalog_count: auditRows.length,
  catalogs: auditRows,
};

mkdirSync(join(ROOT, "data/generated"), { recursive: true });
writeFileSync(
  join(ROOT, "data/generated/source-semantic-audit.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  "utf8",
);
console.log(`source-semantic-audit: ${auditRows.length} catalog boundaries recorded.`);
