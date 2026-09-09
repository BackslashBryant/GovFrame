#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve, relative } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_JSON = "package.json";
const GENERATION_SCRIPT_ROOTS = ["build:data", "generate:data"];

function normalize(path) {
  return path.replaceAll("\\", "/");
}

function trackedSourceData(root) {
  return execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "data", "maps"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean)
    .map(normalize)
    .filter((path) => !path.startsWith("data/generated/"));
}

export function discoverGenerationEntrypoints(
  scripts,
  roots = GENERATION_SCRIPT_ROOTS,
) {
  const pending = [...roots];
  const visitedScripts = new Set();
  const entrypoints = new Set();

  while (pending.length) {
    const scriptName = pending.pop();
    if (!scriptName || visitedScripts.has(scriptName)) continue;
    const command = scripts[scriptName];
    if (typeof command !== "string" || !command.trim()) {
      throw new Error(`Generated-data package script missing: ${scriptName}`);
    }
    visitedScripts.add(scriptName);

    for (const segment of command.split(/\s*&&\s*/)) {
      const npmRun = segment.match(/^npm(?:\.cmd)?\s+run\s+([^\s]+)$/);
      if (npmRun) {
        pending.push(npmRun[1]);
        continue;
      }

      const localEntrypoint = segment.match(
        /^(?:node|tsx)\s+(\.\/[\w./-]+\.(?:c?js|mjs|tsx?))$/,
      );
      if (localEntrypoint) {
        entrypoints.add(normalize(localEntrypoint[1]).replace(/^\.\//, ""));
        continue;
      }

      throw new Error(
        `Unsupported generated-data command in ${scriptName}: ${segment}`,
      );
    }
  }

  return [...entrypoints].sort();
}

function generationEntrypoints(root) {
  const packageJson = JSON.parse(readFileSync(resolve(root, PACKAGE_JSON), "utf8"));
  return discoverGenerationEntrypoints(packageJson.scripts || {});
}

function localDependencies(entrypoints, root) {
  const pending = entrypoints.map((path) => resolve(root, path));
  const visited = new Set();
  const importPattern = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;

  while (pending.length) {
    const absolutePath = pending.pop();
    if (!absolutePath || visited.has(absolutePath)) continue;
    if (!existsSync(absolutePath)) {
      throw new Error(`Generated-data dependency missing: ${relative(root, absolutePath)}`);
    }
    visited.add(absolutePath);
    const source = readFileSync(absolutePath, "utf8");
    for (const match of source.matchAll(importPattern)) {
      const specifier = match[1];
      if (!specifier.startsWith(".")) continue;
      let dependency = resolve(dirname(absolutePath), specifier);
      if (!extname(dependency)) dependency += ".mjs";
      const rel = normalize(relative(root, dependency));
      if (rel.startsWith("data/generated/")) continue;
      pending.push(dependency);
    }
  }

  return [...visited].map((path) => normalize(relative(root, path)));
}

export function generatedDataCacheInputs(root = ROOT) {
  return [...new Set([
    PACKAGE_JSON,
    "package-lock.json",
    ...trackedSourceData(root),
    ...localDependencies(generationEntrypoints(root), root),
  ])].sort();
}

export function calculateGeneratedDataCacheKey(root = ROOT) {
  const hash = createHash("sha256");
  for (const path of generatedDataCacheInputs(root)) {
    hash.update(path);
    hash.update("\0");
    // A refresh can add or remove source snapshots before staging them. Hash
    // that working-tree state; completeness is checked by the data gates.
    try {
      const bytes = readFileSync(resolve(root, path));
      hash.update("present\0");
      hash.update(bytes);
    } catch (error) {
      if (error.code !== "ENOENT" || !/^(data|maps)\//.test(path)) throw error;
      hash.update("absent\0");
    }
    hash.update("\0");
  }
  return hash.digest("hex");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.stdout.write(`${calculateGeneratedDataCacheKey()}\n`);
}
