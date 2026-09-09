#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const BRANCH = 'automation/source-refresh';
const JOB = 'Weekly validated data refresh';

export function validateRecovery({ expectedSha, commit, run, jobs, paths, log }) {
  const errors = [];
  if (!/^[a-f0-9]{40}$/.test(expectedSha || '') || commit.sha !== expectedSha) errors.push('Refresh branch does not match the requested SHA');
  if (run.head_branch !== 'main' || run.path !== '.github/workflows/ci.yml' ||
      !['schedule', 'workflow_dispatch'].includes(run.event) || run.status !== 'completed') errors.push('Run is not a completed main refresh');
  if (commit.parents?.length !== 1 || commit.parents[0].sha !== run.head_sha) errors.push('Snapshot parent does not match the validated run');
  const job = jobs.find((entry) => entry.name === JOB);
  for (const name of ['Refresh validated build-time data', 'Verify refreshed repository', 'Run npm run sbom:generate']) {
    if (!job?.steps?.some((step) => step.name === name && step.conclusion === 'success')) errors.push(`Missing successful gate: ${name}`);
  }
  if (!paths.length || paths.some((path) => !/^(data|maps)\//.test(path) || path.startsWith('data/generated/'))) errors.push('Snapshot contains changes outside tracked data and maps');
  // Match the action's rev-parse output, not arbitrary text emitted by a source.
  const lines = log.split(/\r?\n/);
  const recorded = lines.some((line, index) => line.includes('Run peter-evans/create-pull-request@') &&
    line.endsWith('[command]/usr/bin/git rev-parse automation/source-refresh') &&
    lines[index + 1]?.endsWith(` ${expectedSha}`));
  if (!recorded) errors.push('Original PR action did not record the requested snapshot');
  return errors;
}

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

export function recoverRefreshPr(environment = process.env, { verifyOnly = false } = {}) {
  const repo = environment.GITHUB_REPOSITORY;
  const runId = environment.REFRESH_RUN_ID;
  const expectedSha = environment.REFRESH_HEAD_SHA;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '') || !/^\d+$/.test(runId || '') || !/^[a-f0-9]{40}$/.test(expectedSha || '')) throw new Error('Repository, numeric run ID and full snapshot SHA are required');
  const api = (path) => JSON.parse(gh(['api', `repos/${repo}/${path}`]));
  const commit = api(`commits/${BRANCH}`);
  const run = api(`actions/runs/${runId}`);
  const jobs = JSON.parse(gh(['api', '--paginate', '--slurp', `repos/${repo}/actions/runs/${runId}/jobs?per_page=100`])).flatMap((page) => page.jobs);
  // Git handles the full diff; GitHub's compare API truncates large file lists.
  execFileSync('git', ['fetch', '--no-tags', '--depth=2', 'origin', BRANCH], { stdio: 'pipe' });
  const fetchedSha = execFileSync('git', ['rev-parse', 'FETCH_HEAD'], { encoding: 'utf8' }).trim();
  if (fetchedSha !== expectedSha) throw new Error('Refresh branch moved during recovery');
  const paths = execFileSync('git', ['diff', '--no-renames', '--name-only', '-z', `${expectedSha}^`, expectedSha], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const log = gh(['run', 'view', runId, '--repo', repo, '--log']);
  const errors = validateRecovery({ expectedSha, commit, run, jobs, paths, log });
  if (errors.length) throw new Error(errors.join('\n'));
  if (verifyOnly) return `Verified ${expectedSha}: ${paths.length} data/map paths; no PR created`;
  if (environment.GITHUB_ACTIONS !== 'true') throw new Error('Create the bot PR through the recovery workflow; use --verify-only locally');
  const existing = JSON.parse(gh(['pr', 'list', '--repo', repo, '--head', BRANCH, '--state', 'open', '--json', 'url']));
  if (existing.length) return existing[0].url;
  // Re-read immediately before publication; recovery never moves the branch.
  if (api(`commits/${BRANCH}`).sha !== expectedSha) throw new Error('Refresh branch moved before PR creation');
  return gh(['pr', 'create', '--repo', repo, '--base', 'main', '--head', BRANCH, '--draft',
    '--title', 'chore(data): review validated public source refresh',
    '--body', `Recovered validated snapshot ${expectedSha} from https://github.com/${repo}/actions/runs/${runId}.\n\nIngestion, full repository verification and SBOM generation passed before PR creation was blocked by repository settings. This recovery did not refetch data. The draft remains held until autonomous admission safeguards are enabled.`]).trim();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try { console.log(recoverRefreshPr(process.env, { verifyOnly: process.argv.includes('--verify-only') })); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
