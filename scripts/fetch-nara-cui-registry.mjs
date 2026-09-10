#!/usr/bin/env node
// spec §7 — NARA CUI Registry deterministic ingestion. archives.gov/cui is a
// server-rendered Drupal site (not a JS shell, contrary to the earlier
// quarantine assumption): the category-list page has a real HTML table of
// Organizational Index Groupings each linking to a category-detail page, and
// every detail page carries two real, well-formed HTML tables — a
// description/marking key-value table and a Safeguarding-Authority /
// Basic-or-Specified / Banner-Marking / Sanctions table. This script parses
// both with a real HTML parser (node-html-parser) — no hand-authored
// category list, no regex-over-flattened-text guessing.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseHtml } from 'node-html-parser';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LIST_URL = 'https://www.archives.gov/cui/registry/category-list';
const CHANGE_LOG_URL = 'https://www.archives.gov/cui/registry/registry-change-log';
const DETAIL_BASE = 'https://www.archives.gov/cui/registry/category-detail/';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fetchText(url) {
  const response = await strictConditionalFetch(url);
  if (!response.ok) throw new Error(`fetch failed (${response.status}): ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  return { text: buffer.toString('utf8'), buffer };
}

function cellText(cell) {
  return cell.text.replace(/\s+/g, ' ').trim();
}

function parseCategoryList(html) {
  const root = parseHtml(html);
  const categories = [];
  for (const table of root.querySelectorAll('table')) {
    const rows = table.querySelectorAll('tr');
    if (rows.length === 0) continue;
    const headerCells = rows[0].querySelectorAll('th').map(cellText);
    if (!headerCells.some((h) => h.includes('Organizational Index Grouping'))) continue;
    for (const row of rows.slice(1)) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) continue;
      const grouping = cellText(cells[0]);
      for (const link of cells[1].querySelectorAll('a')) {
        const href = link.getAttribute('href') || '';
        if (!href.includes('/cui/registry/category-detail/')) continue;
        // NARA's own markup has at least one doubled-path link
        // (.../category-detail/cui/registry/category-detail/privileged-safety-info)
        // — repeatedly strip the leading prefix (with or without its slash,
        // since the second occurrence in a doubled href has none) so the
        // real trailing slug survives.
        let slug = href.replace(/^\/+/, '');
        const prefixNoSlash = 'cui/registry/category-detail/';
        while (slug.startsWith(prefixNoSlash)) slug = slug.slice(prefixNoSlash.length);
        slug = slug.replace(/[/?#].*$/, '').replace(/\.html?$/i, '');
        if (!/^[a-z0-9-]+$/.test(slug)) continue;
        categories.push({ slug, title: cellText(link), grouping });
      }
    }
  }
  return categories;
}

function parseCategoryDetail(html, slug) {
  const root = parseHtml(html);
  const h1 = root.querySelectorAll('h1').map((e) => e.text.trim())[0] || null;
  // NARA's markup is inconsistent about which heading level carries the
  // top-line banner marking (h2 on some pages, h3 on others) — match any.
  const headings = root.querySelectorAll('h1,h2,h3,h4').map((e) => e.text.replace(/\s+/g, ' ').trim());
  const bannerHeading = headings.find((t) => t.startsWith('Banner Marking'));
  const banner_marking = bannerHeading ? bannerHeading.replace(/^Banner Marking:\s*/, '').trim() : null;

  const fields = {};
  const tables = root.querySelectorAll('table');
  const infoTable = tables.find((table) =>
    table.querySelectorAll('tr').some((row) => row.querySelectorAll('td strong').length > 0),
  );
  if (infoTable) {
    for (const row of infoTable.querySelectorAll('tr')) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 2) continue;
      const label = cellText(cells[0]).replace(/:$/, '');
      if (!label) continue;
      fields[label] = cellText(cells[1]);
    }
  }

  const authorityTable = tables.find((table) => {
    const headerCells = (table.querySelectorAll('tr')[0]?.querySelectorAll('th') || []).map(cellText);
    return headerCells.some((h) => h.includes('Safeguarding'));
  });
  const authorities = [];
  if (authorityTable) {
    const rows = authorityTable.querySelectorAll('tr').slice(1);
    for (const row of rows) {
      const cells = row.querySelectorAll('td');
      if (cells.length < 3) continue;
      const authorityCell = cells[0];
      const link = authorityCell.querySelector('a');
      authorities.push({
        authority_citation: cellText(authorityCell),
        authority_url: link ? link.getAttribute('href') : null,
        basic_or_specified: cellText(cells[1]),
        banner_marking: cellText(cells[2]) || null,
        sanctions: cells[3] ? cellText(cells[3]) || null : null,
      });
    }
  }

  const modifiedMatch = html.match(/<meta property="article:modified_time" content="([^"]*)"/);
  const anyBasic = authorities.some((row) => row.basic_or_specified === 'Basic');
  const anySpecified = authorities.some((row) => row.basic_or_specified === 'Specified');

  return {
    slug,
    title: h1 ? h1.replace(/^CUI Category:\s*/, '').trim() : null,
    banner_marking,
    description: fields['Category Description'] || null,
    category_marking: fields['Category Marking'] || null,
    alternative_banner_markings: Object.fromEntries(
      Object.entries(fields).filter(([label]) => label.startsWith('Alternative Banner Marking')),
    ),
    authorities,
    designation: anyBasic && anySpecified ? 'MIXED' : anySpecified ? 'CUI-SPECIFIED' : anyBasic ? 'CUI-BASIC' : 'UNKNOWN',
    last_modified: modifiedMatch ? modifiedMatch[1] : null,
  };
}

export function validateNaraCandidate(manifest, previous = { results: [] }) {
  const failures = Array.from(manifest.results).filter((entry) => entry?.status !== 'OK');
  const knownMissing = new Set(previous.results.filter((entry) => entry.status === 'FAILED').map((entry) => entry.slug));
  const lost = previous.results.filter((entry) => entry.status === 'OK')
    .filter((entry) => !manifest.results.some((next) => next?.slug === entry.slug && next.status === 'OK'));
  if (failures.some((entry) => !entry || !knownMissing.has(entry.slug)) || lost.length || manifest.results.length !== manifest.total_entries || !manifest.change_log || manifest.change_log.status === 'FAILED') {
    throw new Error(`NARA CUI refresh incomplete: ${failures.length} detail failure(s); ${lost.length} previously accepted details lost; change log ${manifest.change_log?.status === 'FAILED' ? 'failed' : 'retrieved'}; ${failures.map((entry) => entry?.error || entry?.slug || 'missing detail').join('; ')}`);
  }
}

export async function fetchNaraCuiRegistry({ concurrency = 8 } = {}) {
  const { text: listHtml, buffer: listBuffer } = await fetchText(LIST_URL);
  const categories = parseCategoryList(listHtml);
  if (categories.length === 0) throw new Error('NARA CUI category-list parse found 0 categories — page structure may have changed');

  const results = new Array(categories.length);
  let cursor = 0;
  async function worker() {
    while (cursor < categories.length) {
      const index = cursor;
      cursor += 1;
      const entry = categories[index];
      try {
        const { text, buffer } = await fetchText(`${DETAIL_BASE}${entry.slug}`);
        const detail = parseCategoryDetail(text, entry.slug);
        results[index] = {
          ...entry,
          ...detail,
          title: detail.title || entry.title,
          detail_url: `${DETAIL_BASE}${entry.slug}`,
          byte_length: buffer.length,
          sha256: sha256(buffer),
          status: 'OK',
        };
      } catch (error) {
        results[index] = { ...entry, status: 'FAILED', error: error.message };
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));

  let changeLog;
  try {
    const { buffer } = await fetchText(CHANGE_LOG_URL);
    changeLog = {
      url: CHANGE_LOG_URL,
      byte_length: buffer.length,
      sha256: sha256(buffer),
      // The change log itself is a long-form HTML narrative (dated entries),
      // not a structured table — recorded as an attested supplemental
      // artifact rather than parsed row-by-row.
      note: 'attested (byte-verified); narrative HTML, not parsed into structured rows',
    };
  } catch (error) {
    changeLog = { url: CHANGE_LOG_URL, status: 'FAILED', error: error.message };
  }

  const okCount = results.filter((r) => r.status === 'OK').length;
  const manifest = {
    generated_at: new Date().toISOString(),
    source: LIST_URL,
    list_page: {
      url: LIST_URL,
      byte_length: listBuffer.length,
      sha256: sha256(listBuffer),
    },
    change_log: changeLog,
    total_entries: categories.length,
    ok_count: okCount,
    failed_count: results.length - okCount,
    results,
  };

  const previous = JSON.parse(readFileSync(join(ROOT, 'data', 'nara-cui-registry-manifest.json'), 'utf8'));
  validateNaraCandidate(manifest, previous);
  const registryPath = join(ROOT, 'data', 'source-registry.json');
  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  const artifact = registry.artifacts?.find(
    (entry) => entry.id === 'artifact-nara-cui-registry',
  );
  if (!artifact) throw new Error('Missing artifact-nara-cui-registry in source registry.');
  artifact.byte_length = listBuffer.length;
  artifact.sha256 = `sha256:${manifest.list_page.sha256}`;
  artifact.version = new Date().toISOString().slice(0, 10);
  artifact.retrieved_at = artifact.version;
  writeJsonAtomically(join(ROOT, 'data', 'nara-cui-registry-manifest.json'), manifest);
  writeJsonAtomically(registryPath, registry);

  return manifest;
}

if (process.argv[1]?.includes('fetch-nara-cui-registry.mjs')) {
  fetchNaraCuiRegistry()
    .then((manifest) =>
      console.log(`Wrote ${manifest.total_entries} NARA CUI categories (${manifest.ok_count} OK, ${manifest.failed_count} failed) to data/nara-cui-registry-manifest.json`),
    )
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
