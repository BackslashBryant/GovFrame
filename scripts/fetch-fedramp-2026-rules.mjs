#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { createHash } from 'node:crypto';
import { normalizeFedramp2026 } from './build-fedramp-2026-catalog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RULES_URL = 'https://raw.githubusercontent.com/FedRAMP/rules/main/fedramp-consolidated-rules.json';
const SCHEMA_URL = 'https://raw.githubusercontent.com/FedRAMP/rules/main/schemas/fedramp-consolidated-rules.schema.json';
const LEGACY_URL = 'https://www.fedramp.gov/legacy/';
const MAPPINGS_PATH = join(ROOT, 'data', 'curated', 'fedramp-transition-mappings.json');
const RULES_PATH = join(ROOT, 'data', 'fedramp-2026-rules.json');
const SCHEMA_PATH = join(ROOT, 'data', 'fedramp-2026-rules.schema.json');
const INDEX_PATH = join(ROOT, 'data', 'fedramp-transition-index.json');

async function fetchRequired(url, responseType = 'json', fetchImpl = strictConditionalFetch) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Control-Atlas-FedRAMP-refresh' },
  });
  if (!response.ok) throw new Error(`FedRAMP fetch failed: ${response.status} ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  return { payload: responseType === 'text' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8')), bytes };
}

function walkRules(dataset) {
  const rules = new Map();
  for (const [processId, process] of Object.entries(dataset.FRR || {})) {
    for (const [applicability, subsets] of Object.entries(process.data || {})) {
      for (const [subsetId, entries] of Object.entries(subsets || {})) {
        for (const [ruleId, rule] of Object.entries(entries || {})) {
          if (rules.has(ruleId)) throw new Error(`Duplicate FedRAMP rule ID: ${ruleId}`);
          const commonEffective = process.info?.effective || null;
          rules.set(ruleId, {
            rule_id: ruleId,
            process_id: processId,
            process_name: process.info?.name || processId,
            process_status: process.info?.status || 'unknown',
            applicability,
            subset_id: subsetId,
            name: rule.name || ruleId,
            force: rule.force || null,
            statement: rule.statement || null,
            varies_by_class: rule.varies_by_class || null,
            following_information: rule.following_information || [],
            notes: rule.notes || (rule.note ? [rule.note] : []),
            schema: rule.schema || null,
            effective: {
              common: commonEffective,
              '20x': process.info?.['20x']?.effective || commonEffective,
              rev5: process.info?.rev5?.effective || commonEffective,
            },
            updated: rule.updated || [],
          });
        }
      }
    }
  }
  return rules;
}

function parseLegacyAssets(html) {
  const matches = [...html.matchAll(/href=["']([^"']+)["']/gi)];
  const assets = new Map();
  for (const match of matches) {
    const href = match[1];
    if (!/^assets\/.*\.(docx|xlsx|pdf|zip)$/i.test(href)) continue;
    const url = new URL(href, LEGACY_URL).toString();
    const rawName = decodeURIComponent(href.split('/').pop() || href);
    const format = rawName.split('.').pop()?.toLowerCase() || 'file';
    const title = rawName
      .replace(/\.(docx|xlsx|pdf|zip)$/i, '')
      .replace(/^LEGACY[_ ]*/i, '')
      .replaceAll('_', ' ')
      .replaceAll(/\s+/g, ' ')
      .trim();
    assets.set(url, { title, format, url });
  }
  return [...assets.values()].sort((a, b) => a.title.localeCompare(b.title));
}

function resolveMappings(config, rules) {
  const referencedIds = new Set();
  for (const ids of Object.values(config.current_artifact_rules || {})) {
    for (const id of ids) referencedIds.add(id);
  }
  for (const mapping of config.legacy_mappings || []) {
    for (const id of mapping.rule_ids || []) referencedIds.add(id);
  }
  const resolved = [];
  for (const id of [...referencedIds].sort()) {
    const rule = rules.get(id);
    if (!rule) throw new Error(`Curated FedRAMP mapping references missing rule ${id}`);
    resolved.push(rule);
  }
  return resolved;
}

function validateRules(dataset, schema) {
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  if (!validate(dataset)) {
    const details = (validate.errors || [])
      .slice(0, 12)
      .map((error) => `${error.instancePath || '/'} ${error.message}`)
      .join('; ');
    throw new Error(`FedRAMP rules failed the official schema: ${details}`);
  }
}

export async function fetchFedramp2026Rules(runDate = new Date().toISOString().slice(0, 10), options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const writeFile = options.writeFile || writeFileSync;
  const [rulesResponse, schemaResponse, legacyResponse] = await Promise.all([
    fetchRequired(RULES_URL, 'json', fetchImpl),
    fetchRequired(SCHEMA_URL, 'json', fetchImpl),
    fetchRequired(LEGACY_URL, 'text', fetchImpl),
  ]);
  const dataset = rulesResponse.payload;
  const schema = schemaResponse.payload;
  const legacyHtml = legacyResponse.payload;
  validateRules(dataset, schema);
  // Reconcile the same final projection before publishing any refreshed artifact.
  const normalized = normalizeFedramp2026(dataset, {
    source_url: RULES_URL,
    source_sha256: `sha256:${createHash('sha256').update(rulesResponse.bytes).digest('hex')}`,
    source_byte_length: rulesResponse.bytes.length,
    input_sha256: `sha256:${createHash('sha256').update(rulesResponse.bytes).digest('hex')}`,
    input_byte_length: rulesResponse.bytes.length,
  });
  const config = JSON.parse(readFileSync(MAPPINGS_PATH, 'utf8'));
  const rules = walkRules(dataset);
  const resolvedRules = resolveMappings(config, rules);
  const legacyAssets = parseLegacyAssets(legacyHtml);
  if (legacyAssets.length < 26) {
    throw new Error(`Expected at least 26 official FedRAMP legacy downloads; found ${legacyAssets.length}`);
  }
  const processes = Object.entries(dataset.FRR || {})
    .map(([processId, process]) => ({
      process_id: processId,
      name: process.info?.name || processId,
      status: process.info?.status || 'unknown',
    }))
    .sort((a, b) => a.process_id.localeCompare(b.process_id));
  const index = {
    schema_version: '1.0',
    retrieved_on: runDate,
    source: {
      title: dataset.info?.title,
      version: dataset.info?.version,
      last_updated: dataset.info?.last_updated,
      rules_url: RULES_URL,
      schema_url: SCHEMA_URL,
      repository_url: 'https://github.com/FedRAMP/rules',
    },
    interpretation_notice: config.interpretation_notice,
    official_links: config.official_links,
    milestones: config.milestones,
    process_statuses: processes,
    current_artifact_rules: config.current_artifact_rules,
    legacy_mappings: config.legacy_mappings,
    resolved_rules: resolvedRules,
    legacy_assets: legacyAssets,
  };
  // Preserve downloaded bytes so the standalone catalog builder can verify
  // retained source evidence against exactly the same input.
  writeFile(RULES_PATH, rulesResponse.bytes);
  writeFile(SCHEMA_PATH, schemaResponse.bytes);
  writeFile(INDEX_PATH, `${JSON.stringify(index)}\n`, 'utf8');
  writeFile(join(ROOT, 'data', 'fedramp-2026-catalog.json'), `${JSON.stringify(normalized, null, 2)}\n`, 'utf8');
  return {
    version: index.source.version,
    lastUpdated: index.source.last_updated,
    ruleCount: rules.size,
    mappedRuleCount: resolvedRules.length,
    legacyAssetCount: legacyAssets.length,
  };
}

if (process.argv[1]?.includes('fetch-fedramp-2026-rules.mjs')) {
  fetchFedramp2026Rules()
    .then((result) => {
      console.log(
        `FedRAMP ${result.version}: ${result.ruleCount} rules, ${result.mappedRuleCount} mapped rules, ${result.legacyAssetCount} legacy downloads`,
      );
    })
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
