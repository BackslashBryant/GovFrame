#!/usr/bin/env node
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { promisify } from 'node:util';

import { parseDisaCompilationStream } from '../tools/importers/disa-stig-adapter.mjs';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { assertOfficialSourceUrl } from './lib/source-url-policy.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DISCOVERY_URL = 'https://public.cyber.mil/stigs/downloads/';
const COMMITTED_ARTIFACTS = {
  stig: join(ROOT, 'data', 'stig-rules.json'),
  srg: join(ROOT, 'data', 'srg-requirements.json'),
  relationships: join(ROOT, 'maps', 'stig-srg-to-cci.json'),
};

const DL_BASE = 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/';

// spec §6: the compilation URL is discovered from the real DL_BASE directory
// index (an Apache-style listing — public.cyber.mil/stigs/downloads/ itself
// is JS-rendered and exposes no static zip links from this environment),
// filtered to "*Library*.zip" entries and sorted by the embedded month name
// + year rather than plain alphabetical sort (which would pick a 2020 file
// over a 2026 one — "2" < "A" in ASCII).
const MONTH_ORDER = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};
function compilationSortKey(filename) {
  const match = filename.match(/Library_(?:(\d{4})_(\d{2})|([A-Za-z]+)_(\d{4}))/);
  if (!match) return [0, 0];
  if (match[1]) return [Number(match[1]), Number(match[2])];
  const month = MONTH_ORDER[match[3].toLowerCase()] || 0;
  return [Number(match[4]), month];
}
export function findLatestDisaLibraryUrl(directoryHtml) {
  const files = [...String(directoryHtml).matchAll(/href=["']([^"']*Library[^"']*\.zip)["']/gi)]
    .map((match) => match[1])
    .filter((file) => !file.includes('/'));
  if (!files.length) return null;
  const [latest] = [...new Set(files)].sort((a, b) => {
    const [ay, am] = compilationSortKey(a);
    const [by, bm] = compilationSortKey(b);
    return by - ay || bm - am;
  });
  return `${DL_BASE}${latest}`;
}

function checksum(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

export function findOfficialDisaCompilationUrl(html) {
  const matches = [...String(html).matchAll(/https:\/\/dl\.dod\.cyber\.mil\/[^\s"']*\/U_[^\s"']*STIG[^\s"']*Library[^\s"']*\.zip/gi)]
    .map((match) => match[0])
    .sort();
  return matches[0] || null;
}

export function extractDisaZipUrlsFromHtml(html) {
  const matches = [...String(html).matchAll(/href=["']([^"']+\.zip)["']/gi)]
    .map((match) => match[1])
    .filter((href) => !href.includes('/') || /^https:\/\/dl\.dod\.cyber\.mil\/wp-content\/uploads\/stigs\/zip\//i.test(href))
    .map((href) => (/^https?:\/\//i.test(href) ? href : `${DL_BASE}${href}`));
  return [...new Set(matches)];
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function loadCommittedArtifacts() {
  const stigData = readJson(COMMITTED_ARTIFACTS.stig);
  const srgData = readJson(COMMITTED_ARTIFACTS.srg);
  const relData = readJson(COMMITTED_ARTIFACTS.relationships);
  return {
    stig: stigData,
    srg: srgData,
    relationships: relData,
    sourceArtifact: DISCOVERY_URL,
    checksum: checksum(
      `${readFileSync(COMMITTED_ARTIFACTS.stig, 'utf8')}\n${readFileSync(COMMITTED_ARTIFACTS.srg, 'utf8')}\n${readFileSync(COMMITTED_ARTIFACTS.relationships, 'utf8')}`,
    ),
    fallbackMode: 'committed-official-snapshot',
  };
}

// spec §6: discover the latest official compilation from the real
// directory index, download the exact archive, and parse it — no more
// static allowlist of individual filenames (the old DISA_ARTIFACT_MANIFEST
// this replaced was already undefined dead code, silently swallowed into a
// fallback on every run).
async function discoverAndFetchCompilation(fetchImpl) {
  const indexResponse = await fetchImpl(DL_BASE);
  if (!indexResponse.ok) {
    throw new Error(`DISA directory index fetch failed: ${indexResponse.status} ${DL_BASE}`);
  }
  const indexHtml = await indexResponse.text();
  const compilationUrl = findLatestDisaLibraryUrl(indexHtml);
  if (!compilationUrl) {
    throw new Error(`No *Library*.zip compilation found in DISA directory index (${DL_BASE})`);
  }
  const result = await fetchAndParseCompilation(compilationUrl, fetchImpl);
  return {
    ...result,
    discoveredUrls: extractDisaZipUrlsFromHtml(indexHtml).length,
  };
}

// The public library archive is hundreds of megabytes. Keep it out of the
// JavaScript heap: stream the response into the repo-ignored tmp directory and
// let the importer process each ZIP entry independently. The archive is
// removed immediately after parsing, including on failure.
async function fetchAndParseCompilation(compilationUrl, fetchImpl) {
  const tmpRoot = join(ROOT, 'tmp');
  mkdirSync(tmpRoot, { recursive: true });
  const workDir = mkdtempSync(join(tmpRoot, 'disa-compilation-'));
  const archivePath = join(workDir, 'library.zip');
  try {
    await downloadCompilation(compilationUrl, archivePath, fetchImpl);
    const parsed = await parseDisaCompilationStream(archivePath, {
      artifactUrl: compilationUrl,
      sourceKeys: { stig: 'disa-stig-library', srg: 'disa-srg-library' },
    });
    return {
      ...parsed,
      sourceArtifact: compilationUrl,
      checksum: parsed.checksum,
      byteLength: statSync(archivePath).size,
      fallbackMode: null,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

const RANGE_BYTES = process.platform === 'win32' ? 2 * 1024 * 1024 : 8 * 1024 * 1024;
const RANGE_RETRIES = 6;
const execFileAsync = promisify(execFile);

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function fetchRange(url, start, end, fetchImpl) {
  let lastError;
  for (let attempt = 1; attempt <= RANGE_RETRIES; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { Range: `bytes=${start}-${end}` } });
      if (response.status !== 206) {
        throw new Error(`expected HTTP 206 for ${start}-${end}, received ${response.status}`);
      }
      const range = response.headers?.get?.('content-range') || '';
      const match = range.match(/^bytes\s+(\d+)-(\d+)\/(\d+)$/i);
      if (!match || Number(match[1]) !== start || Number(match[2]) !== end) {
        throw new Error(`DISA range response did not match requested bytes: ${range || 'missing Content-Range'}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length !== end - start + 1) {
        throw new Error(`DISA range body length ${bytes.length} did not match ${end - start + 1} requested bytes`);
      }
      return { bytes, totalBytes: Number(match[3]) };
    } catch (error) {
      lastError = error;
      if (attempt < RANGE_RETRIES) await wait(attempt * 2_000);
    }
  }
  throw lastError;
}

export async function fetchRangeWithCurl(url, start, end, destination, options = {}) {
  const approvedUrl = assertOfficialSourceUrl(url).href;
  const runCurl = options.execFileImpl || execFileAsync;
  const rangePath = `${destination}.${start}.part`;
  let lastError;
  try {
    for (let attempt = 1; attempt <= RANGE_RETRIES; attempt += 1) {
      try {
        const { stdout } = await runCurl('curl.exe', [
          '--disable', '--fail', '--silent', '--show-error',
          '--proto', '=https', '--proto-redir', '=https', '--max-redirs', '0',
          '--range', `${start}-${end}`,
          '--output', rangePath,
          '--write-out', '%{http_code}\n%{url_effective}',
          approvedUrl,
        ], { timeout: 60_000 });
        const [status, effectiveUrl] = String(stdout).trim().split(/\r?\n/);
        if (status !== '206' || effectiveUrl !== approvedUrl) {
          const error = new Error('DISA curl rejected redirect, non-range response, or changed effective URL');
          error.code = 'DISA_EGRESS_REJECTED';
          throw error;
        }
        const bytes = readFileSync(rangePath);
        if (bytes.length !== end - start + 1) {
          throw new Error(`DISA curl range body length ${bytes.length} did not match ${end - start + 1} requested bytes`);
        }
        return bytes;
      } catch (error) {
        if (error.code === 'DISA_EGRESS_REJECTED') throw error;
        lastError = error;
        if (attempt < RANGE_RETRIES) await wait(attempt * 2_000);
      }
    }
    throw lastError;
  } finally {
    rmSync(rangePath, { force: true });
  }
}

// Some DISA CDN responses terminate before Node can finish a single 352 MB
// body. Range retrieval keeps every request bounded and verifies each response
// before appending it. Servers that do not support ranges retain the ordinary
// streaming path for compatibility with injected test fetchers.
async function downloadCompilation(url, destination, fetchImpl) {
  const probe = await fetchImpl(url, { headers: { Range: 'bytes=0-0' } });
  const contentRange = probe.headers?.get?.('content-range') || '';
  const rangeMatch = contentRange.match(/^bytes\s+0-0\/(\d+)$/i);
  const output = createWriteStream(destination);
  try {
    if (probe.status === 206 && rangeMatch) {
      const totalBytes = Number(rangeMatch[1]);
      for (let start = 0; start < totalBytes; start += RANGE_BYTES) {
        const end = Math.min(totalBytes - 1, start + RANGE_BYTES - 1);
        const range = process.platform === 'win32'
          ? { bytes: await fetchRangeWithCurl(url, start, end, destination), totalBytes }
          : await fetchRange(url, start, end, fetchImpl);
        if (range.totalBytes !== totalBytes) {
          throw new Error(`DISA range total changed during download (${totalBytes} != ${range.totalBytes})`);
        }
        if (!output.write(range.bytes)) await once(output, 'drain');
      }
    } else {
      if (!probe.ok) throw new Error(`DISA compilation fetch failed: ${probe.status} ${url}`);
      await pipeline(Readable.from(probe.body), output);
      return;
    }
    output.end();
    await once(output, 'finish');
  } catch (error) {
    output.destroy();
    throw error;
  }
}

function writeDisaArtifactManifest(result) {
  const inventory = result.inventory || [];
  const count = (status) => inventory.filter((entry) => entry.status === status).length;
  const parsedByKind = (kind) => inventory
    .filter((entry) => entry.status === 'ingested' && entry.catalogKind === kind)
    .reduce((total, entry) => total + entry.recordCount, 0);
  const manifest = {
    discovery_source: DL_BASE,
    artifact_url: result.sourceArtifact,
    byte_length: result.byteLength,
    retrieval_timestamp: new Date().toISOString(),
    checksum: result.checksum,
    reconciliation: {
      discovered_urls: result.discoveredUrls ?? null,
      compilation_entries: inventory.length,
      ingested_files: count('ingested'),
      excluded_files: count('excluded'),
      failed_files: count('failed'),
      ignored_files: count('ignored'),
      stig_records_parsed: parsedByKind('stig'),
      srg_records_parsed: parsedByKind('srg'),
      cci_relationships: result.relationships.relationships.length,
      inventory_details: inventory,
    },
  };
  writeJsonAtomically(join(ROOT, 'data', 'disa-artifact-manifest.json'), manifest);
}

export async function fetchDisaStigs(options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const explicitUrl = options.compilationUrl || process.env.DISA_STIG_COMPILATION_URL || '';

  if (explicitUrl) {
    try {
      return await fetchAndParseCompilation(explicitUrl, fetchImpl);
    } catch (error) {
      if (process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1') throw error;
      return loadCommittedArtifacts();
    }
  }

  try {
    return await discoverAndFetchCompilation(fetchImpl);
  } catch (error) {
    if (process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1') throw error;
    return loadCommittedArtifacts();
  }
}

async function main() {
  const result = await fetchDisaStigs();
  if (result.fallbackMode && process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1') {
    throw new Error(`DISA refresh required a live upstream fetch but used ${result.fallbackMode}`);
  }
  writeJsonAtomically(join(ROOT, 'data', 'stig-rules.json'), result.stig);
  writeJsonAtomically(join(ROOT, 'data', 'srg-requirements.json'), result.srg);
  writeJsonAtomically(join(ROOT, 'maps', 'stig-srg-to-cci.json'), result.relationships);
  if (!result.fallbackMode) writeDisaArtifactManifest(result);
  if (result.fallbackMode) {
    console.log(`DISA fetch fallback: ${result.fallbackMode}`);
  }
  if (result.failed?.length) {
    console.log(`${result.failed.length} archive entr${result.failed.length === 1 ? 'y' : 'ies'} failed to parse: ${result.failed.map((f) => `${f.entryPath} (${f.reason})`).join(', ')}`);
  }
  console.log(`Wrote ${result.stig.records.length} STIG rules, ${result.srg.records.length} SRG requirements, and ${result.relationships.relationships.length} DISA CCI references`);
}

if (process.argv[1]?.includes('fetch-disa-stigs.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
