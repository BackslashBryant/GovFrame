import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const refreshScript = readFileSync('scripts/refresh-data.mjs', 'utf8');
const ingestionPipeline = readFileSync('scripts/lib/ingestion-pipeline.mjs', 'utf8');
const lighthouseAb = readFileSync('tools/run-lighthouse-ab.mjs', 'utf8');
const trackedWorkflows = readdirSync('.github/workflows')
  .filter((name) => /\.ya?ml$/.test(name))
  .map((name) => `.github/workflows/${name}`);

test('source refresh runs weekly and remains manually dispatchable', () => {
  assert.match(workflow, /cron: '17 7 \* \* 3'/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /github\.event\.schedule \|\| inputs\.task \|\| github\.ref/);
});

test('nightly browser shards keep parallelism visible and disable retry masking', () => {
  assert.match(workflow, /PLAYWRIGHT_FULLY_PARALLEL: '1'/);
  assert.match(workflow, /PLAYWRIGHT_WORKERS: '2'/);
  assert.match(
    workflow,
    /npm run test:e2e:run -- --shard=\$\{\{ matrix\.shard \}\}\/2 --retries=0 --reporter=blob,github/,
  );
});

test('source refresh opens one App PR after the full gate and requires independent admission', () => {
  assert.match(workflow, /permission-contents: write/);
  assert.match(workflow, /permission-pull-requests: write/);
  assert.match(workflow, /npm run refresh:data/);
  assert.match(workflow, /name: Restore strict conditional source cache/);
  assert.match(workflow, /path: \.local\/http-cache-v1/);
  assert.match(workflow, /key: source-http-v1-\$\{\{ runner\.os \}\}-\$\{\{ github\.run_id \}\}/);
  assert.match(workflow, /GITHUB_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(workflow, /npm run resources:health/);
  assert.doesNotMatch(workflow, /npm run audit:deps/);
  assert.match(workflow, /npx playwright install --with-deps chromium/);
  assert.match(workflow, /npm run precommit:incremental/);
  assert.match(workflow, /npm run sbom:generate/);
  assert.match(workflow, /name: Restore tracked SBOM before source admission\s+run: git restore --worktree -- artifacts\/sbom\.cdx\.json/);
  assert.match(workflow, /peter-evans\/create-pull-request@[0-9a-f]{40}/);
  assert.match(workflow, /branch: automation\/source-refresh/);
  assert.match(workflow, /draft: false/);
  assert.match(workflow, /token: \$\{\{ steps.refresh-app.outputs.token \}\}/);
  assert.match(workflow, /node tools\/verify-refresh-admission.mjs/);
  assert.match(workflow, /node tools\/report-refresh-alerts.mjs/);
  assert.ok(workflow.indexOf('name: Create repository-scoped publisher token') > workflow.indexOf('name: Verify refreshed repository'));
  assert.ok(workflow.indexOf('Restore tracked SBOM before source admission') > workflow.indexOf('name: source-refresh-sbom-cdx-json'));
  assert.ok(workflow.indexOf('node scripts/report-refresh-diff.mjs') > workflow.indexOf('Restore tracked SBOM before source admission'));
  assert.match(workflow, /data\/\*\*/);
  assert.match(workflow, /maps\/\*\*/);
  assert.doesNotMatch(workflow, /git push|\[skip ci\]|auto-merge/i);
});

test('obsolete Tenable refresh cannot run outside the current registry pipeline', () => {
  assert.equal(existsSync('.github/workflows/weekly-tenable.yml'), false);
});

test('source refresh ingests the current structured FedRAMP rules before rebuilding', () => {
  assert.match(ingestionPipeline, /fetch-fedramp-2026-rules\.mjs/);
  assert.match(ingestionPipeline, /reconcile-artifact-counts\.mjs/);
  assert.match(ingestionPipeline, /verify-discovery\.mjs/);
  assert.match(ingestionPipeline, /verify-manifests\.mjs/);
  assert.match(ingestionPipeline, /presentation/);
  assert.match(refreshScript, /INGESTION_TASKS/);
});

test('Lighthouse A/B gates a candidate against a baseline on the same mobile runner', () => {
  assert.match(workflow, /default: v1\.0\.0/);
  assert.match(workflow, /AFTER_REF: \$\{\{ inputs\.after_ref \|\| github\.sha \}\}/);
  assert.match(workflow, /MAX_MEDIAN_DROP: '3'/);
  assert.match(workflow, /ROUTE: '\/#\/explore\?node=/);
  assert.match(lighthouseAb, /fetchRef\(beforeRef\)/);
  assert.match(lighthouseAb, /fetchRef\(afterRef\)/);
  assert.match(lighthouseAb, /--only-categories=performance/);
  assert.match(lighthouseAb, /--max-wait-for-load=90000/);
  assert.match(lighthouseAb, /--disable-dev-shm-usage/);
  assert.match(lighthouseAb, /function median/);
  assert.match(lighthouseAb, /afterMedian < allowedMinimum/);
  assert.match(workflow, /name: lighthouse-ab/);
  assert.doesNotMatch(lighthouseAb, /npm install/);
});

test('workflow artifacts use the Node-20-deprecation-safe upload action', () => {
  for (const filename of trackedWorkflows) {
    const content = readFileSync(filename, 'utf8');
    assert.doesNotMatch(content, /actions\/upload-artifact@v\d+\b/, filename);
  }
});

test('workflow JavaScript actions no longer use the Node 20 checkout or setup runtimes', () => {
  for (const filename of trackedWorkflows) {
    const content = readFileSync(filename, 'utf8');
    assert.doesNotMatch(content, /actions\/checkout@v\d+\b/, filename);
    assert.doesNotMatch(content, /actions\/setup-node@v\d+\b/, filename);
  }
});
