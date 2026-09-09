import { execFileSync } from 'node:child_process';
import { createCandidateGate } from '../scripts/lib/refresh-candidate-gate.mjs';
import { assertRefreshPaths } from './automerge-source-refresh.mjs';

const root = process.cwd();
const base = process.env.CONTROL_ATLAS_SOURCE_BASELINE_REF || 'HEAD';
if (base !== 'HEAD' && !/^[a-f0-9]{40}$/.test(base)) throw new Error('Admission base must be an exact Git commit');
const readCommitted = (path) => execFileSync('git', ['show', `${base}:${path}`], { cwd: root, maxBuffer: 128 * 1024 * 1024 });
const paths = execFileSync('git', ['diff', '--name-only', '-z', base, '--', '.'], { encoding: 'utf8' }).split('\0').filter(Boolean);
assertRefreshPaths(paths);
createCandidateGate(root, { readCommitted }).verifyPublished();
console.log(`Source refresh admission passed for ${paths.length} changed paths against ${base}.`);
