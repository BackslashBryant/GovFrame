#!/usr/bin/env node
// Build the source-side catalog inventory before graph construction. This is
// deliberately separate from generated graph counts: a graph cannot certify
// that its own importer was complete.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedAt } from './lib/stable-generated-at.mjs';
import { observeCatalog } from './lib/source-baseline.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/generated/catalog-source-inventory.json');

export const PROFILES = Object.freeze({
  'cmmc-2': { file: 'data/cmmc-practices.json' },
  'csf-2': { file: 'data/csf-subcategories.json' },
  'cui-policy': { file: 'data/cui-policy.json' },
  'disa-cci': { file: 'data/ccis.json' },
  'disa-srg': { file: 'data/srg-requirements.json' },
  'disa-stig': { file: 'data/stig-rules.json' },
  'dod-rai': { file: 'data/dod-rai.json' },
  'dod-zt': { file: 'data/dod-zt.json' },
  'fedramp-rev5': { file: 'data/fedramp-baselines.json' },
  'fedramp-2026': { file: 'data/fedramp-2026-catalog.json' },
  'fips-199': { file: 'data/fips-199.json' },
  'fips-200': { file: 'data/fips-200.json' },
  'microsoft-zt-maturity': { file: 'data/microsoft-zt-maturity.json' },
  'mitre-attack': { file: 'data/attack-techniques-enterprise.json' },
  'mitre-attack-ics': { file: 'data/attack-techniques-ics.json' },
  'mitre-d3fend': { file: 'data/d3fend-countermeasures.json' },
  'nist-800-171': { file: 'data/requirements-800-171.json' },
  'nist-800-171-rev2': { file: 'data/requirements-800-171-rev2.json' },
  'nist-800-172': { file: 'data/requirements-800-172.json' },
  'nist-800-37': { file: 'data/tasks-800-37.json' },
  'nist-800-53': { file: 'data/controls-800-53.json' },
  'nist-800-53a': {
    file: 'data/controls-800-53.json',
    select: (record) => Boolean(record.metadata?.assessment),
    selection: 'records carrying publisher assessment procedure metadata',
    reviewedSubsetCount: 1014,
  },
  'nist-800-53b': { file: 'data/800-53b-baselines.json' },
  'nist-ai-rmf': { file: 'data/ai-rmf.json' },
  'nist-iot-cybersecurity': { file: 'data/nist-iot-cybersecurity.json' },
  'nist-mobile-threats': { file: 'data/nist-mobile-threats.json' },
  'nist-ssdf': { file: 'data/ssdf.json' },
  'nist-zt': { file: 'data/nist-zt.json' },
});

export const PUBLISHER_INVENTORY_CATALOGS = Object.freeze([
  'csf-2', 'disa-cci', 'fedramp-2026', 'mitre-attack', 'mitre-attack-ics', 'mitre-d3fend',
  'nist-800-171', 'nist-800-171-rev2', 'nist-800-172', 'nist-800-53', 'nist-ai-rmf', 'nist-ssdf',
]);

export const NATIVE_INVENTORIES = Object.freeze({
  'disa-srg': { file: 'data/disa-artifact-manifest.json', field: 'reconciliation.srg_records_parsed' },
  'disa-stig': { file: 'data/disa-artifact-manifest.json', field: 'reconciliation.stig_records_parsed' },
  'dod-zt': { file: 'data/curated/dod-zt/source-manifest.json', field: 'reconciliation.atlas_records_expected', reviewedCount: 320 },
  'microsoft-zt-maturity': { file: 'data/curated/nist-zt/structured-source-manifest.json', field: 'reconciliation.questionnaire_records' },
  'nist-iot-cybersecurity': { file: 'data/curated/nist-structured-catalogs/source-manifest.json', field: 'reconciliation.iot.records', evidenceClass: 'publisher_mapping_inventory' },
  'nist-mobile-threats': {
    file: 'data/curated/nist-structured-catalogs/source-manifest.json',
    field: 'reconciliation.mobile_threats.expected_records',
    excludedField: 'reconciliation.mobile_threats.blank_rows_excluded',
    exclusionReason: 'Publisher JSON entries contain no threat ID, category, title, or content.',
  },
});

export function resolveNativeInventory(catalogId, manifest) {
  const profile = NATIVE_INVENTORIES[catalogId];
  if (!profile) return null;
  const field = (path) => path.split('.').reduce((value, key) => value?.[key], manifest);
  const expected = field(profile.field);
  const excluded = profile.excludedField ? field(profile.excludedField) : 0;
  if (!Number.isSafeInteger(expected) || expected < 1 || !Number.isSafeInteger(excluded) || excluded < 0 || excluded >= expected) {
    throw new Error(`Invalid native inventory count for ${catalogId}`);
  }
  if (profile.reviewedCount !== undefined && expected !== profile.reviewedCount) {
    throw new Error(`${catalogId} curated inventory must retain the reviewed ${profile.reviewedCount} records`);
  }
  return { expected_count: expected, excluded_count: excluded, evidence_locator: `${profile.file}#${profile.field}` };
}

/** Resolve native count evidence before accepting any source transaction. */
export function readNativeInventory(root, catalogId) {
  const profile = NATIVE_INVENTORIES[catalogId];
  return profile ? resolveNativeInventory(catalogId, JSON.parse(readFileSync(join(root, profile.file), 'utf8'))) : null;
}

/** Preserve publisher identity, native manifest, and reviewed snapshot count boundaries. */
export function buildInventory(document, baseline, options = {}) {
  const observed = observeCatalog(Buffer.from(JSON.stringify(document)));
  if (!observed.record_count) throw new Error('Empty normalized catalog inventory');
  if (options.nativeInventory) {
    const native = options.nativeInventory;
    const eligible = native.expected_count - native.excluded_count;
    if (!Number.isSafeInteger(eligible) || eligible < 1 || eligible !== observed.record_count) {
      throw new Error(`Native source inventory mismatch: expected ${eligible}, imported ${observed.record_count}`);
    }
    return {
      discovered_records: native.expected_count,
      normalized_records: observed.record_count,
      unique_record_ids: observed.record_count,
      raw_records: native.expected_count,
      excluded_records: native.excluded_count,
      evidence_locator: native.evidence_locator,
      evidence_class: 'native_manifest',
      independent_inventory: false,
      evidence_reason: 'Retained native publisher or curated extraction count boundary; count reconciliation does not assert an independent identity inventory',
    };
  }
  const proof = document.publisher_inventory;
  if (proof) {
    if (!Number.isSafeInteger(proof.raw_count) || proof.raw_count < proof.eligible_count ||
        !Number.isSafeInteger(proof.eligible_count) || proof.eligible_count < 1 ||
        !Array.isArray(proof.excluded) || proof.raw_count - proof.eligible_count !== proof.excluded.length ||
        proof.excluded.some((entry) => typeof entry.id !== 'string' || !entry.id || typeof entry.reason !== 'string' || !entry.reason) ||
        !/^sha256:[a-f0-9]{64}$/.test(proof.raw_identity_sha256)) {
      throw new Error('Invalid publisher inventory evidence');
    }
    return {
      discovered_records: proof.eligible_count,
      normalized_records: observed.record_count,
      unique_record_ids: observed.record_count,
      raw_records: proof.raw_count,
      exclusions: proof.excluded,
      evidence_class: 'publisher_inventory',
      independent_inventory: true,
    };
  }
  if (options.requirePublisherInventory) throw new Error('Fresh candidate requires publisher inventory evidence');
  const reviewed = options.reviewedSubsetCount ?? baseline?.anchor?.record_count;
  if (!Number.isSafeInteger(reviewed) || reviewed < 1) throw new Error('Missing reviewed source inventory baseline');
  if (observed.record_count !== reviewed) throw new Error(`Reviewed source inventory mismatch: expected ${reviewed}, imported ${observed.record_count}`);
  return {
    discovered_records: reviewed,
    normalized_records: observed.record_count,
    unique_record_ids: observed.record_count,
    raw_records: null,
    exclusions: [],
    evidence_class: 'reviewed_snapshot',
    independent_inventory: false,
    evidence_reason: 'Expected count comes from the tracked reviewed snapshot; raw publisher completeness is not established',
  };
}

export function buildCatalogSourceInventory() {
  const baselines = JSON.parse(readFileSync(join(ROOT, 'data/source-baselines.json'), 'utf8'));
  const catalogs = {};
  const documents = new Map();
  for (const [catalogId, profile] of Object.entries(PROFILES)) {
    if (!documents.has(profile.file)) documents.set(profile.file, JSON.parse(readFileSync(join(ROOT, profile.file), 'utf8')));
    const source = documents.get(profile.file);
    const document = profile.select ? { records: source.records.filter(profile.select) } : source;
    catalogs[catalogId] = {
      source_file: profile.file,
      source_selection: profile.selection || 'all normalized publisher records',
      ...buildInventory(document, baselines.catalogs[catalogId], {
        reviewedSubsetCount: profile.reviewedSubsetCount,
        nativeInventory: readNativeInventory(ROOT, catalogId),
      }),
    };
  }
  return {
    schema_version: '1.0',
    generated_at: generatedAt(),
    count_boundary: 'Publisher identity inventory, retained native manifest counts with explicit exclusions, or labeled tracked reviewed snapshot counts. Normalized and graph counts never establish publisher completeness.',
    catalogs,
  };
}

if (process.argv[1]?.includes('build-catalog-source-inventory.mjs')) {
  const inventory = buildCatalogSourceInventory();
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
  console.log(`catalog-source-inventory: ${Object.keys(inventory.catalogs).length} catalogs reconciled before graph construction.`);
}
