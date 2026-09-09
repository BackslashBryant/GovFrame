#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,119}$/;
const MARKER = /^<!-- control-atlas-refresh:([a-z0-9][a-z0-9._-]{0,119}) -->\r?\n/;

function safeText(value) {
  return String(value ?? '')
    .replace(/(?:github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, '[redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer|token)\s+)\S+/gi, '$1[redacted]')
    .replace(/([?&](?:token|access_token|key|api_key)=)[^\s&#]+/gi, '$1[redacted]')
    .split('').map((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? ' ' : char).join('')
    .slice(0, 2000)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/([\\`*_{}[\]()#+.!|~])/g, '\\$1').replace(/@/g, '@\u200b');
}

function checkedRunUrl(runUrl) {
  if (!runUrl) return null;
  const url = new URL(runUrl);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password ||
      !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/actions\/runs\/\d+$/.test(url.pathname) || url.search || url.hash) {
    throw new Error('Invalid GitHub Actions run URL');
  }
  return url.href;
}

export function planAlertChanges(results, issues = [], runUrl = null) {
  if (results == null) return [];
  if (!Array.isArray(results) || !Array.isArray(issues)) throw new Error('Expected source results and GitHub issues arrays');
  const run = checkedRunUrl(runUrl);
  const sources = new Map();
  for (const result of results) {
    if (!SOURCE_ID.test(result?.sourceId || '')) throw new Error('Invalid refresh source ID');
    if (sources.has(result.sourceId)) {
      if (JSON.stringify(sources.get(result.sourceId)) !== JSON.stringify(result)) throw new Error(`Conflicting source results: ${result.sourceId}`);
      continue;
    }
    sources.set(result.sourceId, result);
  }
  const plans = [];
  for (const [sourceId, result] of sources) {
    if (!['accepted', 'quarantined'].includes(result.status)) continue;
    const matching = issues.filter((issue) => !issue.pull_request &&
      MARKER.exec(issue.body || '')?.[1] === sourceId && Number.isSafeInteger(issue.number) && issue.number > 0)
      .sort((left, right) => left.number - right.number);
    const marker = `<!-- control-atlas-refresh:${sourceId} -->`;
    const link = run ? `\n\n[Refresh run](${run})` : '';
    if (result.status === 'accepted') {
      for (const issue of matching.filter((entry) => entry.state === 'open')) {
        plans.push({ type: 'update', sourceId, number: issue.number, payload: {
          state: 'closed', state_reason: 'completed',
          body: `${marker}\nSource refresh recovered: the source candidate was accepted.${link}`,
        } });
      }
      continue;
    }
    const title = `Source refresh quarantined: ${sourceId}`;
    const attempts = Number.isSafeInteger(result.attempts) && result.attempts > 0 ? result.attempts : 'unknown';
    const body = `${marker}\nThe latest source refresh failed validation or retrieval. Its previously accepted files were retained.\n\nSource: ${sourceId}\n\nAttempts: ${attempts}\n\nReported failure: ${safeText(result.error || 'No diagnostic was recorded.')}\n\nReview the publisher response and refresh validation before retrying.${link}`;
    const [existing, ...duplicates] = matching;
    if (!existing) plans.push({ type: 'create', sourceId, payload: { title, body } });
    else if (existing.state !== 'open' || existing.title !== title || existing.body !== body) {
      plans.push({ type: 'update', sourceId, number: existing.number, payload: { title, body, state: 'open' } });
    }
    for (const duplicate of duplicates.filter((entry) => entry.state === 'open')) {
      plans.push({ type: 'update', sourceId, number: duplicate.number, payload: {
        state: 'closed', state_reason: 'not_planned',
        body: `${marker}\nDuplicate generated alert. Follow issue #${existing.number}.${link}`,
      } });
    }
  }
  return plans;
}

export function reportRefreshAlerts(options = {}) {
  const reportPath = options.reportPath || resolve('.local/source-refresh-results.json');
  if (!existsSync(reportPath)) return [];
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  if (report.schema_version !== '1.0' || !Array.isArray(report.results)) throw new Error('Invalid source refresh report');
  const repository = options.repository || process.env.GITHUB_REPOSITORY || 'RAMBULLS/control-atlas';
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(repository)) throw new Error('Invalid GitHub repository');
  const runUrl = options.runUrl || (process.env.GITHUB_RUN_ID ? `https://github.com/${repository}/actions/runs/${process.env.GITHUB_RUN_ID}` : null);
  // Validate before even issuing the read request.
  planAlertChanges(report.results, [], runUrl);
  const gh = options.execFileImpl || execFileSync;
  const pages = JSON.parse(gh('gh', ['api', '--paginate', '--slurp', `repos/${repository}/issues?state=all&per_page=100`], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }));
  if (!Array.isArray(pages) || pages.some((page) => !Array.isArray(page))) throw new Error('Invalid paginated GitHub issues response');
  const plans = planAlertChanges(report.results, pages.flat(), runUrl);
  for (const plan of plans) {
    gh('gh', ['api', '--method', plan.type === 'create' ? 'POST' : 'PATCH',
      `repos/${repository}/issues${plan.type === 'create' ? '' : `/${plan.number}`}`, '--input', '-'], {
      input: JSON.stringify(plan.payload), encoding: 'utf8', maxBuffer: 1024 * 1024,
    });
  }
  return plans;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    console.log(`Applied ${reportRefreshAlerts().length} source refresh alert changes.`);
  } catch (error) {
    console.error(`Source refresh alert reporting failed: ${safeText(error.message)}`);
    process.exitCode = 1;
  }
}
