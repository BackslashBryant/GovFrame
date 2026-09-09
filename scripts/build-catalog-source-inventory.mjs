#!/usr/bin/env node
// Build the source-side catalog inventory before graph construction. This is
// deliberately separate from generated graph counts: a graph cannot certify
// that its own importer was complete.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generatedAt } from './lib/stable-generated-at.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data/generated/catalog-source-inventory.json');

const PROFILES = Object.freeze({
  'cmmc-2': { file: 'data/cmmc-practices.json' },
  'csf-2': { file: 'data/csf-subcategories.json' },
  'cui-policy': { file: 'data/cui-policy.json' },
  'disa-cci': { file: 'data/ccis.json' },
  'disa-srg': { file: 'data/srg-requirements.json' },
  'disa-stig': { file: 'data/stig-rules.json' },
  'dod-rai': { file: 'data/dod-rai.json' },
  'dod-zt': { file: 'data/dod-zt.json' },
  'fedramp-rev5': { file: 'data/fedramp-baselines.json' },
  'fedramp-2026': { file: 'data/fedramp-2026-catalog.json' },
  'fips-199': { file: 'data/fips-199.json' },
  'fips-200': { file: 'data/fips-200.json' },
  'microsoft-zt-maturity': { file: 'data/microsoft-zt-maturity.json' },
  'mitre-attack': { file: 'data/attack-techniques-enterprise.json' },
  'mitre-attack-ics': { file: 'data/attack-techniques-ics.json' },
  'mitre-d3fend': { file: 'data/d3fend-countermeasures.json' },
  'nist-800-171': { file: 'data/requirements-800-171.json' },
  'nist-800-171-rev2': { file: 'data/requirements-800-171-rev2.json' },
  'nist-800-172': { file: 'data/requirements-800-172.json' },
  'nist-800-37': { file: 'data/tasks-800-37.json' },
  'nist-800-53': { file: 'data/controls-800-53.json' },
  'nist-800-53a': {
    file: 'data/controls-800-53.json',
    select: (record) => Boolean(record.metadata?.assessment),
    selection: 'records carrying publisher assessment procedure metadata',
  },
  'nist-800-53b': { file: 'data/800-53b-baselines.json' },
  'nist-ai-rmf': { file: 'data/ai-rmf.json' },
  'nist-iot-cybersecurity': { file: 'data/nist-iot-cybersecurity.json' },
  'nist-mobile-threats': { file: 'data/nist-mobile-threats.json' },
  'nist-ssdf': { file: 'data/ssdf.json' },
  'nist-zt': { file: 'data/nist-zt.json' },
});

function readRecords(profile) {
  const document = JSON.parse(readFileSync(join(ROOT, profile.file), 'utf8'));
  if (!Array.isArray(document.records)) throw new Error(`${profile.file} does not contain a records array`);
  return profile.select ? document.records.filter(profile.select) : document.records;
}

function validateIdentities(catalogId, records) {
  const ids = records.map((record) => String(record.id || '').trim());
  if (ids.some((id) => !id)) throw new Error(`${catalogId} contains a source record without an id`);
  const unique = new Set(ids);
  if (unique.size !== ids.length) throw new Error(`${catalogId} contains ${ids.length - unique.size} duplicate source record id(s)`);
}

const catalogs = {};
for (const [catalogId, profile] of Object.entries(PROFILES)) {
  const records = readRecords(profile);
  validateIdentities(catalogId, records);
  catalogs[catalogId] = {
    source_file: profile.file,
    source_selection: profile.selection || 'all normalized publisher records',
    discovered_records: records.length,
    normalized_records: records.length,
    unique_record_ids: records.length,
    evidence_class: 'pre_graph_adapter_inventory',
  };
}

const inventory = {
  schema_version: '1.0',
  generated_at: generatedAt(),
  count_boundary: 'source adapter output before structural groups, graph nodes, or relationship expansion',
  catalogs,
};

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(inventory, null, 2)}\n`, 'utf8');
console.log(`catalog-source-inventory: ${Object.keys(catalogs).length} catalogs reconciled before graph construction.`);
