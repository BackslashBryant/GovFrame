import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readdirSync, realpathSync, rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';

const protectedSegment = /^(?:\.git|\.env(?:\..*)?|polic(?:y|ies)|baselines?)$/i;
const protectedFiles = [
  'data/source-baselines.json', 'data/source-refresh-contract.json',
  'data/source-url-policy.json', 'data/source-refresh-policy.json',
];

function inside(root, path) {
  const rel = relative(root, path);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`Transaction path must stay strictly inside root: ${path}`);
  }
}

function inspectPath(root, path, recursive = false) {
  inside(root, path);
  let cursor = root;
  for (const part of relative(root, path).split(sep)) {
    cursor = join(cursor, part);
    if (!existsSync(cursor)) {
      // existsSync follows links, including dangling links; lstat does not.
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink transaction path: ${cursor}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      continue;
    }
    if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink transaction path: ${cursor}`);
  }
  if (!existsSync(path)) return;
  const stat = lstatSync(path);
  if (!stat.isFile() && !stat.isDirectory()) throw new Error(`Unsupported transaction file type: ${path}`);
  if (recursive && stat.isDirectory()) {
    for (const name of readdirSync(path)) inspectPath(root, join(path, name), true);
  }
}

function copyTree(source, destination) {
  const stat = lstatSync(source);
  if (stat.isDirectory()) {
    mkdirSync(destination, { recursive: true });
    for (const name of readdirSync(source)) copyTree(join(source, name), join(destination, name));
  } else {
    mkdirSync(resolve(destination, '..'), { recursive: true });
    copyFileSync(source, destination);
  }
  chmodSync(destination, stat.mode & 0o777);
}

function declaredPaths(root, paths) {
  if (!Array.isArray(paths) || !paths.length) throw new Error('Source transaction requires declared paths');
  const result = paths.map((path) => {
    if (typeof path !== 'string' || !path || isAbsolute(path) || win32.isAbsolute(path)
      || path.includes(':') || path.includes('\0')) throw new Error(`Invalid transaction path: ${path}`);
    const segments = path.split(/[\\/]/);
    if (segments.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || protectedSegment.test(part))) {
      throw new Error(`Protected or traversing transaction path: ${path}`);
    }
    const target = resolve(root, ...segments);
    inside(root, target);
    if (protectedFiles.some((file) => {
      const protectedPath = resolve(root, file).toLowerCase();
      return protectedPath === target.toLowerCase() || protectedPath.startsWith(`${target.toLowerCase()}${sep}`);
    })) throw new Error(`Transaction path overlaps protected policy: ${path}`);
    // A transaction cannot replace its own snapshots or their ancestors.
    const snapshotRoot = join(root, '.local', 'source-transactions');
    const key = target.toLowerCase();
    const snapshotKey = snapshotRoot.toLowerCase();
    if (key === snapshotKey || snapshotKey.startsWith(`${key}${sep}`) || key.startsWith(`${snapshotKey}${sep}`)) {
      throw new Error(`Transaction path overlaps snapshot storage: ${path}`);
    }
    inspectPath(root, target, true);
    return target;
  });
  const sorted = result.map((path) => path.toLowerCase()).sort();
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted.slice(0, index).some((prior) => sorted[index] === prior || sorted[index].startsWith(`${prior}${sep}`))) {
      throw new Error('Overlapping transaction paths');
    }
  }
  return result;
}

/** Run one source against its immediate last-good filesystem state. */
export async function runSourceTransaction({
  root, sourceId, paths, attempts = 1, operation, validate, onQuarantine,
}) {
  if (!Number.isSafeInteger(attempts) || attempts < 1 || typeof operation !== 'function'
    || !sourceId || (validate !== undefined && typeof validate !== 'function')
    || (onQuarantine !== undefined && typeof onQuarantine !== 'function')) {
    throw new Error('Invalid source transaction arguments');
  }
  const requestedRoot = resolve(root);
  for (let cursor = requestedRoot; ; cursor = dirname(cursor)) {
    if (lstatSync(cursor).isSymbolicLink()) throw new Error('Symlink transaction root');
    if (dirname(cursor) === cursor) break;
  }
  root = realpathSync(requestedRoot);
  const targets = declaredPaths(root, paths);
  const storage = join(root, '.local', 'source-transactions');
  inspectPath(root, storage);
  mkdirSync(storage, { recursive: true });
  const snapshot = mkdtempSync(join(storage, 'source-'));
  try {
    const originals = targets.map((path, index) => {
      const present = existsSync(path);
      const backup = join(snapshot, String(index));
      if (present) copyTree(path, backup);
      return { path, backup, present };
    });
    function restore() {
      // Verify the complete boundary before removing anything.
      for (const { path } of originals) inspectPath(root, path, true);
      for (const { path, backup, present } of originals) {
        rmSync(path, { recursive: true, force: true });
        if (present) copyTree(backup, path);
      }
    }
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const context = { root, sourceId, attempt };
      let value;
      try {
        value = await operation(context);
        if (validate && await validate({ ...context, value }) === false) {
          throw new Error('Source transaction validation rejected output');
        }
      } catch (error) {
        lastError = error;
        restore();
        if (attempt < attempts) continue;
        const result = { status: 'quarantined', sourceId, attempts: attempt, error: String(lastError?.message || lastError) };
        if (onQuarantine) await onQuarantine(result);
        return result;
      }
      // Boundary failures are infrastructure errors, never source quarantine.
      for (const path of targets) inspectPath(root, path, true);
      return { status: 'accepted', sourceId, attempts: attempt, value };
    }
  } finally {
    inspectPath(root, snapshot, true);
    rmSync(snapshot, { recursive: true, force: true });
  }
}
