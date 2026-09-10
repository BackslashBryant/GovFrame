#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStructuredAssets, selectStructuredAssetCandidatePages } from './lib/nist-pages-discovery.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PROJECTS_PATH = join(ROOT, 'data', 'nist-pages-discovery.json');
const OUT = join(ROOT, 'data', 'nist-structured-asset-discovery.json');
const CONCURRENCY = 6;

async function fetchPage(url) {
  const response = await strictConditionalFetch(url, {
    headers: { 'User-Agent': 'ControlAtlas-ingestion/1.0 (+https://github.com/rambulls/control-atlas)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { html: await response.text(), finalUrl: response.url };
}

async function mapBounded(values, worker) {
  const output = new Array(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await worker(values[index]);
    }
  }));
  return output;
}

function mergeAsset(index, asset, projectName) {
  const existing = index.get(asset.url) || {
    url: asset.url,
    format: asset.format,
    labels: new Set(),
    projects: new Set(),
    source_pages: new Set(),
  };
  if (asset.label) existing.labels.add(asset.label);
  existing.projects.add(projectName);
  existing.source_pages.add(asset.source_page);
  index.set(asset.url, existing);
}

async function main() {
  if (!existsSync(PROJECTS_PATH)) throw new Error('Run npm run discover:nist-pages first');
  const discovery = JSON.parse(readFileSync(PROJECTS_PATH, 'utf8'));
  const pageResults = await mapBounded(discovery.entries, async (project) => {
    const pages = [];
    try {
      const landing = await fetchPage(project.url);
      pages.push({ requested_url: project.url, url: landing.finalUrl, status: 'fetched', depth: 0, html: landing.html });
      if (project.disposition === 'candidate') {
        const childUrls = selectStructuredAssetCandidatePages(landing.html, landing.finalUrl);
        const children = await mapBounded(childUrls, async (url) => {
          try {
            const child = await fetchPage(url);
            return { requested_url: url, url: child.finalUrl, status: 'fetched', depth: 1, html: child.html };
          } catch (error) {
            return { requested_url: url, url, status: 'failed', depth: 1, reason: error.message };
          }
        });
        pages.push(...children);
      }
    } catch (error) {
      pages.push({ requested_url: project.url, url: project.url, status: 'failed', depth: 0, reason: error.message });
    }
    return { project, pages };
  });

  const assetIndex = new Map();
  const pageEvidence = [];
  for (const result of pageResults) {
    for (const page of result.pages) {
      if (page.status === 'fetched') {
        // A publisher page can be large or malformed enough to defeat the HTML
        // parser. Record that page as unparsed and keep going: one bad page is
        // not evidence that discovery itself is broken, and the fetch path above
        // already isolates failures the same way.
        let assets;
        try {
          assets = extractStructuredAssets(page.html, page.url);
        } catch (error) {
          pageEvidence.push({ requested_url: page.requested_url, url: page.url, project: result.project.repo_name, depth: page.depth, status: 'parse_failed', reason: error.message, structured_assets: 0 });
          continue;
        }
        for (const asset of assets) mergeAsset(assetIndex, asset, result.project.repo_name);
        pageEvidence.push({ requested_url: page.requested_url, url: page.url, project: result.project.repo_name, depth: page.depth, status: page.status, structured_assets: assets.length });
      } else {
        pageEvidence.push({ requested_url: page.requested_url, url: page.url, project: result.project.repo_name, depth: page.depth, status: page.status, reason: page.reason, structured_assets: 0 });
      }
    }
  }
  const assets = [...assetIndex.values()].map((asset) => ({
    url: asset.url,
    format: asset.format,
    labels: [...asset.labels].sort((a, b) => a.localeCompare(b, 'en')),
    projects: [...asset.projects].sort((a, b) => a.localeCompare(b, 'en')),
    source_pages: [...asset.source_pages].sort((a, b) => a.localeCompare(b, 'en')),
  })).sort((a, b) => a.url.localeCompare(b.url, 'en'));
  const output = {
    schema_version: '1.0',
    source_inventory: 'data/nist-pages-discovery.json',
    source_inventory_sha256: discovery.source.sha256,
    reconciliation: {
      projects_discovered: discovery.entries.length,
      project_landing_pages_attempted: discovery.entries.length,
      pages_attempted: pageEvidence.length,
      pages_fetched: pageEvidence.filter((page) => page.status === 'fetched').length,
      pages_failed: pageEvidence.filter((page) => page.status === 'failed').length,
      structured_assets_discovered: assets.length,
      spreadsheets_discovered: assets.filter((asset) => asset.format === 'xlsx' || asset.format === 'xls').length,
      csv_files_discovered: assets.filter((asset) => asset.format === 'csv').length,
    },
    pages: pageEvidence,
    assets,
  };
  const previous = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { assets: [] };
  retainUnavailableDiscovery(output, previous);
  validateStructuredAssetCandidate(output, previous);
  writeJsonAtomically(OUT, output);
  console.log(`Discovered ${assets.length} structured assets across ${pageEvidence.length} NIST Pages pages.`);
}

export function retainUnavailableDiscovery(output, previous) {
  const fetched = new Set(output.pages.filter((page) => page.status === 'fetched').flatMap((page) => [page.url, page.requested_url]));
  const urls = new Set(output.assets.map((asset) => asset.url));
  for (const asset of previous.assets || []) {
    if (!urls.has(asset.url) && (asset.source_pages || []).some((page) => !fetched.has(page))) {
      output.assets.push({ ...asset, retention_reason: 'Discovery page unavailable or not checked; retained previously discovered asset' });
    }
  }
  output.assets.sort((a, b) => a.url.localeCompare(b.url, 'en'));
  output.reconciliation.structured_assets_discovered = output.assets.length;
  output.reconciliation.assets_retained = output.assets.filter((asset) => asset.retention_reason).length;
  output.reconciliation.spreadsheets_discovered = output.assets.filter((asset) => ['xlsx', 'xls'].includes(asset.format)).length;
  output.reconciliation.csv_files_discovered = output.assets.filter((asset) => asset.format === 'csv').length;
}

export function validateStructuredAssetCandidate(output, previous = { assets: [] }) {
  const fetched = new Set(output.pages.filter((page) => page.status === 'fetched').flatMap((page) => [page.url, page.requested_url]));
  if (!output.pages.some((page) => page.status === 'fetched')) throw new Error('NIST structured discovery incomplete: no pages retrieved');
  if (previous.assets?.length && !output.assets?.length) throw new Error('NIST structured discovery incomplete: previously populated inventory became empty');
  // Discovery is a research inventory, not a claim that all publisher pages
  // work. Failed pages remain explicit and cannot erase their accepted assets.
  for (const asset of previous.assets || []) {
    if ((asset.source_pages || []).some((page) => !fetched.has(page)) &&
        !(output.assets || []).some((next) => next.url === asset.url)) {
      throw new Error(`NIST structured discovery incomplete: unavailable page lost accepted asset ${asset.url}`);
    }
  }
}

if (process.argv[1]?.includes('discover-nist-structured-assets.mjs')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
