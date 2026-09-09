import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { isAllowedLicenseExpression } from '../tools/check-licenses.mjs';
import { parseGitHubRemote } from '../tools/detection.mjs';

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const ci = readFileSync('.github/workflows/ci.yml', 'utf8');
const security = readFileSync('.github/workflows/security.yml', 'utf8');
const deploy = readFileSync('.github/workflows/deploy.yml', 'utf8');
const refreshMerge = readFileSync('.github/workflows/automerge-refresh.yml', 'utf8');
const workflows = { ci, security, deploy, refreshMerge };

test('the automation surface contains the four admitted workflows', () => {
  assert.deepEqual(
    readdirSync('.github/workflows').filter((name) => /\.ya?ml$/.test(name)).sort(),
    ['automerge-refresh.yml', 'ci.yml', 'deploy.yml', 'security.yml'],
  );
  assert.match(ci, /name: Control Atlas CI/);
  assert.match(security, /name: Control Atlas Security/);
  assert.match(deploy, /name: Control Atlas Deploy/);
  assert.match(refreshMerge, /name: Merge validated source refresh/);
  assert.match(refreshMerge, /ref: main/);
  assert.doesNotMatch(refreshMerge, /pull_request_target:/);
});

test('PR CI creates one change map from a shallow checkout and targeted base fetch', () => {
  assert.match(ci, /name: Change map/);
  assert.match(ci, /fetch-depth: 1/);
  assert.match(ci, /git fetch --no-tags --depth=1 origin "\$base"/);
  assert.match(ci, /tools\/classify-change-scope\.mjs/);
  assert.match(ci, /name: ci-change-map/);
  assert.match(ci, /automation_changed: \$\{\{ steps\.scope\.outputs\.automation_changed \}\}/);
  assert.match(ci, /name: Automation contracts[\s\S]*?if: \$\{\{ needs\.changes\.outputs\.automation_changed == 'true' \}\}/);
  assert.doesNotMatch(ci, /fetch-depth: 0/);
});

test('PR CI is an independent gate DAG around one immutable artifact', () => {
  for (const job of [
    'Automation contracts',
    'Documentation contracts',
    'Lint, types, and contracts',
    'Prepare reproducible generated data',
    'Unit and component tests',
    'Build immutable site artifact',
    'Static, data, and Guardian contracts',
    'Accessibility',
    'Deliberate visual regression',
    'Lighthouse budgets',
    'Required CI',
  ]) assert.match(ci, new RegExp(`name: ${job}`));

  assert.equal((ci.match(/name: site-build/g) ?? []).length >= 4, true);
  assert.equal((ci.match(/npm run build:site:incremental/g) ?? []).length, 2);
  assert.match(ci, /npm run verify:generated-reproducibility/);
  assert.match(ci, /name: Documentation contracts[\s\S]*?if: \$\{\{ needs\.changes\.outputs\.content_changed == 'true' \}\}[\s\S]*?npm run test:documentation-contracts/);
  assert.match(ci, /name: generated-data/);
  assert.match(
    ci,
    /needs\.changes\.outputs\.build_required == 'true' \|\|\s+needs\.changes\.outputs\.unit_required == 'true'/,
  );
  assert.match(ci, /if: \$\{\{ needs\.generated\.result == 'success' \}\}/);
  assert.match(ci, /shard: \[1, 2\]/);
  assert.match(ci, /--shard=\$\{\{ matrix\.shard \}\}\/2/);
  assert.match(ci, /npm run test:a11y:smoke/);
  assert.match(ci, /npm run test:performance:ci/);
  assert.match(ci, /checks:\n\s+name: checks\n\s+if: \$\{\{ always\(\) && needs\.required\.result != 'skipped' \}\}\n\s+needs: required/);
  assert.doesNotMatch(ci, /npm run audit:deps/);
});

test('nightly validation retains full cross-browser and data automation', () => {
  assert.match(ci, /browser: \[chromium, firefox, webkit\]/);
  assert.match(ci, /npm run test:e2e:run/);
  assert.match(ci, /npm run test:a11y:run/);
  assert.match(ci, /PLAYWRIGHT_BLOB_OUTPUT_NAME: report-\$\{\{ matrix\.browser \}\}-\$\{\{ matrix\.shard \}\}\.zip/);
  assert.match(ci, /PLAYWRIGHT_BLOB_OUTPUT_NAME: report-accessibility\.zip/);
  assert.equal((ci.match(/--reporter=blob,github/g) ?? []).length, 2);
  assert.match(ci, /issues_enabled="\$\(gh api "repos\/\$REPO" --jq '\.has_issues'\)"/);
  assert.match(ci, /Repository Issues are disabled, so this workflow cannot open or resolve the persistent sweep alert/);
  assert.match(ci, /npm run resources:health/);
  assert.match(ci, /peter-evans\/create-pull-request@[0-9a-f]{40}/);
  assert.match(ci, /npm run test:oscal:independent/);
  assert.match(ci, /node tools\/run-lighthouse-ab\.mjs/);
});

test('security uses native GitHub controls without rebuilding the site', () => {
  assert.match(security, /actions\/dependency-review-action@[0-9a-f]{40}/);
  assert.match(security, /github\/codeql-action\/init@[0-9a-f]{40}/);
  assert.match(security, /build-mode: none/);
  assert.match(security, /Install checksum-verified Gitleaks 8\.24\.3/);
  assert.match(security, /\.\/gitleaks dir \./);
  assert.match(security, /github\/codeql-action\/upload-sarif@[0-9a-f]{40}/);
  assert.equal((security.match(/fetch-depth: 0/g) ?? []).length, 1);
  assert.doesNotMatch(security, /npm ci|npm run build:site|npm run audit:deps/);
  assert.ok(existsSync('.gitleaks.toml'));
  assert.ok(existsSync('.github/dependabot.yml'));
});

test('deployment consumes the successful main CI artifact and never rebuilds it', () => {
  assert.match(deploy, /workflows: \[Control Atlas CI\]/);
  assert.match(deploy, /github\.event\.workflow_run\.conclusion == 'success'/);
  assert.match(deploy, /name: site-build/);
  assert.match(deploy, /actual_sha=.*release\.json/);
  assert.match(deploy, /actions\/deploy-pages@[0-9a-f]{40}/);
  assert.match(deploy, /name: Production smoke/);
  assert.match(deploy, /name: Production Lighthouse/);
  assert.match(deploy, /cancel-in-progress: false/);
  assert.doesNotMatch(deploy, /npm run build:site/);
});

test('every external Action reference is an immutable full SHA', () => {
  for (const [name, workflow] of Object.entries(workflows)) {
    for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*([^\s#]+)/gm)) {
      const reference = match[1];
      if (reference.startsWith('./') || reference.startsWith('docker://')) continue;
      assert.match(reference, /@[0-9a-f]{40}$/i, `${name}: ${reference}`);
    }
  }
  assert.ok(existsSync('tools/check-action-pins.mjs'));
});

test('package scripts expose deterministic split gates and full local verification', () => {
  for (const script of [
    'build:site',
    'build:site:incremental',
    'generate:data',
    'materialize:generated',
    'verify:generated-reproducibility',
    'lint:ci',
    'lint:automation',
    'typecheck',
    'test',
    'test:ci-contracts',
    'test:source-refresh',
    'test:documentation-contracts',
    'verify:affected',
    'verify:lockfile',
    'test:e2e:smoke',
    'test:visual',
    'test:a11y:smoke',
    'test:performance:ci',
    'review:experience:contracts',
    'review:experience:family',
    'review:experience:full',
    'verify:contracts',
    'verify:quality',
  ]) assert.equal(typeof packageJson.scripts[script], 'string', script);

  assert.match(packageJson.scripts['test:data'], /--test-concurrency=1/);
  assert.match(
    packageJson.scripts['test:graph'],
    /tests\/graph\/atlasExplorerReconciliation\.test\.ts/,
  );
  assert.match(packageJson.scripts['verify:quality'], /verify:contracts/);
  assert.match(packageJson.scripts['verify:quality'], /lint:ci/);
  assert.match(packageJson.scripts['verify:quality'], /npm test/);
  assert.match(packageJson.scripts.test, /test:source-refresh/);
  assert.match(packageJson.scripts['lint:ci'], /lint:source-refresh/);
  assert.match(packageJson.scripts['review:experience:family'], /playwright\.guardian\.config\.mjs/);
  assert.match(packageJson.scripts['review:experience:full'], /playwright\.guardian\.config\.mjs/);
  assert.match(packageJson.scripts['review:experience:family'], /tests\/guardian\/experience-guardian\.spec\.mjs/);
  assert.match(packageJson.scripts['review:experience:full'], /tests\/guardian\/experience-guardian\.spec\.mjs/);
  assert.match(packageJson.scripts['verify:lockfile'], /tools\/verify-lockfile\.mjs/);
  assert.equal(isAllowedLicenseExpression('EPL-2.0 OR GPL-3.0-or-later'), true);
  assert.equal(isAllowedLicenseExpression('(MIT AND Zlib)'), true);
  assert.equal(isAllowedLicenseExpression('MIT AND GPL-3.0-or-later'), false);
  assert.equal(isAllowedLicenseExpression('LicenseRef-Unknown'), false);
  assert.deepEqual(parseGitHubRemote('https://github.com/RAMBULLS/control-atlas.git'), {
    owner: 'RAMBULLS', repo: 'control-atlas',
  });
  assert.deepEqual(parseGitHubRemote('git@github.com:RAMBULLS/control-atlas.git'), {
    owner: 'RAMBULLS', repo: 'control-atlas',
  });
  assert.equal(parseGitHubRemote('https://github.com.evil.example/RAMBULLS/control-atlas'), null);
  assert.equal(parseGitHubRemote('https://evil.example/?next=github.com/RAMBULLS/control-atlas'), null);
  assert.ok(existsSync('.lighthouserc.ci.json'));
});

test('browser projects are selected explicitly while accessibility remains separate', () => {
  const base = readFileSync('playwright.config.mjs', 'utf8');
  const e2e = readFileSync('playwright.e2e.config.mjs', 'utf8');
  const a11y = readFileSync('playwright.a11y.config.mjs', 'utf8');
  const visual = readFileSync('playwright.visual.config.mjs', 'utf8');
  assert.match(base, /PLAYWRIGHT_BROWSER/);
  assert.match(base, /projects:/);
  assert.match(e2e, /accessibility\.spec\.mjs/);
  assert.match(a11y, /testMatch: '\*\*\/accessibility\.spec\.mjs'/);
  assert.match(visual, /testMatch: '\*\*\/visual-regression\.spec\.mjs'/);
  assert.ok(existsSync('tests/e2e/visual-regression.spec.mjs'));
  assert.ok(packageJson.devDependencies['@axe-core/playwright']);
});

test('shipping helpers preserve focused local checks and exact remote verification', () => {
  for (const script of ['git:push', 'checks:wait', 'ship:main', 'prepush:audit']) {
    assert.equal(typeof packageJson.scripts[script], 'string', script);
  }
  for (const file of [
    'tools/git-push-with-retry.mjs',
    'tools/wait-for-checks.mjs',
    'tools/ship-to-main.mjs',
  ]) assert.ok(existsSync(file), file);
  const ship = readFileSync('tools/ship-to-main.mjs', 'utf8');
  assert.match(ship, /classify-change-scope\.mjs/);
  assert.match(ship, /Direct ship must start from a verified task branch, not main/);
});

test('Dependabot maintains npm packages and pinned GitHub Actions', () => {
  const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
  assert.match(dependabot, /package-ecosystem:\s*"npm"/);
  assert.match(dependabot, /package-ecosystem:\s*"github-actions"/);
});
