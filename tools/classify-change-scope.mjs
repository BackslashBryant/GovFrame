#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EVIDENCE_PREFIXES = ['artifacts/audits/'];
const DATA_PREFIXES = [
  'data/',
  'maps/',
  'scripts/',
  'src/shared/',
  'tools/importers/',
  'tools/normalizers/',
  'tools/relationship-builders/',
];
const TEST_PREFIXES = ['tests/'];
const WORKFLOW_PREFIXES = ['.github/'];
const DOCUMENTATION_PREFIXES = ['docs/'];
const RUNTIME_PREFIXES = ['src/', 'public/'];

const DEPENDENCY_FILES = new Set([
  'artifacts/sbom.cdx.json',
  'package-lock.json',
]);
const AUTOMATION_FILES = new Set([
  'tools/recover-refresh-pr.mjs',
  'tests/recover-refresh-pr.test.mjs',
  '.gitattributes',
  '.gitignore',
  'config/experience-guardian/copy-ownership.json',
  'config/experience-guardian/route-matrix.json',
  'package.json',
  'tools/check-action-pins.mjs',
  'tools/check-licenses.mjs',
  'tools/classify-change-scope.mjs',
  'tools/detection.mjs',
  'tools/git-push-with-retry.mjs',
  'tools/experience-guardian.mjs',
  'tools/lib/vale-extraction.mjs',
  'tools/run-vale.mjs',
  'tools/ship-to-main.mjs',
  'tools/verify-affected.mjs',
  'tools/verify-lockfile.mjs',
  'tools/wait-for-checks.mjs',
  'tests/build-layout-contract.test.mjs',
  'tests/change-scope.test.mjs',
  'tests/experience-guardian.test.mjs',
  'tests/guardian/experience-guardian.spec.mjs',
  'playwright.guardian.config.mjs',
  'tests/package-scripts.test.mjs',
  'tests/process-runner.test.mjs',
  'tests/release-evidence.test.mjs',
  'tests/verification-topology.test.mjs',
  'tests/verify-affected.test.mjs',
  'tests/vale-extraction.test.mjs',
  'tests/wait-for-checks.test.mjs',
]);
const BUILD_FILES = new Set([
  'index.html',
  'vite.config.ts',
  'tsconfig.json',
  'tsconfig.app.json',
  'tools/build-static-site.mjs',
  'tools/generated-data-cache-key.mjs',
  'tools/serve-static-site.mjs',
]);
const PLAYWRIGHT_FILES = new Set([
  'playwright.config.mjs',
  'playwright.e2e.config.mjs',
  'playwright.a11y.config.mjs',
]);

function normalizePath(path) {
  return path.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function hasPrefix(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function isStyle(path) {
  return /\.(?:css|scss|sass|less)$/i.test(path);
}

function parseNameStatus(nameStatus) {
  const entries = nameStatus.split('\0').filter(Boolean);
  if (entries.length === 0) return { paths: [], error: 'empty-diff' };

  const paths = [];
  for (let index = 0; index < entries.length;) {
    const status = entries[index++];
    if (!/^[ACDMRTUXB]\d*$/.test(status)) {
      return { paths: [], error: `unsupported-status-${status}` };
    }

    const pathCount = /^[RC]/.test(status) ? 2 : 1;
    for (let offset = 0; offset < pathCount; offset += 1) {
      const path = normalizePath(entries[index++] ?? '');
      if (!path) return { paths: [], error: 'missing-path' };
      paths.push(path);
    }
  }

  return { paths: [...new Set(paths)], error: '' };
}

export function fullChangeMap(reason = 'manual-or-base-unavailable') {
  return {
    scope: 'full',
    reason,
    buildMode: 'full',
    evidenceOnly: false,
    codeChanged: true,
    stylesChanged: true,
    contentChanged: true,
    dataChanged: true,
    testsChanged: true,
    workflowsChanged: true,
    automationChanged: true,
    automationOnly: false,
    dependenciesChanged: true,
    buildRequired: true,
    unitRequired: true,
    browserRequired: true,
    accessibilityRequired: true,
    lighthouseRequired: true,
    dataRequired: true,
    securityRequired: true,
    workflowLintRequired: true,
    changedPaths: [],
  };
}

export function classifyChangedPaths(rawPaths) {
  const paths = [...new Set(rawPaths.map(normalizePath).filter(Boolean))];
  if (paths.length === 0) return fullChangeMap('empty-diff');

  const evidenceOnly = paths.every((path) => hasPrefix(path, EVIDENCE_PREFIXES));
  if (evidenceOnly) {
    return {
      ...fullChangeMap('audits-only'),
      scope: 'evidence-only',
      buildMode: 'none',
      evidenceOnly: true,
      codeChanged: false,
      stylesChanged: false,
      contentChanged: false,
      dataChanged: false,
      testsChanged: false,
      workflowsChanged: false,
      automationChanged: false,
      automationOnly: false,
      dependenciesChanged: false,
      buildRequired: false,
      unitRequired: false,
      browserRequired: false,
      accessibilityRequired: false,
      lighthouseRequired: false,
      dataRequired: false,
      securityRequired: false,
      workflowLintRequired: false,
      changedPaths: paths,
    };
  }

  let codeChanged = false;
  let stylesChanged = false;
  let contentChanged = false;
  let dataChanged = false;
  let testsChanged = false;
  let workflowsChanged = false;
  let automationChanged = false;
  let dependenciesChanged = false;
  let buildConfigurationChanged = false;
  let browserTestsChanged = false;
  let unknownChanged = false;

  for (const path of paths) {
    if (hasPrefix(path, EVIDENCE_PREFIXES)) continue;
    if (DEPENDENCY_FILES.has(path)) dependenciesChanged = true;
    else if (AUTOMATION_FILES.has(path)) automationChanged = true;
    else if (BUILD_FILES.has(path)) buildConfigurationChanged = true;
    else if (PLAYWRIGHT_FILES.has(path)) {
      testsChanged = true;
      browserTestsChanged = true;
    } else if (hasPrefix(path, WORKFLOW_PREFIXES)) {
      workflowsChanged = true;
      automationChanged = true;
    }
    else if (hasPrefix(path, TEST_PREFIXES)) {
      testsChanged = true;
      browserTestsChanged ||= path.startsWith('tests/e2e/');
    } else if (hasPrefix(path, DATA_PREFIXES)) dataChanged = true;
    else if (hasPrefix(path, RUNTIME_PREFIXES)) {
      if (isStyle(path)) stylesChanged = true;
      else codeChanged = true;
    } else if (
      hasPrefix(path, DOCUMENTATION_PREFIXES) ||
      path === 'visual-audit-findings.md' ||
      /^(?:README|LICENSE|CONTRIBUTING|SECURITY)(?:\.|$)/i.test(path)
    ) contentChanged = true;
    else unknownChanged = true;
  }

  codeChanged ||= unknownChanged;
  const runtimeChanged = codeChanged || stylesChanged || dataChanged ||
    dependenciesChanged || buildConfigurationChanged;
  const automationOnly = automationChanged && !runtimeChanged && !contentChanged &&
    !testsChanged;
  const browserRequired = runtimeChanged || browserTestsChanged;
  const buildRequired = runtimeChanged || browserRequired;
  const unitRequired = codeChanged || dataChanged || dependenciesChanged ||
    (testsChanged && !browserTestsChanged);
  const categories = [
    codeChanged && 'code',
    stylesChanged && 'styles',
    contentChanged && 'content',
    dataChanged && 'data',
    testsChanged && 'tests',
    workflowsChanged && 'workflows',
    automationChanged && 'automation',
    dependenciesChanged && 'dependencies',
    buildConfigurationChanged && 'build-config',
  ].filter(Boolean);

  return {
    scope: 'full',
    reason: `change-map-${categories.join('-') || 'unknown'}`,
    buildMode: dataChanged || dependenciesChanged || buildConfigurationChanged ? 'full' :
      buildRequired ? 'incremental' : 'none',
    evidenceOnly: false,
    codeChanged,
    stylesChanged,
    contentChanged,
    dataChanged,
    testsChanged,
    workflowsChanged,
    automationChanged,
    automationOnly,
    dependenciesChanged,
    buildRequired,
    unitRequired,
    browserRequired,
    accessibilityRequired: runtimeChanged,
    lighthouseRequired: runtimeChanged,
    dataRequired: dataChanged,
    securityRequired: codeChanged || dependenciesChanged,
    workflowLintRequired: workflowsChanged,
    changedPaths: paths,
  };
}

export function classifyNameStatus(nameStatus) {
  const parsed = parseNameStatus(nameStatus);
  return parsed.error ? fullChangeMap(parsed.error) : classifyChangedPaths(parsed.paths);
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : process.argv[index + 1] ?? '';
}

function resolveBase(base, head) {
  if (base && !/^0+$/.test(base)) return base;
  try {
    return execFileSync('git', ['merge-base', head, 'origin/main'], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function writeOutputs(result) {
  const outputs = {
    scope: result.scope,
    reason: result.reason,
    build_mode: result.buildMode,
    evidence_only: result.evidenceOnly,
    code_changed: result.codeChanged,
    styles_changed: result.stylesChanged,
    content_changed: result.contentChanged,
    data_changed: result.dataChanged,
    tests_changed: result.testsChanged,
    workflows_changed: result.workflowsChanged,
    automation_changed: result.automationChanged,
    automation_only: result.automationOnly,
    dependencies_changed: result.dependenciesChanged,
    build_required: result.buildRequired,
    unit_required: result.unitRequired,
    browser_required: result.browserRequired,
    accessibility_required: result.accessibilityRequired,
    lighthouse_required: result.lighthouseRequired,
    data_required: result.dataRequired,
    security_required: result.securityRequired,
    workflow_lint_required: result.workflowLintRequired,
  };
  process.stdout.write(`${Object.entries(outputs).map(([key, value]) => `${key}=${value}`).join('\n')}\n`);
}

function runCli() {
  const head = argumentValue('--head') || 'HEAD';
  const base = resolveBase(argumentValue('--base'), head);
  let result = fullChangeMap('base-unavailable');

  if (base) {
    try {
      const diff = execFileSync('git', ['diff', '--name-status', '-z', `${base}..${head}`], {
        encoding: 'utf8',
      });
      result = classifyNameStatus(diff);
    } catch {
      result = fullChangeMap('diff-failed');
    }
  }

  const jsonPath = argumentValue('--json');
  if (jsonPath) writeFileSync(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
  writeOutputs(result);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) runCli();
