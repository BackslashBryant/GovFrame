import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

import { INGESTION_TASKS } from '../scripts/lib/ingestion-pipeline.mjs';
import {
  loadSourceRefreshContract,
  validateSourceRefreshContract,
} from '../scripts/lib/source-refresh-contract.mjs';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const sourceRegistry = JSON.parse(readFileSync('data/source-registry.json', 'utf8'));

test('every scheduled remote fetch has explicit source ownership and cadence', () => {
  const contract = loadSourceRefreshContract();
  assert.deepEqual(validateSourceRefreshContract(contract, INGESTION_TASKS, workflow, sourceRegistry), []);
  assert.ok(contract.tasks.every((task) => task.cadence === 'weekly'));
  assert.equal(contract.schedule.stale_source_detection_independent, true);
});

test('an unmapped scheduled source fetch fails closed', () => {
  const contract = loadSourceRefreshContract();
  const incomplete = {
    ...contract,
    tasks: contract.tasks.filter((task) => task.task_id !== 'fetch-ccis'),
  };
  assert.match(
    validateSourceRefreshContract(incomplete, INGESTION_TASKS, workflow, sourceRegistry).join('\n'),
    /fetch-ccis is missing/,
  );
});

test('catalog scopes resolve to governed production catalogs', () => {
  const contract = loadSourceRefreshContract();
  const invalid = structuredClone(contract);
  invalid.tasks[0].catalog_ids.push('invented-catalog');
  assert.match(
    validateSourceRefreshContract(invalid, INGESTION_TASKS, workflow, sourceRegistry).join('\n'),
    /unknown catalog invented-catalog/,
  );
});

test('scheduled source and health fetches use the governed transport', () => {
  const files = [];
  const collect = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith('.mjs')) files.push(path);
    }
  };
  collect('scripts');
  collect(join('tools', 'importers'));
  collect(join('tools', 'relationship-builders'));
  const directFetchFiles = files
    .filter((path) => /\bfetch\s*\(/.test(readFileSync(path, 'utf8')))
    .map((path) => path.replaceAll('\\', '/'))
    .sort();
  assert.deepEqual(directFetchFiles, []);
  const disa = readFileSync('scripts/fetch-disa-stigs.mjs', 'utf8');
  assert.match(disa, /options\.fetchImpl \|\| strictConditionalFetch/);
});
