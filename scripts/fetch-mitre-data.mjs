#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { assertPublisherInventory } from './lib/publisher-inventory.mjs';
import { observeCatalog } from './lib/source-baseline.mjs';

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

const ATTACK_API = 'https://api.github.com/repos/mitre-attack/attack-stix-data';

const REMOTE = {
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
  const bytes = Buffer.from(await response.arrayBuffer());
  return { payload: JSON.parse(bytes.toString('utf8')), bytes };
}

export async function resolveAttackRelease(fetchImpl = strictConditionalFetch) {
  const release = (await fetchJson(`${ATTACK_API}/releases/latest`, fetchImpl)).payload;
  const tag = release?.tag_name;
  if (!/^v\d+\.\d+(?:\.\d+)?$/.test(tag || '') || release.draft !== false || release.prerelease !== false ||
      release.html_url !== `https://github.com/mitre-attack/attack-stix-data/releases/tag/${tag}`) {
    throw new Error('Invalid official ATT&CK publisher release metadata');
  }
  const commit = (await fetchJson(`${ATTACK_API}/commits/${tag}`, fetchImpl)).payload;
  if (!/^[a-f0-9]{40}$/.test(commit?.sha || '') ||
      commit.url !== `${ATTACK_API}/commits/${commit.sha}`) throw new Error('Invalid official ATT&CK publisher commit metadata');
  const version = tag.slice(1);
  const raw = `https://raw.githubusercontent.com/mitre-attack/attack-stix-data/${commit.sha}`;
  return { version, commit: commit.sha,
    enterpriseAttack: `${raw}/enterprise-attack/enterprise-attack-${version}.json`,
    icsAttack: `${raw}/ics-attack/ics-attack-${version}.json`,
  };
}

export function resolveD3fendVersion(payload) {
  const version = payload?.ontology_version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Missing or invalid D3FEND publisher version');
  return version;
}

export function assertAttackCollectionVersion(payload, version) {
  const collections = payload?.objects?.filter((entry) => entry.type === 'x-mitre-collection');
  if (collections?.length !== 1 || collections[0].x_mitre_version !== version) {
    throw new Error('ATT&CK publisher collection version differs from official release');
  }
}

// Shared admission check: current publisher metadata may advance, while source
// authority, independently reconciled bytes and accepted baseline remain binding.
export function validateMitreReleaseAdmission({ source, document, bytes, accepted, domain }) {
  const errors = [];
  const version = document?.source_version;
  const url = document?.source_artifact;
  if (domain === 'd3fend') {
    if (url !== REMOTE.d3fendOntology || !/^\d+\.\d+\.\d+$/.test(version || '')) errors.push('invalid D3FEND publisher source');
  } else {
    const match = /^https:\/\/raw\.githubusercontent\.com\/mitre-attack\/attack-stix-data\/([a-f0-9]{40})\/(enterprise|ics)-attack\/\2-attack-(\d+\.\d+(?:\.\d+)?)\.json$/.exec(url || '');
    if (!match || match[2] !== domain || match[3] !== version) errors.push('ATT&CK source must identify the official repository, immutable commit, domain and version');
  }
  if (!source || source.owner !== 'MITRE' || source.provenance_class !== 'mitre_published' ||
      source.artifact_url !== url || source.version !== version || source.checksum !== document.checksum) {
    errors.push('registry and MITRE catalog source evidence disagree');
  }
  try {
    const observed = observeCatalog(bytes);
    if (!accepted || observed.normalized_sha256 !== accepted.normalized_sha256 ||
        observed.record_count !== accepted.record_count || observed.identity_sha256 !== accepted.identity_sha256 ||
        (accepted.publisher_version != null && accepted.publisher_version !== version)) errors.push('MITRE catalog differs from accepted baseline');
    const inventory = document.publisher_inventory;
    if (Boolean(inventory) !== Boolean(accepted?.independent_inventory)) errors.push('MITRE inventory state differs from accepted baseline');
    if (inventory && (inventory.publisher_version !== version || inventory.source_url !== url ||
        inventory.source_sha256 !== document.checksum || inventory.source_byte_length !== document.source_artifact_byte_length ||
        document.checksum_basis !== 'raw_bytes' ||
        !/^sha256:[a-f0-9]{64}$/.test(inventory.source_sha256 || '') || !Number.isSafeInteger(inventory.source_byte_length) || inventory.source_byte_length <= 0)) {
      errors.push('MITRE publisher inventory and catalog release evidence disagree');
    }
  } catch (error) { errors.push(error.message); }
  return errors;
}

export async function fetchMitreData(options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const useCommittedOnly = options.committedOnly === true;

  if (useCommittedOnly && committedArtifactsPresent()) {
    return loadCommittedArtifacts();
  }

  try {
    const attackRelease = await resolveAttackRelease(fetchImpl);
    const remote = { ...REMOTE, ...attackRelease };
    const d3fendVersion = resolveD3fendVersion((await fetchJson(REMOTE.d3fendVersion, fetchImpl)).payload);
    const [
      enterpriseResponse,
      icsResponse,
      d3fendResponse,
    ] = await Promise.all([
      fetchJson(remote.enterpriseAttack, fetchImpl),
      fetchJson(remote.icsAttack, fetchImpl),
      fetchJson(REMOTE.d3fendOntology, fetchImpl),
    ]);
    const enterpriseStix = enterpriseResponse.payload;
    const icsStix = icsResponse.payload;
    const d3fendOntology = d3fendResponse.payload;
    assertAttackCollectionVersion(enterpriseStix, attackRelease.version);
    assertAttackCollectionVersion(icsStix, attackRelease.version);
    if (resolveD3fendVersion((await fetchJson(REMOTE.d3fendVersion, fetchImpl)).payload) !== d3fendVersion) {
      throw new Error('D3FEND publisher version changed during retrieval');
    }

    // The ATT&CK-to-D3FEND inference endpoint is the least reliable upstream
    // here, and it has been 404 in the field. It only feeds one of the five
    // artifacts, so failing it separately keeps an outage on MITRE's inference
    // API from freezing the other four at their committed snapshot. Each
    // artifact is still all-or-nothing: this never mixes a fresh parse with
    // stale provenance inside one document.
    let d3fendMappings = null;
    let mappingsBytes = null;
    let mappingsFallback = "";
    try {
      const mappingResponse = await fetchJson(REMOTE.d3fendMappings, fetchImpl);
      d3fendMappings = mappingResponse.payload;
      mappingsBytes = mappingResponse.bytes;
    } catch (error) {
      if (!committedArtifactsPresent()) throw error;
      mappingsFallback = `attack-map:${error.message}`;
    }

    const snapshotDate = new Date().toISOString().slice(0, 10);
    const enterpriseVersion = attackRelease.version;
    const icsVersion = attackRelease.version;

    const enterpriseChecksum = checksum(enterpriseResponse.bytes);
    const icsChecksum = checksum(icsResponse.bytes);
    const d3fendChecksum = checksum(d3fendResponse.bytes);
    const mappingsChecksum = mappingsBytes ? checksum(mappingsBytes) : '';

    const enterprise = parseEnterpriseAttackStix(enterpriseStix, {
      artifactUrl: remote.enterpriseAttack,
      version: enterpriseVersion,
      snapshotDate,
      checksum: enterpriseChecksum,
      byteLength: enterpriseResponse.bytes.length,
      locatorPrefix: 'enterprise-attack.json',
    });
    const ics = parseIcsAttackStix(icsStix, {
      artifactUrl: remote.icsAttack,
      version: icsVersion,
      snapshotDate,
      checksum: icsChecksum,
      byteLength: icsResponse.bytes.length,
      locatorPrefix: 'ics-attack.json',
    });

    const inventory = (format, raw, records, url, bytes, publisherVersion = null) => ({
      ...assertPublisherInventory(format, raw, records),
      source_url: url,
      source_sha256: checksum(bytes),
      source_byte_length: bytes.length,
      publisher_version: publisherVersion,
      ...(publisherVersion ? {} : { publisher_version_reason: 'Publisher payload does not declare a release version' }),
    });
    const stixVersion = (raw) => raw.objects?.find((entry) => entry.type === 'x-mitre-collection')?.x_mitre_version || null;
    enterprise.publisher_inventory = inventory('attack-enterprise', enterpriseStix, enterprise.records, remote.enterpriseAttack, enterpriseResponse.bytes, stixVersion(enterpriseStix));
    ics.publisher_inventory = inventory('attack-ics', icsStix, ics.records, remote.icsAttack, icsResponse.bytes, stixVersion(icsStix));
    // Builders default to canonical JSON; these fetches attest the actual response bytes.
    enterprise.checksum_basis = 'raw_bytes';
    ics.checksum_basis = 'raw_bytes';

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
      byteLength: d3fendResponse.bytes.length,
    });
    d3fend.checksum_basis = 'raw_bytes';
    d3fend.publisher_inventory = inventory('d3fend', d3fendOntology, d3fend.records, REMOTE.d3fendOntology, d3fendResponse.bytes, d3fendVersion);

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
        version: d3fendVersion,
        snapshotDate,
        checksum: mappingsChecksum,
        byteLength: mappingsBytes?.length || 0,
      },
    );
    const nistRelationships = buildD3fendToNistRelationships(
      d3fendOntology,
      slugToD3fendId,
      {
        artifactUrl: REMOTE.d3fendOntology,
        version: String(d3fendVersion),
        snapshotDate,
        checksum: d3fendChecksum,
        byteLength: d3fendResponse.bytes.length,
      },
    );

    // Keep the committed mapping document verbatim when the inference endpoint
    // is unavailable, rather than publishing an empty one that would read as
    // "MITRE stopped mapping these".
    const attackMap = d3fendMappings
      ? buildMappingDocument(attackRelationships, {
          artifactUrl: REMOTE.d3fendMappings,
          version: d3fendVersion,
          snapshotDate,
          checksum: mappingsChecksum,
          byteLength: mappingsBytes.length,
          provenance: 'MITRE D3FEND inferred ATT&CK technique to defensive technique mappings',
        })
      : readJson(COMMITTED.attackMap);
    const nistMap = buildMappingDocument(nistRelationships, {
      artifactUrl: REMOTE.d3fendOntology,
      version: String(d3fendVersion),
      snapshotDate,
      checksum: d3fendChecksum,
      byteLength: d3fendResponse.bytes.length,
      provenance: 'MITRE D3FEND NIST SP 800-53 Rev. 5 control to defensive technique mappings',
    });
    if (d3fendMappings) attackMap.checksum_basis = 'raw_bytes';
    nistMap.checksum_basis = 'raw_bytes';

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
    // A fetched payload that cannot reconcile must be quarantined, never relabeled a network fallback.
    if (options.requireFresh || process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1') throw error;
    if (/publisher|inventory|identity/i.test(error.message)) throw error;
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
