#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_PATH = join(ROOT, 'data', 'source-registry.json');
const VOLATILE_KEYS = new Set(['generated_at', 'observed_at', 'retrieved_at', 'snapshot_date']);

const ARTIFACTS = new Map([
  ['nist-oscal', ['data/controls-800-53.json', 'data/requirements-800-171.json', 'data/csf-subcategories.json']],
  ['nist-800-171-rev2', 'data/requirements-800-171-rev2.json'],
  ['nist-800-172-rev3', 'data/requirements-800-172.json'],
  ['disa-cci-list', 'data/ccis.json'],
  ['disa-stig-library', 'data/stig-rules.json'],
  ['disa-srg-library', 'data/srg-requirements.json'],
  ['disa-stig-srg-cci-references', 'maps/stig-srg-to-cci.json'],
  ['nist-ai-rmf-playbook', 'data/ai-rmf.json'],
  ['nist-ssdf-oscal', 'data/ssdf.json'],
  ['fedramp-rev5', 'data/fedramp-baselines.json'],
  ['fedramp-2026-rules', ['data/fedramp-2026-rules.json', 'data/fedramp-2026-rules.schema.json', 'data/fedramp-transition-index.json']],
  ['nist-800-53b-baselines', 'data/800-53b-baselines.json'],
  ['nist-800-53a-assessment-procedures', 'data/controls-800-53.json'],
  ['nist-800-171-oscal-mappings', 'maps/800-53-to-800-171.json'],
  ['disa-cci-nist-references', 'maps/cci-to-800-53.json'],
  ['mitre-attack-enterprise', 'data/attack-techniques-enterprise.json'],
  ['mitre-attack-ics', 'data/attack-techniques-ics.json'],
  ['mitre-d3fend-ontology', 'data/d3fend-countermeasures.json'],
  ['mitre-d3fend-mappings', ['maps/attack-to-d3fend.json', 'maps/d3fend-to-800-53.json']],
  ['nist-olir-csf2-to-sp800-53', 'maps/800-53-to-csf.json'],
]);

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => !VOLATILE_KEYS.has(key))
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function artifactHash(document) {
  const stable = JSON.stringify(canonicalize(document));
  return `sha256:${createHash('sha256').update(stable).digest('hex')}`;
}

function artifactVersion(document) {
  if (Array.isArray(document)) {
    return document.map(artifactVersion).find(Boolean) || null;
  }
  return document.source_version || document.version || document.info?.version || document.source?.version || document.records?.[0]?.source?.version || null;
}

export function reconcileFreshness(registry, artifactDocuments, runDate, observedSourceIds = []) {
  const sourceRecordsById = new Map();
  for (const collection of [registry.publications || [], registry.sources || []]) {
    for (const source of collection) {
      const records = sourceRecordsById.get(source.id) || [];
      records.push(source);
      sourceRecordsById.set(source.id, records);
    }
  }
  const observations = new Set(observedSourceIds);
  const quarantinedIds = new Set((registry.quarantine || [])
    .filter((entry) => entry.disposition === 'retained_last_good').map((entry) => entry.id));
  const quarantinedSources = new Set((registry.artifacts || [])
    .filter((artifact) => quarantinedIds.has(artifact.id)).map((artifact) => artifact.publication_source_id));
  for (const freshness of registry.freshness.sources) {
    const quarantined = quarantinedIds.has(freshness.source_id) || quarantinedSources.has(freshness.source_id);
    if (freshness.sync_model === 'link_out' && observations.has(freshness.source_id)) {
      if (!quarantined) freshness.last_checked = runDate;
      continue;
    }
    if (freshness.sync_model !== 'auto_synced') continue;
    const document = artifactDocuments.get(freshness.source_id);
    if (!document) throw new Error(`Missing refreshed artifact for ${freshness.source_id}`);
    const nextHash = artifactHash(document);
    if (!quarantined) freshness.last_checked = runDate;
    const contentChanged = freshness.hash !== nextHash;
    if (contentChanged) freshness.last_imported = runDate;
    freshness.hash = nextHash;
    const nextVersion = artifactVersion(document);
    if (nextVersion) {
      for (const source of sourceRecordsById.get(freshness.source_id) || []) {
        source.version = String(nextVersion);
        if (contentChanged) source.retrieved_at = runDate;
      }
      for (const artifact of registry.artifacts || []) {
        if (artifact.publication_source_id === freshness.source_id) {
          artifact.version = String(nextVersion);
          if (contentChanged) artifact.retrieved_at = runDate;
        }
      }
    }
  }
  return registry;
}

export function reconcileSourceFreshness(runDate = new Date().toISOString().slice(0, 10)) {
  const registry = JSON.parse(readFileSync(REGISTRY_PATH, 'utf8'));
  const documents = new Map(
    [...ARTIFACTS].map(([sourceId, relativePaths]) => [
      sourceId,
      (Array.isArray(relativePaths) ? relativePaths : [relativePaths]).map((relativePath) =>
        JSON.parse(readFileSync(join(ROOT, relativePath), 'utf8')),
      ),
    ]),
  );
  const observations = JSON.parse(
    readFileSync(join(ROOT, 'data', 'stig-source-observations.json'), 'utf8'),
  ).observations.map((entry) => entry.source_id);
  const updated = reconcileFreshness(registry, documents, runDate, observations);
  writeFileSync(REGISTRY_PATH, `${JSON.stringify(updated, null, 2)}\n`, 'utf8');
  return updated.freshness.sources;
}

if (process.argv[1]?.includes('reconcile-source-freshness.mjs')) {
  try {
    const entries = reconcileSourceFreshness();
    console.log(`Reconciled freshness metadata for ${entries.length} sources`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
