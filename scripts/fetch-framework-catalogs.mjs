#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { assertPublisherInventory } from './lib/publisher-inventory.mjs';
import {
  buildCmmcPublicCatalog,
  buildCuiPolicyCatalog,
  buildDodRaiPublicCatalog,
  buildDodZeroTrustCatalog,
  buildFedrampPublicCatalog,
  buildFips199Catalog,
  buildFips200Catalog,
  buildNist80053BBaselineCatalog,
  buildNistZeroTrustCatalog,
  buildNistIoTRequirementCatalog,
  buildNistMobileThreatCatalog,
  buildRmfCatalog,
  buildMicrosoftZeroTrustQuestionnaireCatalog,
  parseAiRmfPlaybook,
  parseSsdfCatalog,
} from '../tools/importers/framework-adapters.mjs';
import {
  enrichCatalogMetadata,
  fetch80053BBaselines,
  fetchFedrampBaselineMembership,
} from '../tools/importers/catalog-adapters-ext.mjs';
import {
  parse800171CsvCatalog,
  parse800172Catalog,
  parse80053Catalog,
  parse800171Catalog,
  parseCsfCatalog,
} from '../tools/normalizers/oscal-normalize.mjs';
import {
  enrichCsfCatalogFromReferenceTool,
  parseCsfReferenceToolWorkbook,
} from '../tools/importers/csf-reference-tool-adapter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = new Date().toISOString();
const CSF_REFERENCE_TOOL_EXPORT_URL = 'https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all';

// NIST publishes its OSCAL catalogs from usnistgov/oscal-content. The primary
// URLs below track `main`, which is a moving target: a retag, a path rename or
// a transient outage there stops the refresh dead. Every OSCAL catalog therefore
// carries the same path at the newest published release tag as a backup. It is
// the same first-party NIST repository, so no new publisher is trusted, and the
// tag is immutable so the backup cannot itself move underneath us.
//
// A backup is only reached when the primary is unavailable, and every fallback
// is logged and reported. Note the tagged bytes can lag `main`; the run report
// names which URL actually served so a fallback is never silent.
const OSCAL_BACKUP_TAG = 'v1.5.0';

function oscalBackup(path) {
  return `https://raw.githubusercontent.com/usnistgov/oscal-content/${OSCAL_BACKUP_TAG}/nist.gov/${path}`;
}

const REMOTE_CATALOGS = [
  {
    id: 'nist-800-53-rev5',
    sourceKey: 'nist-oscal',
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json',
    backupUrls: [oscalBackup('SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json')],
    outfile: 'controls-800-53.json',
    parse: parse80053Catalog,
    enrich: async (records) => {
      const [fedramp, baselines] = await Promise.all([
        fetchFedrampBaselineMembership(),
        fetch80053BBaselines(),
      ]);
      const enrichment = {};
      for (const record of records) {
        const fedrampBaselines = Object.entries(fedramp)
          .filter(([, controls]) => controls.includes(record.id))
          .map(([baseline]) => baseline);
        const nistBaselines = Object.entries(baselines)
          .filter(([, controls]) => controls.includes(record.id))
          .map(([baseline]) => baseline);
        if (fedrampBaselines.length || nistBaselines.length) {
          enrichment[record.id] = {
            fedramp_baselines: fedrampBaselines,
            nist_800_53b_baselines: nistBaselines,
          };
        }
      }
      return enrichCatalogMetadata(records, enrichment);
    },
  },
  {
    id: 'nist-csf-2',
    sourceKey: 'nist-oscal',
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json',
    backupUrls: [oscalBackup('CSF/v2.0/json/NIST_CSF_v2.0_catalog.json')],
    outfile: 'csf-subcategories.json',
    parse: parseCsfCatalog,
    enrich: async (records, context) => {
      const response = await context.fetchImpl(CSF_REFERENCE_TOOL_EXPORT_URL);
      if (!response.ok) {
        throw new Error(`CSF Reference Tool export fetch failed: ${response.status} ${CSF_REFERENCE_TOOL_EXPORT_URL}`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const referenceTool = await parseCsfReferenceToolWorkbook(bytes);
      const enriched = enrichCsfCatalogFromReferenceTool(records, referenceTool);
      context.pendingWrites.push([join(ROOT, 'data', 'csf-reference-tool-manifest.json'), {
        source: CSF_REFERENCE_TOOL_EXPORT_URL,
        sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        byte_length: bytes.length,
        retrieved_at: SNAPSHOT,
        reconciliation: {
          ...enriched.reconciliation,
        },
      }]);
      context.publisherInventory = {
        ...enriched.publisher_inventory,
        source_url: CSF_REFERENCE_TOOL_EXPORT_URL,
        source_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        source_byte_length: bytes.length,
        publisher_version: '2.0',
      };
      return enriched.records;
    },
  },
  {
    id: 'nist-800-171-rev3',
    sourceKey: 'nist-oscal',
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json',
    backupUrls: [oscalBackup('SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json')],
    outfile: 'requirements-800-171.json',
    parse: parse800171Catalog,
  },
  {
    id: 'nist-800-171-rev2',
    url: 'https://csrc.nist.gov/files/pubs/sp/800/171/r2/upd1/final/docs/sp800-171r2-security-reqs.csv',
    outfile: 'requirements-800-171-rev2.json',
    parse: (csv) => parse800171CsvCatalog(csv, 'nist-800-171-rev2'),
    responseType: 'text',
  },
  {
    id: 'nist-800-172-rev3',
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-172/rev3/json/NIST_SP800-172_rev3_catalog.json',
    backupUrls: [oscalBackup('SP800-172/rev3/json/NIST_SP800-172_rev3_catalog.json')],
    outfile: 'requirements-800-172.json',
    parse: parse800172Catalog,
  },
  {
    id: 'nist-ai-rmf-playbook',
    url: 'https://airc.nist.gov/docs/playbook.json',
    outfile: 'ai-rmf.json',
    parse: (json) => parseAiRmfPlaybook(json, SNAPSHOT),
  },
  {
    id: 'nist-ssdf-oscal',
    url: 'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-218/ver1/json/NIST_SP800-218_ver1_catalog.json',
    backupUrls: [oscalBackup('SP800-218/ver1/json/NIST_SP800-218_ver1_catalog.json')],
    outfile: 'ssdf.json',
    parse: (json) => parseSsdfCatalog(json, SNAPSHOT),
  },
];

const PUBLIC_CATALOGS = [
  ['cmmc-practices.json', buildCmmcPublicCatalog],
  ['fips-199.json', buildFips199Catalog],
  ['fips-200.json', buildFips200Catalog],
  ['fedramp-baselines.json', buildFedrampPublicCatalog],
  ['800-53b-baselines.json', buildNist80053BBaselineCatalog],
  ['tasks-800-37.json', buildRmfCatalog],
  ['cui-policy.json', buildCuiPolicyCatalog],
  ['dod-rai.json', buildDodRaiPublicCatalog],
  ['dod-zt.json', (snapshotDate) => buildDodZeroTrustCatalog(snapshotDate, join(ROOT, 'data', 'curated', 'dod-zt'))],
  ['nist-zt.json', (snapshotDate) => buildNistZeroTrustCatalog(snapshotDate, join(ROOT, 'data', 'curated', 'nist-zt'))],
  ['microsoft-zt-maturity.json', (snapshotDate) => buildMicrosoftZeroTrustQuestionnaireCatalog(snapshotDate, join(ROOT, 'data', 'curated', 'nist-zt'))],
  ['nist-iot-cybersecurity.json', (snapshotDate) => buildNistIoTRequirementCatalog(snapshotDate, join(ROOT, 'data', 'curated', 'nist-structured-catalogs'))],
  ['nist-mobile-threats.json', (snapshotDate) => buildNistMobileThreatCatalog(snapshotDate, join(ROOT, 'data', 'curated', 'nist-structured-catalogs'))],
];

function writeCatalog(filename, document, writeJson = writeJsonAtomically) {
  writeJson(join(ROOT, 'data', filename), document);
  return { filename, records: document.records.length };
}

// Try the primary source, then each declared backup in order. A backup is only
// reached when the one before it is unreachable or returns a non-OK status, so
// a healthy primary always wins and the backup path costs nothing. Returns the
// URL that actually served so the caller can report it: a fallback that nobody
// can see is indistinguishable from a source that quietly changed underneath us.
export async function fetchCatalogWithFallback(target, fetchImpl = strictConditionalFetch) {
  const candidates = [target.url, ...(target.backupUrls || [])];
  const failures = [];
  for (const url of candidates) {
    try {
      const response = await fetchImpl(url);
      if (!response.ok) {
        failures.push(`${url} -> HTTP ${response.status}`);
        continue;
      }
      return { response, url, usedBackup: url !== target.url, failures };
    } catch (error) {
      failures.push(`${url} -> ${error.message}`);
    }
  }
  throw new Error(
    `${target.id} fetch failed on all ${candidates.length} candidate source(s): ${failures.join('; ')}`,
  );
}

export async function fetchFrameworkCatalogs(options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const writeJson = options.writeJson || writeJsonAtomically;
  const only = options.only ? new Set(options.only) : null;
  const onlyPublic = options.onlyPublic ? new Set(options.onlyPublic) : null;
  if (only && onlyPublic) throw new Error('Choose either --only or --public catalog selection');
  for (const [selected, known, label] of [
    [only, new Set(REMOTE_CATALOGS.map((target) => target.id)), '--only'],
    [onlyPublic, new Set(PUBLIC_CATALOGS.map(([filename]) => filename.replace(/\.json$/, ''))), '--public'],
  ]) {
    if (!selected) continue;
    if (!selected.size) throw new Error(`${label} requires at least one catalog ID`);
    const unknown = [...selected].filter((id) => !known.has(id));
    if (unknown.length) throw new Error(`Unknown ${label} catalog IDs: ${unknown.join(', ')}`);
  }
  const remoteTargets = onlyPublic ? [] : only ? REMOTE_CATALOGS.filter((target) => only.has(target.id)) : REMOTE_CATALOGS;
  const publicTargets = onlyPublic
    ? PUBLIC_CATALOGS.filter(([filename]) => onlyPublic.has(filename.replace(/\.json$/, '')))
    : only ? [] : PUBLIC_CATALOGS;
  const results = [];
  let fedrampMembership = null;
  if (publicTargets.some(([, build]) => build === buildFedrampPublicCatalog)) {
    fedrampMembership = await (options.fetchFedrampMembership || fetchFedrampBaselineMembership)();
  }

  const fallbacks = [];
  for (const target of remoteTargets) {
    const { response, url: servedUrl, usedBackup, failures } = await fetchCatalogWithFallback(target, fetchImpl);
    if (usedBackup) {
      fallbacks.push({ id: target.id, primary: target.url, served: servedUrl, failures });
      console.warn(
        `${target.id}: primary source unavailable, served from backup ${servedUrl} (${failures.join('; ')})`,
      );
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const payload = target.responseType === 'text' ? bytes.toString('utf8') : JSON.parse(bytes.toString('utf8'));
    let document = target.parse(payload, target.sourceKey || target.id);
    const context = { fetchImpl, pendingWrites: [] };
    if (target.enrich) {
      document = { ...document, records: await target.enrich(document.records, context) };
    }
    if (target.id === 'nist-csf-2') {
      document = {
        ...document,
        reconciliation: { subcategories: document.records.length },
      };
    }
    const inventoryFormat = {
      'nist-800-53-rev5': 'oscal-800-53',
      'nist-800-171-rev3': 'oscal-800-171',
      'nist-800-172-rev3': 'oscal-800-172',
      'nist-ssdf-oscal': 'oscal-ssdf',
      'nist-ai-rmf-playbook': 'ai-rmf',
      'nist-800-171-rev2': 'csv-800-171-rev2',
    }[target.id];
    const publisherInventory = inventoryFormat
      ? assertPublisherInventory(inventoryFormat, payload, document.records)
      : context.publisherInventory;
    if (publisherInventory) document = {
      ...document,
      publisher_inventory: {
        ...publisherInventory,
        ...(inventoryFormat ? {
          source_url: servedUrl,
          source_sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
          source_byte_length: bytes.length,
          publisher_version: payload?.catalog?.metadata?.version || null,
          ...(!payload?.catalog?.metadata?.version ? { publisher_version_reason: 'Publisher payload does not declare a version field' } : {}),
        } : {}),
      },
    };
    for (const [path, manifest] of context.pendingWrites) writeJson(path, manifest);
    results.push(writeCatalog(target.outfile, document, writeJson));
  }
  for (const [filename, build] of publicTargets) {
    const doc = build === buildFedrampPublicCatalog
      ? build(SNAPSHOT, fedrampMembership)
      : build === buildCuiPolicyCatalog
        ? build(SNAPSHOT, join(ROOT, 'data', 'nara-cui-registry-manifest.json'))
        : build(SNAPSHOT);
    results.push(writeCatalog(filename, doc, writeJson));
  }
  if (fallbacks.length) {
    console.warn(
      `${fallbacks.length} catalog source(s) served from a backup: ${fallbacks.map((entry) => entry.id).join(', ')}. `
        + 'The primary URLs above need review -- a backup is a bridge, not a destination.',
    );
  }
  return results;
}

export function frameworkCatalogOptions(args) {
  if (!args.length) return {};
  if (!['--only', '--public'].includes(args[0]) || args.slice(1).some((arg) => arg.startsWith('--'))) {
    throw new Error('Use --only <catalog IDs> or --public <catalog IDs>');
  }
  if (args.length < 2) throw new Error(`${args[0]} requires at least one catalog ID`);
  return args[0] === '--only' ? { only: args.slice(1) } : { onlyPublic: args.slice(1) };
}

if (process.argv[1]?.includes('fetch-framework-catalogs.mjs')) {
  Promise.resolve().then(() => fetchFrameworkCatalogs(frameworkCatalogOptions(process.argv.slice(2))))
    .then((results) => results.forEach((result) => console.log(`Wrote ${result.filename}: ${result.records} records`)))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
