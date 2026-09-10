#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { INGESTION_STAGES, INGESTION_TASKS, validateIngestionPipelineDefinition } from './lib/ingestion-pipeline.mjs';
import { loadSourceRefreshContract, validateSourceRefreshContract } from './lib/source-refresh-contract.mjs';
import { sourceUnitsForTask, localProjectionForTask, loadSourceUnitInventory } from './lib/refresh-source-outputs.mjs';
import { runSourceTransaction } from './lib/source-transaction.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function executeRefreshUnit(unit, root, spawn = spawnSync) {
  const args = unit.script === 'fetch-disa-stigs.mjs' && process.platform === 'win32'
    ? ['--max-old-space-size=1024', '--expose-gc', join(root, 'scripts', unit.script), ...unit.args]
    : [join(root, 'scripts', unit.script), ...unit.args];
  const result = spawn(process.execPath, args, {
    cwd: root, stdio: ['ignore', 'inherit', 'pipe'], encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024, timeout: 15 * 60 * 1000,
    env: { ...process.env, CONTROL_ATLAS_REQUIRE_FRESH_FETCH: '1' },
  });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${unit.script} exited ${result.status}: ${String(result.stderr || result.signal || 'No diagnostic was recorded').trim().slice(-4000)}`);
}

export async function runRefreshPipeline({
  root = ROOT, tasks = INGESTION_TASKS, executor = executeRefreshUnit,
  validateCandidate, recordResult, finalize, describeSources = sourceUnitsForTask,
  describeProjection = localProjectionForTask,
} = {}) {
  if (typeof validateCandidate !== 'function' || typeof finalize !== 'function') {
    throw new Error('Refresh requires candidate validation and finalization gates');
  }
  // Resolve all ownership before any fetch or mutation.
  const inventory = loadSourceUnitInventory(root, tasks);
  const execution = tasks.map((task) => {
    if (task.isolation !== (task.remote_fetch === true ? 'quarantinable' : 'fail_fast')) {
      throw new Error(`Invalid isolation for ${task.id}`);
    }
    const units = task.remote_fetch ? describeSources(task, inventory) : [];
    if (task.remote_fetch && (!units.length || units.some((unit) => !unit.paths?.length))) {
      throw new Error(`Missing output ownership for ${task.id}`);
    }
    return { task, units, projection: describeProjection(task) };
  });
  console.log(`Refresh plan: ${execution.length} tasks; ${execution.reduce((sum, entry) => sum + entry.units.length, 0)} remote source units; sequential execution; retries declared per unit.`);
  const startedAt = new Date().toISOString();
  const results = [];
  const sourceResults = [];
  function save(status, failedTask = null) {
    const timing = { started_at: startedAt, completed_at: status === 'running' ? null : new Date().toISOString() };
    writeJsonAtomically(join(root, 'data', 'ingestion-pipeline-manifest.json'), {
      schema_version: '1.0', pipeline: 'Control Atlas public-source ingestion',
      stages: INGESTION_STAGES, ...timing, status, failed_task: failedTask, results,
    });
    writeJsonAtomically(join(root, '.local', 'source-refresh-results.json'), {
      schema_version: '1.0', ...timing, status, failed_task: failedTask, results: sourceResults,
      successfulPaths: [...new Set(sourceResults.flatMap((entry) => entry.successfulPaths))],
      quarantinedPaths: [...new Set(sourceResults.flatMap((entry) => entry.quarantinedPaths))],
    });
  }
  save('running');
  for (const { task, units, projection } of execution) {
    console.log(`\n==> [${task.stages.join(' + ')}] ${task.id}`);
    const taskStarted = Date.now();
    const taskSources = [];
    const taskRecord = { task_id: task.id, script: task.script, args: task.args || [], stages: task.stages, scope: task.scope };
    try {
      if (task.remote_fetch) {
        for (const unit of units) {
          const result = await runSourceTransaction({
            root, sourceId: unit.sourceId, paths: unit.paths, attempts: unit.retries || 1,
            operation: async () => {
              await executor(unit, root);
              if (unit.followUp) await executor({ ...unit, ...unit.followUp, followUp: undefined }, root);
            },
            validate: () => validateCandidate(unit),
          });
          const entry = {
            ...unit, status: result.status, attempts: result.attempts,
            ...(result.error ? { error: result.error } : {}),
            successfulPaths: result.status === 'accepted' ? [...unit.paths] : [],
            quarantinedPaths: result.status === 'quarantined' ? [...unit.paths] : [],
          };
          sourceResults.push(entry);
          taskSources.push(entry);
          await recordResult?.(entry);
          save('running');
        }
      } else {
        await executor({ ...task, taskId: task.id, sourceId: task.id, args: task.args || [] }, root);
      }
      if (projection) await executor(projection, root);
      const quarantined = taskSources.filter((entry) => entry.status === 'quarantined').length;
      results.push({
        ...taskRecord,
        status: quarantined ? (quarantined === taskSources.length ? 'quarantined' : 'partial') : 'complete',
        attempts: Math.max(1, ...taskSources.map((entry) => entry.attempts)),
        duration_ms: Date.now() - taskStarted,
        ...(taskSources.length ? { source_results: taskSources.map(({ sourceId, status, attempts }) => ({ source_id: sourceId, status, attempts })) } : {}),
      });
      save('running');
    } catch (error) {
      results.push({ ...taskRecord, status: 'failed', attempts: 1, duration_ms: Date.now() - taskStarted, error: String(error.message || error) });
      save('failed', task.id);
      throw error;
    }
  }
  try {
    await finalize(sourceResults);
  } catch (error) {
    save('failed', 'candidate-finalization');
    throw error;
  }
  const status = sourceResults.some((entry) => entry.status === 'quarantined') ? 'complete_with_quarantine' : 'complete';
  save(status);
  return { status, results, sourceResults };
}

async function main() {
  const errors = validateIngestionPipelineDefinition();
  if (errors.length) throw new Error(`Invalid ingestion pipeline: ${errors.join('; ')}`);
  const contractErrors = validateSourceRefreshContract(
    loadSourceRefreshContract(), INGESTION_TASKS,
    readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    JSON.parse(readFileSync(join(ROOT, 'data', 'source-registry.json'), 'utf8')),
  );
  if (contractErrors.length) throw new Error(`Invalid source refresh contract: ${contractErrors.join('; ')}`);
  const { createCandidateGate } = await import('./lib/refresh-candidate-gate.mjs');
  const gate = await createCandidateGate(ROOT);
  const result = await runRefreshPipeline({ ...gate, root: ROOT });
  console.log(`\nrefresh:data ${result.status}; source outcomes: .local/source-refresh-results.json`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
