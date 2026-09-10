#!/usr/bin/env node
/**
 * Synchronizes the allowed public files from this repository into a staging directory.
 * This ensures that internal agent context, .cursor rules, and private tools are never
 * pushed to the public open-source version of the Control Atlas repository.
 */

import { cpSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist-public');
const SITE_DIST_RELATIVE = 'dist/site';
const SITE_DIST = join(ROOT, 'dist', 'site');

// Explicit allowlist of files and directories that are safe to release.
// Anything not on this list will be left behind.
const ALLOWLIST = [
  'scripts/',
  'tests/',
  'ops/',
  '.github/workflows/ci.yml',
  '.github/workflows/pages.yml',
  '.github/workflows/nightly-refresh.yml',
  '.github/workflows/nightly-quality.yml',
  'tools/check-dependencies.mjs',
  'tools/docs-audit.mjs',
  'tools/guard-runner.mjs',
  'tools/ports-status.mjs',
  'tools/preflight.mjs',
  'tools/dev-guarded.mjs',
  'docs/',
  'src/',
  'package.json',
  'package-lock.json',
  'README.md',
  'LICENSE',
  'CONTRIBUTING.md',
  'CHANGELOG.md',
  'QUICKSTART.md',
  'CODEOWNERS',
  '.editorconfig',
  '.gitignore'
];

function main() {
  if (!existsSync(SITE_DIST)) {
    throw new Error('Run `npm run build:site` before syncing the public release.');
  }

  if (existsSync(DIST)) {
    rmSync(DIST, { recursive: true, force: true });
  }
  mkdirSync(DIST, { recursive: true });

  cpSync(SITE_DIST, DIST, { recursive: true });

  console.log('Staging public files...');
  let count = 1;

  for (const item of ALLOWLIST) {
    const srcPath = join(ROOT, item);
    const destPath = join(DIST, item);

    if (existsSync(srcPath)) {
      if (item.endsWith('/')) {
        // It's a directory
        mkdirSync(destPath, { recursive: true });
        cpSync(srcPath, destPath, { recursive: true });
      } else {
        // It's a file
        mkdirSync(dirname(destPath), { recursive: true });
        cpSync(srcPath, destPath);
      }
      console.log(`  + ${item}`);
      count++;
    } else {
      console.warn(`  - Warning: Allowed item not found: ${item}`);
    }
  }

  console.log(`\nStaged ${count} allowed paths to ${DIST}/`);
  console.log('Ready for public sync.');
}

try {
  main();
} catch (err) {
  console.error('Failed to sync public files:', err);
  process.exit(1);
}
