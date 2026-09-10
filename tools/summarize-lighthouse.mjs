#!/usr/bin/env node

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  LIGHTHOUSE_THRESHOLDS,
  routeThresholdFailures,
  selectLatestRouteRuns,
  summarizeRouteMedians,
  validateLighthouseReport,
} from './lighthouse-metrics.mjs';

const REPORT_DIR = process.env.LIGHTHOUSE_REPORT_DIR
  ? resolve(process.cwd(), process.env.LIGHTHOUSE_REPORT_DIR)
  : join(process.cwd(), 'artifacts', 'lighthouse-ci');
const reportFiles = (await readdir(REPORT_DIR)).filter((name) =>
  name.endsWith('.report.json'),
);

if (reportFiles.length === 0) {
  throw new Error(`No Lighthouse JSON reports found in ${REPORT_DIR}`);
}

const rows = [];
for (const reportFile of reportFiles) {
  const report = JSON.parse(await readFile(join(REPORT_DIR, reportFile), 'utf8'));
  validateLighthouseReport(report);
  rows.push({
    url: report.requestedUrl || report.finalDisplayedUrl || report.finalUrl,
    fetchTime: report.fetchTime,
    benchmarkIndex: report.environment?.benchmarkIndex ?? null,
    longTasks: report.audits['long-tasks']?.details?.items ?? [],
    performance: Math.round((report.categories.performance?.score ?? 0) * 100),
    accessibility: Math.round((report.categories.accessibility?.score ?? 0) * 100),
    lcpMs: Math.round(report.audits['largest-contentful-paint']?.numericValue ?? 0),
    cls: Number((report.audits['cumulative-layout-shift']?.numericValue ?? 0).toFixed(3)),
    tbtMs: Math.round(report.audits['total-blocking-time']?.numericValue ?? 0),
  });
}

const currentRows = selectLatestRouteRuns(rows);
currentRows.sort((a, b) => a.url.localeCompare(b.url));
const routeMedians = summarizeRouteMedians(currentRows);
const thresholdFailures = routeThresholdFailures(routeMedians);
const summary = {
  generatedAt: new Date().toISOString(),
  evidence: 'synthetic Lighthouse for the recorded requested URLs; not field or real-device evidence',
  thresholds: LIGHTHOUSE_THRESHOLDS,
  routeMedians,
  thresholdFailures,
  runs: currentRows,
};

await writeFile(
  join(REPORT_DIR, 'summary.json'),
  `${JSON.stringify(summary, null, 2)}\n`,
);

console.table(currentRows);
console.table(routeMedians);
if (thresholdFailures.length > 0) {
  console.error('Lighthouse route-median gate failed:');
  for (const failure of thresholdFailures) {
    console.error(`- ${failure.url}: ${failure.failures.join('; ')}`);
  }
  process.exitCode = 1;
}
