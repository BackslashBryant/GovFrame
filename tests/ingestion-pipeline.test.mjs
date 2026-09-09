import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  INGESTION_STAGES,
  INGESTION_TASKS,
  validateIngestionPipelineDefinition,
} from '../scripts/lib/ingestion-pipeline.mjs';
import { preserveGeneratedAt } from '../scripts/lib/stable-generated-at.mjs';
import { DELTA_REASONS } from '../scripts/lib/delta-reasons.mjs';

test('generated ingestion ledgers use the reproducible build timestamp', () => {
  const path = 'data/generated/ingestion-stage-ledger.json';
  const previous = JSON.parse(readFileSync(path, 'utf8'));
  const next = { ...previous, generated_at: '2099-01-01T00:00:00.000Z' };
  const original = process.env.CONTROL_ATLAS_GENERATED_AT;
  process.env.CONTROL_ATLAS_GENERATED_AT = '2030-01-02T03:04:05.000Z';
  try {
    assert.equal(preserveGeneratedAt(path, next).generated_at, '2030-01-02T03:04:05.000Z');
    next.status = 'FAILED';
    assert.equal(preserveGeneratedAt(path, next).generated_at, '2030-01-02T03:04:05.000Z');
  } finally {
    if (original === undefined) delete process.env.CONTROL_ATLAS_GENERATED_AT;
    else process.env.CONTROL_ATLAS_GENERATED_AT = original;
  }
});

test('every source uses one complete ingestion lifecycle with explicit presentation', () => {
  assert.deepEqual(validateIngestionPipelineDefinition(), []);
  assert.deepEqual(INGESTION_STAGES, [
    'discover', 'acquire', 'attest', 'parse', 'normalize',
    'structure', 'relationships', 'presentation', 'reconcile', 'publish',
  ]);
  assert.ok(INGESTION_TASKS.some((task) => task.stages.includes('presentation')));
  assert.deepEqual(
    INGESTION_TASKS.find((task) => task.id === 'enrich-commons-resources')?.args,
    ['--refresh'],
  );
  assert.ok(INGESTION_TASKS.filter((task) => task.stages.includes('parse'))
    .every((task) => task.stages.includes('acquire') || task.id === 'extract-dod-zero-trust'));
});

test('SourceCountLedger never conflates parsed publisher counts with runtime citations', () => {
  const ledger = JSON.parse(readFileSync('data/generated/source-count-ledger.json', 'utf8'));
  const registry = JSON.parse(readFileSync('data/source-registry.json', 'utf8'));
  assert.equal(ledger.artifacts.length, registry.artifacts.length);
  assert.equal(ledger.catalogs.length, registry.catalog_source_bundles.length);
  assert.match(ledger.count_semantics.parsed_source_records, /source adapter/i);
  assert.match(ledger.count_semantics.runtime_node_citations, /graph nodes/i);
  assert.ok(ledger.artifacts.every((entry) => Number.isInteger(entry.counts.parsed_source_records)));
  assert.ok(ledger.artifacts.every((entry) => Number.isInteger(entry.counts.runtime_node_citations)));
});

test('every shipped catalog reconciles to zero unexplained node and edge deltas (T2.8)', () => {
  const ledger = JSON.parse(readFileSync('data/generated/source-count-ledger.json', 'utf8'));
  for (const catalog of ledger.catalogs) {
    assert.equal(
      catalog.counts.unexplained_graph_node_delta,
      0,
      `${catalog.catalog_id} has an unexplained_graph_node_delta of ${catalog.counts.unexplained_graph_node_delta}`,
    );
    assert.equal(
      catalog.counts.unexplained_graph_edge_delta,
      0,
      `${catalog.catalog_id} has an unexplained_graph_edge_delta of ${catalog.counts.unexplained_graph_edge_delta}`,
    );
  }
});

test('every nonzero normalized_to_leaf_delta carries a machine-readable reason (T2.9)', () => {
  const ledger = JSON.parse(readFileSync('data/generated/source-count-ledger.json', 'utf8'));
  for (const catalog of ledger.catalogs) {
    if (catalog.counts.normalized_to_leaf_delta) {
      assert.ok(
        DELTA_REASONS.has(catalog.counts.normalized_to_leaf_delta_reason),
        `${catalog.catalog_id} has a nonzero normalized_to_leaf_delta (${catalog.counts.normalized_to_leaf_delta}) with no valid reason`,
      );
    } else {
      assert.equal(catalog.counts.normalized_to_leaf_delta_reason, null);
    }
  }
});

test('every artifact and catalog has an explicit outcome for every ingestion stage', () => {
  const ledger = JSON.parse(readFileSync('data/generated/ingestion-stage-ledger.json', 'utf8'));
  for (const entry of [...ledger.artifacts, ...ledger.catalogs]) {
    assert.deepEqual(Object.keys(entry.stages), INGESTION_STAGES);
    assert.ok(Object.values(entry.stages).every((stage) => ['complete', 'not_applicable', 'failed'].includes(stage.status)));
  }
});

test('every Resource uses the same lifecycle and has an explicit presentation outcome', () => {
  const ledger = JSON.parse(readFileSync('data/generated/resource-ingestion-ledger.json', 'utf8'));
  const dataset = JSON.parse(readFileSync('data/commons-resource-dataset.json', 'utf8'));
  assert.equal(ledger.status, 'COMPLETE');
  assert.equal(ledger.resources.length, dataset.resources.length);
  for (const entry of ledger.resources) {
    assert.deepEqual(Object.keys(entry.stages), INGESTION_STAGES);
    assert.ok(Object.values(entry.stages).every((stage) => ['complete', 'not_applicable', 'failed'].includes(stage.status)));
    assert.notEqual(entry.stages.presentation.status, 'not_applicable');
  }
});

test('every generator that writes into data/generated is part of the refresh pipeline', () => {
  // data/generated is gitignored, and the refresh runs build:site with
  // --reuse-generated, so it reuses that directory rather than rebuilding it.
  // Any generator that generate:data runs but the refresh does not is therefore
  // simply absent at build time on a clean runner. That is how the 2026-09-09
  // refresh died in vite.config.ts, which reads publication-identity-index.json
  // while loading its own config -- and how it died earlier on
  // taxonomy-registry.json. This asserts the two pipelines cannot drift again.
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const chain = `${pkg.scripts['build:data']} ${pkg.scripts['generate:data']}`;
  const referenced = [...new Set([...chain.matchAll(/scripts\/([a-z0-9-]+\.mjs)/g)].map((m) => m[1]))];
  assert.ok(referenced.length > 8, 'expected to find the generate:data script chain');

  const taskScripts = new Set(INGESTION_TASKS.map((task) => task.script));
  const missing = referenced.filter((script) => {
    const source = readFileSync(new URL(`../scripts/${script}`, import.meta.url), 'utf8');
    const writesGenerated = /data\/generated|join\(\s*GENERATED/.test(source)
      && /writeJsonAtomically\(|writeFileSync\(/.test(source);
    return writesGenerated && !taskScripts.has(script);
  });

  assert.deepEqual(
    missing,
    [],
    `these generators write into data/generated but the refresh never runs them, so the `
      + `artifact is missing on a clean runner: ${missing.join(', ')}`,
  );
});
