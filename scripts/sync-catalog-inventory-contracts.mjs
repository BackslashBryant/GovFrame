#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { NATIVE_INVENTORIES, PUBLISHER_INVENTORY_CATALOGS, readNativeInventory } from './build-catalog-source-inventory.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const path = join(ROOT, 'data/source-registry.json');
export function synchronizeCatalogInventoryContracts(input, nativeInventories = {}) {
  const registry = structuredClone(input);
  const supported = new Set(PUBLISHER_INVENTORY_CATALOGS);
  for (const bundle of registry.catalog_source_bundles || []) {
    const root = `data/generated/catalog-source-inventory.json#catalogs.${bundle.catalog_id}`;
    const native = NATIVE_INVENTORIES[bundle.catalog_id];
    if (native) {
      const excluded = nativeInventories[bundle.catalog_id]?.excluded_count ??
        (bundle.expected_inventory?.exclusions || []).reduce((sum, entry) => sum + entry.count, 0);
      if (native.excludedField && !nativeInventories[bundle.catalog_id] && !bundle.expected_inventory?.exclusions?.length) {
        throw new Error(`${bundle.catalog_id} requires native exclusion evidence`);
      }
      bundle.expected_inventory = {
        ...bundle.expected_inventory,
        basis: bundle.expected_inventory?.basis?.includes('Tracked reviewed snapshot')
          ? 'Native publisher or curated extraction manifest count, reconciled against actual normalized catalog records with explicit exclusions.'
          : bundle.expected_inventory?.basis || 'Native publisher or curated extraction manifest count, reconciled against actual normalized catalog records with explicit exclusions.',
        evidence_class: native.evidenceClass || 'native_manifest',
        evidence_locator: `${native.file}#${native.field}`,
        imported_evidence_locator: `${root}.normalized_records`,
        exclusions: native.excludedField
          ? [{ count: excluded, reason: native.exclusionReason }]
          : [],
      };
      continue;
    }
    bundle.expected_inventory = {
      basis: supported.has(bundle.catalog_id)
        ? 'Eligible publisher identities from an independently reconciled raw inventory when present. Accepted older snapshots explicitly use tracked reviewed counts; the inventory entry declares which evidence applies.'
        : 'Tracked reviewed snapshot count. This is a regression expectation, not independently established publisher completeness.',
      evidence_class: supported.has(bundle.catalog_id) ? 'publisher_inventory_or_reviewed_snapshot' : 'reviewed_snapshot',
      evidence_locator: `${root}.discovered_records`,
      imported_evidence_locator: `${root}.normalized_records`,
      exclusions: [],
    };
  }

  const byId = new Map((registry.artifacts || []).map((artifact) => [artifact.id, artifact]));
  const structure = byId.get('artifact-control-atlas-structure');
  if (structure) {
    structure.source_role = 'editorial';
    structure.metadata = {
      ...(structure.metadata || {}),
      pipeline_scope: 'governance',
      pipeline_scope_reason: 'Product-authored organizing structure is verified as governance evidence and is not a publisher catalog source.',
    };
  }

  const addMapping = (catalogId, artifactId) => {
    const bundle = (registry.catalog_source_bundles || []).find((entry) => entry.catalog_id === catalogId);
    if (!bundle || !byId.has(artifactId)) return;
    if (!bundle.mapping_source_ids.includes(artifactId)) bundle.mapping_source_ids.push(artifactId);
    bundle.mapping_source_ids.sort();
  };
  addMapping('nist-800-53', 'artifact-nist-csf-53-supplemental');
  addMapping('csf-2', 'artifact-nist-csf11-csf20-crosswalk');
  return registry;
}

if (process.argv[1]?.includes('sync-catalog-inventory-contracts.mjs')) {
  const nativeInventories = Object.fromEntries(Object.keys(NATIVE_INVENTORIES).map((id) => [id, readNativeInventory(ROOT, id)]));
  const registry = synchronizeCatalogInventoryContracts(JSON.parse(readFileSync(path, 'utf8')), nativeInventories);
  writeJsonAtomically(path, registry);
  console.log(`Synchronized inventory contracts for ${registry.catalog_source_bundles.length} catalogs.`);
}
