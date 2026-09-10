#!/usr/bin/env node

import process from 'node:process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { runProcessSync } from './lib/process-runner.mjs';

const npmExecPath = process.env.npm_execpath;
if (!npmExecPath) {
  throw new Error('Lockfile verification requires npm_execpath; invoke it through npm.');
}

const root = process.cwd();
const { packageManager } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
if (!/^npm@\d+\.\d+\.\d+$/.test(packageManager || '')) throw new Error('Pin the CI npm version in packageManager');
const parent = resolve(root, '.local');
mkdirSync(parent, { recursive: true });
const isolated = mkdtempSync(join(parent, 'lockfile-check-'));
if (dirname(isolated) !== parent) throw new Error('Lockfile scratch directory escaped the repository');
try {
  for (const name of ['package.json', 'package-lock.json', '.npmrc']) {
    if (existsSync(join(root, name))) copyFileSync(join(root, name), join(isolated, name));
  }
  // Existing node_modules and a different npm major can both hide omissions
  // from a lockfile. Exercise the CI resolver against manifests alone.
  runProcessSync(process.execPath, [npmExecPath, 'exec', '--yes', `--package=${packageManager}`, '--',
    'npm', 'ci', '--dry-run', '--ignore-scripts', '--no-audit', '--no-fund'], {
    cwd: isolated, label: `${packageManager} isolated lockfile verification`, stdio: 'inherit',
  });
} finally {
  rmSync(isolated, { recursive: true, force: true });
}
