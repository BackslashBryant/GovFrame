import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { INGESTION_TASKS } from '../scripts/lib/ingestion-pipeline.mjs';
import { syncCatalogSourceBundles } from '../scripts/sync-catalog-source-bundles.mjs';

import { artifactHash, reconcileFreshness } from '../scripts/reconcile-source-freshness.mjs';

test('artifact hashes ignore refresh timestamps but retain substantive changes', () => {
  const first = { snapshot_date: '2026-01-01', records: [{ id: 'A', title: 'Alpha' }] };
  const later = { snapshot_date: '2026-07-16', records: [{ id: 'A', title: 'Alpha' }] };
  const changed = { snapshot_date: '2026-07-16', records: [{ id: 'A', title: 'Beta' }] };
  assert.equal(artifactHash(first), artifactHash(later));
  assert.notEqual(artifactHash(first), artifactHash(changed));
});

test('reconciliation separates checked dates, imported dates, and link observations', () => {
  const unchangedArtifact = { source_version: '1', records: [{ id: 'A' }] };
  const existingHash = artifactHash([unchangedArtifact]);
  const registry = {
    sources: [{ id: 'auto', version: '1' }, { id: 'changed', version: '1' }, { id: 'link', version: 'current' }],
    freshness: { sources: [
      { source_id: 'auto', sync_model: 'auto_synced', last_checked: '2026-07-01', last_imported: '2026-07-01', hash: existingHash },
      { source_id: 'changed', sync_model: 'auto_synced', last_checked: '2026-07-01', last_imported: '2026-07-01', hash: null },
      { source_id: 'link', sync_model: 'link_out', last_checked: '2026-07-01', last_imported: null, hash: null },
    ] },
  };
  const artifacts = new Map([
    ['auto', [unchangedArtifact]],
    ['changed', [{ source_version: '2', records: [{ id: 'B' }] }]],
  ]);
  reconcileFreshness(registry, artifacts, '2026-07-16', ['link']);
  assert.equal(registry.freshness.sources[0].last_checked, '2026-07-16');
  assert.equal(registry.freshness.sources[0].last_imported, '2026-07-01');
  assert.equal(registry.freshness.sources[1].last_imported, '2026-07-16');
  assert.equal(registry.sources[1].version, '2');
  assert.equal(registry.freshness.sources[2].last_checked, '2026-07-16');
  assert.equal(registry.freshness.sources[2].last_imported, null);
});

test('reconciliation keeps publication, source, and primary-artifact versions aligned', () => {
  const registry = {
    publications: [{ id: 'attack', version: '1', retrieved_at: '2026-07-01' }],
    sources: [{ id: 'attack', version: '1', retrieved_at: '2026-07-01' }],
    artifacts: [{ id: 'artifact-attack', publication_source_id: 'attack', version: '1', retrieved_at: '2026-07-01' }],
    freshness: { sources: [{ source_id: 'attack', sync_model: 'auto_synced', last_checked: '2026-07-01', last_imported: '2026-07-01', hash: null }] },
  };
  reconcileFreshness(registry, new Map([['attack', [{ source_version: '2', records: [{ id: 'A' }] }]]]), '2026-07-16');
  assert.equal(registry.publications[0].version, '2');
  assert.equal(registry.sources[0].version, '2');
  assert.equal(registry.artifacts[0].version, '2');
  assert.equal(registry.publications[0].retrieved_at, '2026-07-16');
});

test('bundle sync runs before the generator that creates its input, so it must tolerate absence', () => {
  // Regression guard for the 2026-09-09 refresh outage (run 34371450147):
  // sync-catalog-source-bundles read data/generated/catalog-records with a bare
  // readdirSync and aborted the refresh with ENOENT. data/generated is
  // gitignored, and the directory is produced by build-framework-data, which
  // runs LATER in the pipeline -- so on a clean runner the input cannot exist
  // and "none yet" is the correct answer.
  const ids = INGESTION_TASKS.map((task) => task.id);
  const sync = ids.indexOf('sync-source-bundles');
  const generator = ids.indexOf('build-framework-data');
  assert.ok(sync >= 0 && generator >= 0, 'both tasks must exist in the pipeline');
  assert.ok(
    sync < generator,
    'sync-source-bundles still precedes build-framework-data; if this ever flips, the '
      + 'absent-directory guard in catalogIds() can be revisited',
  );

  // The guard must never prune: `known` is seeded from the committed registry,
  // so a run that finds no generated records leaves every existing bundle in place.
  const registry = JSON.parse(readFileSync(new URL('../data/source-registry.json', import.meta.url), 'utf8'));
  const before = registry.catalog_source_bundles.length;
  assert.equal(syncCatalogSourceBundles(registry).catalog_source_bundles.length, before);
});
