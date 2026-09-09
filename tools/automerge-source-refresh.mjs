import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function assertRefreshPaths(paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Refresh has no recorded changed files');
  for (const path of paths) {
    if (typeof path !== 'string' || !/^(data|maps)\/.+\.json$/.test(path) ||
        path.includes('..') || path.includes('\\') || path.startsWith('data/generated/') ||
        path.startsWith('data/schemas/') || /^data\/source-(refresh-(policy|contract)|url-policy)\.json$/.test(path)) {
      throw new Error(`Refresh changed a protected path: ${path}`);
    }
  }
}

export function refreshMergeDecision(pr, paths, runs, repository = 'RAMBULLS/control-atlas') {
  if (pr.state !== 'open' || pr.draft) return { ready: false, reason: 'not_open_ready_pr' };
  if (pr.head?.repo?.full_name !== repository || pr.base?.repo?.full_name !== repository ||
      pr.head?.ref !== 'automation/source-refresh' || pr.base?.ref !== 'main' ||
      pr.user?.login !== 'control-atlas-source-refresh[bot]') throw new Error('Unexpected refresh PR identity');
  assertRefreshPaths(paths);
  for (const workflow of ['.github/workflows/ci.yml', '.github/workflows/security.yml']) {
    const matching = runs.filter((run) => run.path === workflow && run.head_sha === pr.head.sha && run.event === 'pull_request')
      .sort((a, b) => b.id - a.id);
    if (!matching.length || matching[0].status !== 'completed' || matching[0].conclusion !== 'success') {
      return { ready: false, reason: `waiting_for_${workflow}` };
    }
  }
  if (pr.mergeable !== true || pr.mergeable_state !== 'clean') return { ready: false, reason: 'branch_protection_or_merge_conflict' };
  return { ready: true, sha: pr.head.sha };
}

export function autoMergeRefresh(env = process.env) {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REPOSITORY !== 'RAMBULLS/control-atlas') throw new Error('Automerge is restricted to the repository workflow');
  const api = (endpoint, body, token = env.GH_TOKEN) => JSON.parse(execFileSync('gh',
    ['api', endpoint, ...(body ? ['--method', 'PUT', '--input', '-'] : [])],
    { encoding: 'utf8', env: { ...env, GH_TOKEN: token }, ...(body ? { input: JSON.stringify(body) } : {}), maxBuffer: 8 * 1024 * 1024 }));
  const repository = env.GITHUB_REPOSITORY;
  const prs = api(`repos/${repository}/pulls?state=open&head=RAMBULLS:automation/source-refresh&base=main`);
  if (!prs.length) return { ready: false, reason: 'no_refresh_pr' };
  if (prs.length !== 1) throw new Error('Ambiguous refresh PR');
  const pr = api(`repos/${repository}/pulls/${prs[0].number}`);
  const paths = [];
  for (let page = 1; ; page += 1) {
    const files = api(`repos/${repository}/pulls/${pr.number}/files?per_page=100&page=${page}`);
    paths.push(...files.map((file) => file.filename));
    if (files.length < 100) break;
  }
  if (paths.length !== pr.changed_files) throw new Error('Incomplete PR file inventory');
  const runs = api(`repos/${repository}/actions/runs?head_sha=${pr.head.sha}&event=pull_request&per_page=100`).workflow_runs;
  const decision = refreshMergeDecision(pr, paths, runs, repository);
  if (!decision.ready) return decision;
  if (!env.REFRESH_MERGE_TOKEN) throw new Error('Missing repository-scoped App token');
  const merged = api(`repos/${repository}/pulls/${pr.number}/merge`, { sha: decision.sha, merge_method: 'squash' }, env.REFRESH_MERGE_TOKEN);
  if (!merged.merged) throw new Error('GitHub refused refresh merge');
  return { ...decision, merged: true, number: pr.number, merge_sha: merged.sha };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(autoMergeRefresh()));
}
