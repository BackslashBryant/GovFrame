export const LIGHTHOUSE_THRESHOLDS = Object.freeze({
  lcpMs: 2_500,
  tbtMs: 200,
  cls: 0.1,
});

export function validateLighthouseReport(report) {
  if (report.runtimeError) throw new Error(`Lighthouse runtime failure: ${report.runtimeError.code}`);
  for (const key of ['largest-contentful-paint', 'total-blocking-time', 'cumulative-layout-shift']) {
    const value = report.audits?.[key]?.numericValue;
    if (!Number.isFinite(value) || value < 0) throw new Error(`Missing or invalid Lighthouse metric: ${key}`);
  }
  for (const key of ['performance', 'accessibility']) {
    const score = report.categories?.[key]?.score;
    if (!Number.isFinite(score) || score < 0 || score > 1) throw new Error(`Missing or invalid Lighthouse score: ${key}`);
  }
}

export function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarizeRouteMedians(runs) {
  const grouped = new Map();
  for (const run of runs) {
    const routeRuns = grouped.get(run.url) || [];
    routeRuns.push(run);
    grouped.set(run.url, routeRuns);
  }

  return [...grouped.entries()]
    .map(([url, routeRuns]) => ({
      url,
      runs: routeRuns.length,
      performance: median(routeRuns.map((run) => run.performance)),
      accessibility: median(routeRuns.map((run) => run.accessibility)),
      lcpMs: median(routeRuns.map((run) => run.lcpMs)),
      cls: median(routeRuns.map((run) => run.cls)),
      tbtMs: median(routeRuns.map((run) => run.tbtMs)),
    }))
    .sort((left, right) => left.url.localeCompare(right.url));
}

// The collector takes two cold-cache/endpoint-security warmups before the
// three measured samples. Selecting by timestamp keeps the launch contract at
// three runs per route without letting Windows file-scanner startup dominate
// the product measurement.
export function selectLatestRouteRuns(runs, count = 3) {
  const grouped = new Map();
  for (const run of runs) {
    const routeRuns = grouped.get(run.url) || [];
    routeRuns.push(run);
    grouped.set(run.url, routeRuns);
  }
  return [...grouped.values()].flatMap((routeRuns) =>
    routeRuns
      .sort(
        (left, right) =>
          Date.parse(right.fetchTime || '') - Date.parse(left.fetchTime || ''),
      )
      .slice(0, count),
  );
}

export function routeThresholdFailures(
  routeMedians,
  thresholds = LIGHTHOUSE_THRESHOLDS,
) {
  return routeMedians.flatMap((route) => {
    const failures = [];
    if (route.runs < 3) {
      failures.push(`requires 3 runs; found ${route.runs}`);
    }
    if (route.lcpMs > thresholds.lcpMs) {
      failures.push(`LCP ${route.lcpMs}ms > ${thresholds.lcpMs}ms`);
    }
    if (route.tbtMs > thresholds.tbtMs) {
      failures.push(`TBT ${route.tbtMs}ms > ${thresholds.tbtMs}ms`);
    }
    if (route.cls > thresholds.cls) {
      failures.push(`CLS ${route.cls} > ${thresholds.cls}`);
    }
    return failures.length > 0
      ? [{ url: route.url, failures }]
      : [];
  });
}
