import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyChangedPaths } from '../tools/classify-change-scope.mjs';
import { createVerificationPlan } from '../tools/verify-affected.mjs';

test('refresh safety maps affected contracts without a build and rejects unknown modules', () => {
  const paths = ['scripts/lib/source-baseline.mjs'];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.steps.map((step) => step.id), ['refresh-safety-lint', 'refresh-safety-contracts']);
  assert.deepEqual(plan.steps[1].command, ['node', '--test', 'tests/source-baseline.test.mjs', 'tests/refresh-candidate-gate.test.mjs', 'tests/mitre-release-admission.test.mjs']);
  assert.equal(plan.steps[1].workers, 3);
  assert.ok(plan.totalBudgetSeconds <= 40);
  const unknown = [...paths, 'scripts/lib/new-unmapped-refresh.mjs'];
  assert.equal(createVerificationPlan(unknown, classifyChangedPaths(unknown)).blocked, true);
});

test('refresh probe and cache changes use offline fixtures and unknown inputs fail closed', () => {
  const paths = ['scripts/check-commons-health.mjs', 'tools/generated-data-cache-key.mjs'];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.steps.map((step) => step.id), ['refresh-runtime-contracts']);
  assert.equal(plan.totalExpectedTests, 12);
  assert.equal(plan.steps[0].workers, 2);
  const unknown = [...paths, 'scripts/unknown-refresh-operation.mjs'];
  assert.equal(createVerificationPlan(unknown, classifyChangedPaths(unknown)).blocked, true);
});

test('automation-only changes stay on the automation contract path', () => {
  const paths = [
    '.gitignore',
    'config/experience-guardian/route-matrix.json',
    'package.json',
    'tools/wait-for-checks.mjs',
    'tests/wait-for-checks.test.mjs',
  ];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'automation-lint',
    'automation-contracts',
  ]);
  assert.equal(plan.steps.some((step) => step.id === 'incremental-site-build'), false);
  assert.equal(plan.steps.some((step) => step.id === 'source-trust-browser'), false);
});

test('trust and workbench changes select bounded route families and the incremental build', () => {
  const paths = ['src/ui/pages/SourcesPage.tsx'];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'typecheck',
    'incremental-site-build',
    'source-truth-contract',
    'source-trust-browser',
    'source-identity-compatibility-browser',
  ]);
  assert.equal(plan.steps.find((step) => step.id === 'source-trust-browser').expectedTests, 21);
  assert.equal(plan.steps.find((step) => step.id === 'source-trust-browser').workers, 2);
  const sharedPaths = [
    'src/ui/lib/sourcePresentation.ts',
    'src/ui/pages/CatalogDetailPage.tsx',
    'src/ui/pages/ObjectDetailPage.tsx',
  ];
  const sharedPlan = createVerificationPlan(sharedPaths, classifyChangedPaths(sharedPaths));
  assert.equal(sharedPlan.blocked, false);
  assert.equal(sharedPlan.steps.some((step) => step.id === 'source-trust-browser'), true);
  assert.deepEqual(
    sharedPlan.steps.find((step) => step.id === 'source-trust-browser')?.command.slice(-3),
    [
      'tests/e2e/sources-inspector-state.spec.mjs',
      'tests/e2e/source-truth-presentation.spec.mjs',
      'tests/e2e/source-trust-surfaces.spec.mjs',
    ],
  );
  assert.deepEqual(
    sharedPlan.steps.find((step) => step.id === 'source-identity-compatibility-browser')?.command.slice(-4),
    [
      'tests/e2e/publication-identity.spec.mjs',
      'tests/e2e/epic14-ws2-record-template.spec.mjs',
      '--grep',
      'publication pages use|OSCAL-fed records|WS2 exposes governed',
    ],
  );

  const comparePaths = [
    'src/ui/pages/ComparePage.tsx',
    'src/ui/lib/comparePagination.ts',
    'tests/e2e/compare-pagination.spec.mjs',
  ];
  const comparePlan = createVerificationPlan(comparePaths, classifyChangedPaths(comparePaths));
  assert.equal(comparePlan.blocked, false);
  assert.deepEqual(comparePlan.steps.map((step) => step.id), [
    'typecheck',
    'incremental-site-build',
    'compare-workbench-browser',
  ]);
    assert.equal(comparePlan.steps.at(-1).expectedTests, 4);
    assert.equal(comparePlan.steps.at(-1).workers, 2);
    assert.equal(comparePlan.steps.at(-1).budgetSeconds, 45);

  const boundedPlan = createVerificationPlan([
    'src/ui/pages/AtlasMapPage.tsx',
    'src/ui/pages/ExplorePage.tsx',
    'src/ui/pages/CommonsPage.tsx',
  ], classifyChangedPaths([
    'src/ui/pages/AtlasMapPage.tsx',
    'src/ui/pages/ExplorePage.tsx',
    'src/ui/pages/CommonsPage.tsx',
  ]));
  assert.equal(boundedPlan.blocked, false);
  assert.equal(boundedPlan.steps.some((step) => step.id === 'bounded-workbench-browser'), true);
  assert.equal(boundedPlan.steps.find((step) => step.id === 'bounded-workbench-browser')?.expectedTests, 4);

  const phase4Paths = [
    'data/template-registry.json',
    'src/app/learn-content.mjs',
    'src/ui/pages/TemplatesPage.tsx',
    'tests/e2e/phase4-content-coherence.spec.mjs',
  ];
  const phase4Plan = createVerificationPlan(phase4Paths, classifyChangedPaths(phase4Paths));
  assert.equal(phase4Plan.blocked, false);
  const phase4Browser = phase4Plan.steps.find((step) => step.id === 'phase4-surface-browser');
  assert.ok(phase4Browser);
  assert.equal(phase4Browser.expectedTests, 7);
  assert.equal(phase4Browser.workers, 2);
  assert.equal(phase4Browser.budgetSeconds, 60);
});

test('dependency changes select bounded supply-chain and product proof', () => {
  const paths = ['package-lock.json', 'artifacts/sbom.cdx.json'];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.steps.map((step) => step.id), [
    'lockfile-integrity',
    'dependency-audit',
    'dependency-licenses',
    'dependency-sbom',
    'typecheck',
    'full-site-build',
    'dependency-runtime-contracts',
    'dependency-office-contracts',
    'dependency-browser-smoke',
  ]);
  assert.equal(plan.steps.find((step) => step.id === 'dependency-runtime-contracts').expectedTests, 33);
  assert.equal(plan.steps.find((step) => step.id === 'dependency-office-contracts').expectedTests, 14);
  assert.equal(plan.steps.find((step) => step.id === 'dependency-browser-smoke').expectedTests, 2);
  assert.equal(plan.steps.every((step) => step.expectedTests <= 50), true);
  assert.equal(plan.steps.every((step) => step.budgetSeconds <= 120), true);
});

test('unmapped runtime and data changes fail before an expensive fallback', () => {
  for (const paths of [['src/ui/pages/UnknownPage.tsx'], ['data/source-registry.json']]) {
    const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
    assert.equal(plan.blocked, true, paths[0]);
    assert.ok(plan.reasons.length > 0, paths[0]);
  }
});

test('public shell metadata and static assets use the focused browser contract', () => {
  const paths = ['src/index.html', 'src/public/robots.txt', 'src/public/og-image.png'];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.ok(plan.steps.some((step) => step.id === 'incremental-site-build'));
  const shell = plan.steps.find((step) => step.id === 'public-shell-contract');
  assert.ok(shell);
  assert.deepEqual(shell.command, ['node', '--test', 'tests/browser-contract.test.mjs']);
  assert.equal(shell.expectedTests, 28);
  assert.equal(shell.workers, 1);
});

test('known STIG observation changes use the source-specific refresh contract', () => {
  const paths = [
    'scripts/fetch-stig-source-observations.mjs',
    'tests/stig-source-observer.test.mjs',
  ];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(
    plan.steps.filter((step) => step.id.startsWith('stig-observer')).map((step) => step.id),
    ['stig-observer-lint', 'stig-observer-contracts'],
  );
  assert.equal(plan.reasons.includes('data changes require a source-specific refresh plan'), false);
});

test('incremental fetch and writer changes use their focused data contracts', () => {
  const paths = [
    'scripts/lib/strict-conditional-fetch.mjs',
    'scripts/lib/write-json-atomically.mjs',
    'tests/strict-conditional-fetch.test.mjs',
    'tests/write-json-atomically.test.mjs',
  ];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(
    plan.steps.filter((step) => step.id.startsWith('incremental-data')).map((step) => step.id),
    ['incremental-data-lint', 'incremental-data-contracts'],
  );

  const operatorPaths = [
    'scripts/apply-commons-operator-ecosystem.mjs',
    'scripts/lib/url-classification.mjs',
    'tests/commons-operator-ecosystem.test.mjs',
  ];
  const operatorPlan = createVerificationPlan(operatorPaths, classifyChangedPaths(operatorPaths));
  assert.equal(operatorPlan.blocked, false);
  assert.deepEqual(
    operatorPlan.steps.filter((step) => step.id.startsWith('operator-ecosystem')).map((step) => step.id),
    ['operator-ecosystem-lint', 'operator-ecosystem-contracts'],
  );
});

test('source refresh adapters and cadence metadata use one bounded contract path', () => {
  const paths = [
    'data/source-refresh-contract.json',
    'scripts/fetch-ccis.mjs',
    'scripts/lib/source-refresh-contract.mjs',
    'tests/source-refresh-contract.test.mjs',
    'tools/relationship-builders/olir-retrieval.mjs',
  ];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.deepEqual(
    plan.steps.filter((step) => step.id.startsWith('source-refresh')).map((step) => step.id),
    ['source-refresh-lint', 'source-refresh-contracts'],
  );
});

test('repository EOL policy uses automation and executable hygiene contracts', () => {
  const paths = ['.gitattributes', 'src/ui/components/ExpandableRelationshipGroup.tsx'];
  const plan = createVerificationPlan(paths, classifyChangedPaths(paths));
  assert.equal(plan.blocked, false);
  assert.ok(plan.steps.some((step) => step.id === 'eol-contracts'));
});
