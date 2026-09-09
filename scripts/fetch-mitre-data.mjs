#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';

import {
  parseEnterpriseAttackStix,
  parseIcsAttackStix,
} from '../tools/importers/mitre-attack-adapter.mjs';
import {
  buildAttackCatalogLookup,
  buildAttackToD3fendRelationships,
  buildD3fendCatalogDocument,
  buildD3fendToNistRelationships,
  buildMappingDocument,
  buildSlugToD3fendIdMap,
  parseD3fendTechniques,
  resolveD3fendDefinitions,
  resolveD3fendTactics,
} from '../tools/importers/mitre-d3fend-adapter.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMMITTED = {
  enterprise: join(ROOT, 'data', 'attack-techniques-enterprise.json'),
  ics: join(ROOT, 'data', 'attack-techniques-ics.json'),
  d3fend: join(ROOT, 'data', 'd3fend-countermeasures.json'),
  attackMap: join(ROOT, 'maps', 'attack-to-d3fend.json'),
  nistMap: join(ROOT, 'maps', 'd3fend-to-800-53.json'),
};
const HYDRATION_MANIFEST = join(ROOT, 'data', 'artifact-hydration-manifest.json');

const ATTACK_RELEASE = '19.2';
const ATTACK_RELEASE_COMMIT = '6cda5ad8462c79e14fbb872f4e09059b18e0cfc4';
// The reviewed D3FEND release, used as the label only when the publisher's
// version endpoint is unreachable. verify-source-truth.mjs pins the same value
// against the registry, so when a refresh records a genuinely newer upstream
// version the pin fails loudly and a person reviews the bump. Upstream was
// already 1.6.0 on 2026-09-09; that bump is deliberately not taken here,
// because the registry checksum and record count for 1.6.0 must come from a
// real fetch rather than be typed in by hand.
const D3FEND_RELEASE = '1.5.0';

const REMOTE = {
  enterpriseAttack:
    `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${ATTACK_RELEASE_COMMIT}/enterprise-attack/enterprise-attack-${ATTACK_RELEASE}.json`,
  icsAttack:
    `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${ATTACK_RELEASE_COMMIT}/ics-attack/ics-attack-${ATTACK_RELEASE}.json`,
  d3fendOntology: 'https://d3fend.mitre.org/ontologies/d3fend.json',
  d3fendMappings: 'https://d3fend.mitre.org/api/ontology/inference/d3fend-full-mappings.json',
  d3fendVersion: 'https://d3fend.mitre.org/api/version.json',
};

function checksum(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function hydrationEntry(id, document, recordCount) {
  return {
    id,
    status: 'OK',
    http: 200,
    url: document.source_artifact,
    sha256: document.checksum,
    byte_length: document.source_artifact_byte_length,
    record_count: recordCount,
    retrieved_at: document.snapshot_date,
  };
}

function updateHydrationManifest(result) {
  const manifest = readJson(HYDRATION_MANIFEST);
  const replacements = new Map([
    ['artifact-mitre-attack-enterprise', hydrationEntry(
      'artifact-mitre-attack-enterprise',
      result.enterprise,
      result.enterprise.records.length,
    )],
    ['artifact-mitre-attack-ics', hydrationEntry(
      'artifact-mitre-attack-ics',
      result.ics,
      result.ics.records.length,
    )],
    ['artifact-mitre-d3fend-ontology', hydrationEntry(
      'artifact-mitre-d3fend-ontology',
      result.d3fend,
      result.d3fend.records.length,
    )],
    ['artifact-mitre-d3fend-mappings', hydrationEntry(
      'artifact-mitre-d3fend-mappings',
      result.attackMap,
      result.attackMap.relationships.length,
    )],
  ]);
  const seen = new Set();
  const results = (manifest.results || []).map((entry) => {
    const replacement = replacements.get(entry.id);
    if (!replacement) return entry;
    seen.add(entry.id);
    return replacement;
  });
  for (const [id, entry] of replacements) {
    if (!seen.has(id)) results.push(entry);
  }
  writeJsonAtomically(HYDRATION_MANIFEST, {
    ...manifest,
    generated_at: new Date().toISOString(),
    hydrated: replacements.size,
    results,
  });
}

function snapshotDateFromStix(document) {
  const modified = (document.objects || [])
    .filter((object) => object.type === 'x-mitre-collection' || object.modified)
    .map((object) => object.modified || object.created)
    .sort()
    .pop();
  return modified ? String(modified).slice(0, 10) : new Date().toISOString().slice(0, 10);
}

function loadCommittedArtifacts() {
  return {
    enterprise: readJson(COMMITTED.enterprise),
    ics: readJson(COMMITTED.ics),
    d3fend: readJson(COMMITTED.d3fend),
    attackMap: readJson(COMMITTED.attackMap),
    nistMap: readJson(COMMITTED.nistMap),
    fallbackMode: 'committed-official-snapshot',
  };
}

function committedArtifactsPresent() {
  return Object.values(COMMITTED).every((path) => existsSync(path));
}

async function fetchJson(url, fetchImpl = strictConditionalFetch) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Fetch failed (${response.status}) for ${url}`);
  }
  return response.json();
}

export async function fetchMitreData(options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const useCommittedOnly = options.committedOnly === true;

  if (useCommittedOnly && committedArtifactsPresent()) {
    return loadCommittedArtifacts();
  }

  try {
    const [
      enterpriseStix,
      icsStix,
      d3fendOntology,
    ] = await Promise.all([
      fetchJson(REMOTE.enterpriseAttack, fetchImpl),
      fetchJson(REMOTE.icsAttack, fetchImpl),
      fetchJson(REMOTE.d3fendOntology, fetchImpl),
    ]);

    // The ATT&CK-to-D3FEND inference endpoint is the least reliable upstream
    // here, and it has been 404 in the field. It only feeds one of the five
    // artifacts, so failing it separately keeps an outage on MITRE's inference
    // API from freezing the other four at their committed snapshot. Each
    // artifact is still all-or-nothing: this never mixes a fresh parse with
    // stale provenance inside one document.
    let d3fendMappings = null;
    let mappingsFallback = "";
    try {
      d3fendMappings = await fetchJson(REMOTE.d3fendMappings, fetchImpl);
    } catch (error) {
      if (!committedArtifactsPresent()) throw error;
      mappingsFallback = `attack-map:${error.message}`;
    }

    const snapshotDate = new Date().toISOString().slice(0, 10);
    const enterpriseVersion = ATTACK_RELEASE;
    const icsVersion = ATTACK_RELEASE;
    // Label the ontology with the version the publisher reports, not a constant.
    // d3fend.json is served unversioned, so a hardcoded release silently
    // relabels new upstream bytes as the old reviewed version: on 2026-09-09 the
    // live ontology had already moved to 1.6.0 while every artifact still said
    // 1.5.0. The reviewed-version pin in verify-source-truth.mjs is what gates
    // an unreviewed bump; this only makes the recorded label truthful.
    // The version endpoint must never be a new hard dependency: if it is
    // unreachable we fall back to the reviewed constant rather than failing a
    // fetch that otherwise succeeded.
    let d3fendVersion = D3FEND_RELEASE;
    try {
      const reported = (await fetchJson(REMOTE.d3fendVersion, fetchImpl))?.ontology_version;
      if (reported) d3fendVersion = String(reported);
    } catch {
      d3fendVersion = D3FEND_RELEASE;
    }

    const enterpriseChecksum = checksum(JSON.stringify(enterpriseStix));
    const icsChecksum = checksum(JSON.stringify(icsStix));
    const d3fendChecksum = checksum(JSON.stringify(d3fendOntology));
    const mappingsChecksum = d3fendMappings ? checksum(JSON.stringify(d3fendMappings)) : '';

    const enterprise = parseEnterpriseAttackStix(enterpriseStix, {
      artifactUrl: REMOTE.enterpriseAttack,
      version: enterpriseVersion,
      snapshotDate,
      checksum: enterpriseChecksum,
      byteLength: Buffer.byteLength(JSON.stringify(enterpriseStix)),
      locatorPrefix: 'enterprise-attack.json',
    });
    const ics = parseIcsAttackStix(icsStix, {
      artifactUrl: REMOTE.icsAttack,
      version: icsVersion,
      snapshotDate,
      checksum: icsChecksum,
      byteLength: Buffer.byteLength(JSON.stringify(icsStix)),
      locatorPrefix: 'ics-attack.json',
    });

    const d3fendTactics = resolveD3fendTactics(d3fendOntology);
    const d3fendRecords = parseD3fendTechniques(d3fendOntology)
      .filter((record) => d3fendTactics.has(record.id));
    const d3fendDefinitions = resolveD3fendDefinitions(d3fendOntology);
    for (const record of d3fendRecords) {
      record.source.snapshot_date = snapshotDate;
      record.source.version = String(d3fendVersion);
      const tactic = d3fendTactics.get(record.id);
      record.family = tactic?.title || '';
      record.metadata.tactic_id = tactic?.id || null;
      record.metadata.tactic_title = tactic?.title || null;
      // Keep the defensive-technique projection sourced from the versioned
      // ontology graph. Empty definitions remain absent rather than receiving
      // adapter-authored prose.
      if (!record.description) {
        record.description = d3fendDefinitions.get(record.id) || '';
      }
    }
    const d3fend = buildD3fendCatalogDocument(d3fendRecords, {
      artifactUrl: REMOTE.d3fendOntology,
      version: String(d3fendVersion),
      snapshotDate,
      checksum: d3fendChecksum,
      byteLength: Buffer.byteLength(JSON.stringify(d3fendOntology)),
    });

    const slugToD3fendId = buildSlugToD3fendIdMap(d3fendRecords);
    const attackCatalogLookup = buildAttackCatalogLookup(
      enterprise.records,
      ics.records,
    );
    const bindings = d3fendMappings?.results?.bindings || [];
    const attackRelationships = buildAttackToD3fendRelationships(
      bindings,
      slugToD3fendId,
      attackCatalogLookup,
      {
        artifactUrl: REMOTE.d3fendMappings,
        version: D3FEND_RELEASE,
        snapshotDate,
        checksum: mappingsChecksum,
        byteLength: Buffer.byteLength(JSON.stringify(d3fendMappings)),
      },
    );
    const nistRelationships = buildD3fendToNistRelationships(
      d3fendOntology,
      slugToD3fendId,
      {
        artifactUrl: REMOTE.d3fendOntology,
        version: String(d3fendVersion),
        snapshotDate,
        checksum: checksum(JSON.stringify(d3fendOntology)),
        byteLength: Buffer.byteLength(JSON.stringify(d3fendOntology)),
      },
    );

    // Keep the committed mapping document verbatim when the inference endpoint
    // is unavailable, rather than publishing an empty one that would read as
    // "MITRE stopped mapping these".
    const attackMap = d3fendMappings
      ? buildMappingDocument(attackRelationships, {
          artifactUrl: REMOTE.d3fendMappings,
          version: D3FEND_RELEASE,
          snapshotDate,
          checksum: mappingsChecksum,
          byteLength: Buffer.byteLength(JSON.stringify(d3fendMappings)),
          provenance: 'MITRE D3FEND inferred ATT&CK technique to defensive technique mappings',
        })
      : readJson(COMMITTED.attackMap);
    const nistMap = buildMappingDocument(nistRelationships, {
      artifactUrl: REMOTE.d3fendOntology,
      version: String(d3fendVersion),
      snapshotDate,
      checksum: checksum(JSON.stringify(d3fendOntology)),
      byteLength: Buffer.byteLength(JSON.stringify(d3fendOntology)),
      provenance: 'MITRE D3FEND NIST SP 800-53 Rev. 5 control to defensive technique mappings',
    });

    return {
      enterprise,
      ics,
      d3fend,
      attackMap,
      nistMap,
      fallbackMode: mappingsFallback || null,
      // A dead mapping endpoint does not make the other four artifacts stale.
      // Flagging it as partial lets the hydration manifest record the fresh
      // checksums it just produced, while a full fallback still records none.
      partialFallback: Boolean(mappingsFallback),
    };
  } catch (error) {
    if (committedArtifactsPresent()) {
      const committed = loadCommittedArtifacts();
      return {
        ...committed,
        fallbackMode: `network-error:${error.message}`,
      };
    }
    throw error;
  }
}

async function main() {
  const result = await fetchMitreData();
  // A *partial* fallback is the anticipated case documented above: MITRE's
  // inference API is 404 and only the ATT&CK-to-D3FEND map falls back to its
  // committed snapshot, while the other four artifacts were fetched fresh.
  // Failing the refresh for that freezes every remaining ingestion task over
  // one retired upstream endpoint. A whole-fetch fallback stays fatal, because
  // it means nothing fresh was retrieved at all.
  if (result.fallbackMode && !result.partialFallback && process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1') {
    throw new Error(`MITRE refresh required a live upstream fetch but used ${result.fallbackMode}`);
  }
  writeJsonAtomically(COMMITTED.enterprise, result.enterprise);
  writeJsonAtomically(COMMITTED.ics, result.ics);
  writeJsonAtomically(COMMITTED.d3fend, result.d3fend);
  writeJsonAtomically(COMMITTED.attackMap, result.attackMap);
  writeJsonAtomically(COMMITTED.nistMap, result.nistMap);
  // Record the retrieval evidence whenever something was actually retrieved.
  // Skipping this on a partial fallback left the freshly fetched D3FEND
  // ontology's checksum unrecorded, and verify:manifests rightly rejected the
  // disagreement between the artifact on disk and the manifest describing it.
  if (!result.fallbackMode || result.partialFallback) {
    updateHydrationManifest(result);
  }

  if (result.fallbackMode) {
    console.log(`MITRE fetch fallback: ${result.fallbackMode}`);
  }
  console.log(
    `Wrote ${result.enterprise.records.length} enterprise techniques, ${result.ics.records.length} ICS techniques, ${result.d3fend.records.length} D3FEND countermeasures, ${result.attackMap.relationships.length} attack mappings, and ${result.nistMap.relationships.length} NIST mappings`,
  );
}

if (process.argv[1]?.includes('fetch-mitre-data.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
