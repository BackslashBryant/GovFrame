import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  calculateGeneratedDataCacheKey,
  discoverGenerationEntrypoints,
  generatedDataCacheInputs,
} from "../tools/generated-data-cache-key.mjs";

const EXPECTED_PIPELINE_ENTRYPOINTS = [
  "scripts/build-catalog-source-inventory.mjs",
  "scripts/build-commons-index.mjs",
  "scripts/build-discovery-index.mjs",
  "scripts/build-fedramp-2026-catalog.mjs",
  "scripts/build-framework-data.mjs",
  "scripts/build-publication-audit-report.mjs",
  "scripts/build-publication-identity-index.mjs",
  "scripts/build-source-semantic-audit.mjs",
  "scripts/build-source-truth-migration-manifest.mjs",
  "scripts/build-taxonomy-registry.mjs",
  "scripts/migrate-source-truth-profiles.mjs",
  "scripts/reconcile-artifact-counts.mjs",
  "scripts/sync-catalog-inventory-contracts.mjs",
  "scripts/verify-ingestion-pipeline.mjs",
  "scripts/verify-manifests.mjs",
  "scripts/verify-resource-ingestion.mjs",
];

test("generated data cache key covers the canonical package-script pipeline", () => {
  const inputs = generatedDataCacheInputs();
  assert.deepEqual(inputs, [...new Set(inputs)].sort());
  assert.ok(inputs.includes("package.json"));
  assert.ok(inputs.includes("data/source-registry.json"));
  assert.ok(inputs.includes("maps/800-53-to-csf.json"));
  for (const entrypoint of EXPECTED_PIPELINE_ENTRYPOINTS) {
    assert.ok(inputs.includes(entrypoint), `${entrypoint} is not a cache input`);
  }
  assert.ok(inputs.includes("src/app/runtime.mjs"));
  assert.ok(inputs.every((path) => !path.startsWith("data/generated/")));
  assert.match(calculateGeneratedDataCacheKey(), /^[0-9a-f]{64}$/);
});

test("generated data producer discovery follows nested npm scripts", () => {
  const entrypoints = discoverGenerationEntrypoints({
    "build:data": "node ./scripts/build-one.mjs && npm run migrate:data",
    "generate:data": "npm run build:data && tsx ./scripts/build-two.ts",
    "migrate:data": "node ./scripts/new-producer.mjs",
  });

  assert.deepEqual(entrypoints, [
    "scripts/build-one.mjs",
    "scripts/build-two.ts",
    "scripts/new-producer.mjs",
  ]);
});

test("generated data producer discovery fails closed on unsupported commands", () => {
  assert.throws(
    () => discoverGenerationEntrypoints({
      "build:data": "node ./scripts/build-one.mjs | tee build.log",
      "generate:data": "npm run build:data",
    }),
    /Unsupported generated-data command/,
  );
});

test("cache keys distinguish removed, new, changed, and empty source snapshots", (t) => {
  const local = resolve(".local");
  mkdirSync(local, { recursive: true });
  const root = mkdtempSync(join(local, "cache-key-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "data"));
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: {
    "build:data": "node ./scripts/build.mjs",
    "generate:data": "npm run build:data",
  } }));
  writeFileSync(join(root, "package-lock.json"), "{}");
  writeFileSync(join(root, "scripts/build.mjs"), "export const build = true;\n");
  const source = join(root, "data/source.json");
  writeFileSync(source, "{}");
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  const initial = calculateGeneratedDataCacheKey(root);
  rmSync(source);
  const removed = calculateGeneratedDataCacheKey(root);
  assert.notEqual(removed, initial);
  assert.equal(calculateGeneratedDataCacheKey(root), removed);
  writeFileSync(source, "");
  assert.notEqual(calculateGeneratedDataCacheKey(root), removed);
  writeFileSync(source, "{}");
  assert.equal(calculateGeneratedDataCacheKey(root), initial);
  const added = join(root, "data/new.json");
  writeFileSync(added, "{}");
  const newSnapshot = calculateGeneratedDataCacheKey(root);
  assert.notEqual(newSnapshot, initial);
  writeFileSync(added, '{"changed":true}');
  assert.notEqual(calculateGeneratedDataCacheKey(root), newSnapshot);
  rmSync(join(root, "scripts/build.mjs"));
  assert.throws(() => calculateGeneratedDataCacheKey(root), /dependency missing/);
});
