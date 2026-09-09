#!/usr/bin/env node
// spec §5 — full OLIR discovery: retrieve each applicable Final record's
// NIST detail, then download and parse every deterministically reachable
// structured submission. Entries without an obtainable structured artifact
// remain quarantined with their exact retrieval evidence.
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOlirStructuredArtifact, retrieveStructuredOlirArtifact } from '../tools/relationship-builders/olir-retrieval.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CATALOG_URL =
  'https://csrc.nist.gov/extensions/nudp/services/json/olir/informative-reference-catalog';
const OLIR_API_ROOT = 'https://csrc.nist.gov/extensions/nudp/services/json/olir';

// focusDocName (exact, as returned by the live API) -> Control Atlas catalog_id.
// Only current/2.0-era publication titles resolve; legacy titles (e.g. CSF 1.1's
// "Framework for Improving Critical Infrastructure Cybersecurity", or 800-53
// Rev 3/4's "...for Federal Information Systems and Organizations") are
// intentionally excluded — spec §4 rejects CSF-1.1-only identifiers from the
// active CSF 2.0 catalog, and the same "current publication only" rule applies
// to every other framework here.
const FOCAL_CATALOG_MAP = new Map([
  ['NIST Cybersecurity Framework', 'csf-2'],
  ['Security and Privacy Controls for Information Systems and Organizations', 'nist-800-53'],
  ['Protecting Controlled Unclassified Information in Nonfederal Systems and Organizations', 'nist-800-171'],
  ['Artificial Intelligence Risk Management Framework (AI RMF 1.0)', 'nist-ai-rmf'],
  ['Secure Software Development Framework (SSDF): Recommendations for Mitigating the Risk of Software Vulnerabilities', 'nist-ssdf'],
]);

// NIST's stated preference order (spec §5 / CSRC OLIR program guidance).
function authorityTier(entry) {
  const owner = entry.authorityDescription === 'Owner';
  const nist = /national institute of standards and technology|^nist\b/i.test(entry.developer || '');
  const govAdjacent = /nist|dod|cisa|omb|nara|gsa|department|agency|administration/i.test(entry.developer || '')
    && entry.submissionCategoryDescription === 'Public Sector';
  if (entry.statusDescription === 'Final') {
    if (owner && nist) return { tier: 1, label: 'NIST owner-authority Final' };
    if (owner && govAdjacent) return { tier: 2, label: 'Other government owner-authority Final' };
    if (govAdjacent) return { tier: 3, label: 'Other government Final' };
    if (owner) return { tier: 4, label: 'Validated third-party Final' };
    return { tier: 7, label: 'Community candidate Final' };
  }
  if (entry.statusDescription === 'Draft') return { tier: 5, label: 'Draft' };
  if (entry.statusDescription === 'Work-in-progress Draft') return { tier: 6, label: 'Derived non-authoritative (work-in-progress)' };
  return { tier: 7, label: `Community candidate (${entry.statusDescription || 'unknown status'})` };
}

function quarantineReason(entry, catalogId) {
  if (!catalogId) {
    return `focal document "${entry.focusDocName}" is not a Control Atlas catalog (current-publication scope only)`;
  }
  if (entry.statusDescription !== 'Final') {
    return `OLIR status is "${entry.statusDescription}", not Final — held out of the published graph pending NIST finalization`;
  }
  return 'no downloadable structured relationship artifact at this submission — the OLIR catalog list API exposes only a pointer to the referenced publication (referenceUrl), not a machine-parseable crosswalk file; NIST\'s per-entry submission-artifact endpoint (/details/{id}, /reference-detail/{id}) returns 404 from this environment for every id tried';
}

async function mapWithConcurrency(items, limit, work) {
  const output = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        output[index] = await work(items[index]);
      }
    }),
  );
  return output;
}

async function retrieveDetail(id) {
  const url = `${OLIR_API_ROOT}/informative-reference-catalog/details/${id}`;
  try {
    const response = await strictConditionalFetch(url, { signal: AbortSignal.timeout(15_000) });
    const body = response.ok ? await response.json() : null;
    const detail = body?.response?.[0] || null;
    if (!detail) throw new Error(`OLIR detail ${id} missing (${response.status})`);
    return {
      kind: 'NIST catalog detail endpoint',
      url,
      status: response.status,
      final_url: response.url,
      json_file_url: detail?.jsonFileUrl || null,
      publisher_sha256: detail?.jsonSha256 ? `sha256:${String(detail.jsonSha256).toLowerCase()}` : null,
      submission_url: detail?.webSite || null,
      reference_url: detail?.referenceUrl || null,
      mapping_summary: detail?.summary || null,
      mapping_comment: detail?.comment || null,
    };
  } catch (error) {
    return { kind: 'NIST catalog detail endpoint', url, error: error instanceof Error ? error.message : String(error) };
  }
}

async function retrieveEntry(entry) {
  const id = entry.informativeReferenceFrameworkVersionId;
  const detail = await retrieveDetail(id);
  const candidates = [detail.json_file_url, detail.submission_url, detail.reference_url, entry.referenceUrl];
  const retrieved = await retrieveStructuredOlirArtifact(candidates);
  const attempts = [detail, ...retrieved.attempted];
  if (!retrieved.artifact) return {
    attempts, mapping: null,
    unsupported: !detail.json_file_url && attempts.every((attempt) => !attempt.error && attempt.status >= 200 && attempt.status < 300),
    unavailable_reason: 'no structured artifact could be downloaded from the NIST detail JSON, submission, reference, or catalog URL',
  };
  try {
    const parsed = await parseOlirStructuredArtifact(retrieved.artifact);
    if (!parsed.relationships.length) {
      return { attempts, mapping: null, parse_failed: true, unavailable_reason: `downloaded structured artifact contains no parseable OLIR relationships (${parsed.parser})` };
    }
    const mapFile = `maps/olir/${id}.json`;
    const document = {
      schema_version: '1.0',
      olir_id: id,
      source_artifact: retrieved.artifact.url,
      sha256: retrieved.artifact.sha256,
      byte_length: retrieved.artifact.bytes.length,
      parser: parsed.parser,
      relationships: parsed.relationships,
    };
    return {
      attempts,
      document,
      mapping: {
        map_file: mapFile,
        artifact_url: retrieved.artifact.url,
        checksum: retrieved.artifact.sha256,
        byte_length: retrieved.artifact.bytes.length,
        parser: parsed.parser,
        relationship_count: parsed.relationships.length,
        relationship_semantics: [...new Set(parsed.relationships.map((relationship) => relationship.relationship_type))].sort(),
      },
      unavailable_reason: null,
    };
  } catch (error) {
    return { attempts, mapping: null, parse_failed: true, unavailable_reason: `downloaded artifact could not be parsed as an OLIR relationship mapping: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function validateOlirCandidate(retrievalById, previousItems = []) {
  const previouslyIngested = new Set(previousItems.filter((item) => item.ingested).map((item) => item.id));
  for (const [id, retrieval] of retrievalById) {
    const detail = retrieval.attempts?.[0];
    const successful = (attempt) => !attempt.error && Number.isInteger(attempt.status) && attempt.status >= 200 && attempt.status < 300;
    const supportedExclusion = retrieval.unsupported && retrieval.attempts?.every(successful);
    if (!detail || !successful(detail)
      || retrieval.parse_failed || (!retrieval.mapping && (!supportedExclusion || previouslyIngested.has(id)))) {
      throw new Error(`OLIR refresh incomplete for ${id}: ${retrieval.unavailable_reason || detail?.error || 'missing expected detail or artifact'}`);
    }
  }
}

export async function fetchOlirCatalog() {
  const response = await strictConditionalFetch(CATALOG_URL);
  if (!response.ok) throw new Error(`OLIR catalog fetch failed (${response.status})`);
  const body = await response.json();
  const entries = body?.response?.searchResults;
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('OLIR catalog API returned no entries');
  }

  const applicableFinalEntries = entries.filter(
    (entry) =>
      entry.statusDescription === 'Final' &&
      FOCAL_CATALOG_MAP.has(entry.focusDocName),
  );
  const manifestPath = join(ROOT, 'data', 'olir-catalog-manifest.json');
  const previousItems = existsSync(manifestPath)
    ? JSON.parse(readFileSync(manifestPath, 'utf8')).processed_items || [] : [];
  const retrievalById = new Map(
    (await mapWithConcurrency(applicableFinalEntries, 6, async (entry) => [
      entry.informativeReferenceFrameworkVersionId,
      await retrieveEntry(entry),
    ])).map(([id, retrieval]) => [id, retrieval]),
  );
  validateOlirCandidate(retrievalById, previousItems);

  const processed_items = entries.map((entry) => {
    const id = entry.informativeReferenceFrameworkVersionId;
    const catalogId = FOCAL_CATALOG_MAP.get(entry.focusDocName) || null;
    const authority = authorityTier(entry);
    const retrieval = retrievalById.get(id);
    const ingested = retrieval?.mapping || null;
    const retrieval_attempts = retrieval?.attempts || [];
    const attemptSummary = retrieval_attempts
      .map((attempt) => `${attempt.kind} ${attempt.status ?? attempt.error ?? 'not reached'}`)
      .join('; ');

    return {
      id,
      framework_version_identifier: entry.frameworkVersionIdentifier,
      name: entry.referenceName,
      focal_document: entry.focusDocName,
      resolved_catalog_id: catalogId,
      reference_document_version: entry.shortName,
      version: entry.version,
      status: entry.statusDescription,
      authority_description: entry.authorityDescription,
      submission_category: entry.submissionCategoryDescription,
      developer: entry.developer,
      posted_date: entry.posted_date,
      reference_date: entry.referenceDate,
      submission_artifact_url: entry.referenceUrl,
      authority_tier: authority.tier,
      authority_tier_label: authority.label,
      mapping_model: ingested?.relationship_semantics?.join(', ') || null,
      ingested: Boolean(ingested),
      map_file: ingested?.map_file || null,
      artifact_id: null,
      artifact: ingested,
      quarantine_reason: ingested
        ? null
        : retrieval?.unavailable_reason
          ? `${retrieval.unavailable_reason}; retrieval evidence: ${attemptSummary}`
          : quarantineReason(entry, catalogId),
      retrieval_attempts,
    };
  });

  const manifest = {
    generated_at: new Date().toISOString(),
    source: 'https://csrc.nist.gov/projects/olir/informative-reference-catalog',
    api_endpoint: CATALOG_URL,
    total_entries: entries.length,
    final_count: processed_items.filter((item) => item.status === 'Final').length,
    applicable_final_count: processed_items.filter(
      (item) => item.status === 'Final' && item.resolved_catalog_id,
    ).length,
    ingested_count: processed_items.filter((item) => item.status === 'Final' && item.resolved_catalog_id && item.ingested).length,
    quarantined_count: processed_items.filter((item) => !item.ingested).length,
    unresolved_count: processed_items.filter(
      (item) => item.status === 'Final' && item.resolved_catalog_id && !item.ingested,
    ).length,
    processed_items,
  };

  // The complete candidate is validated before replacing any last-good map.
  // The outer source transaction owns rollback if a filesystem write fails.
  rmSync(join(ROOT, 'maps', 'olir'), { recursive: true, force: true });
  mkdirSync(join(ROOT, 'maps', 'olir'), { recursive: true });
  for (const retrieval of retrievalById.values()) {
    if (retrieval.mapping) writeJsonAtomically(join(ROOT, retrieval.mapping.map_file), retrieval.document);
  }
  writeJsonAtomically(manifestPath, manifest);

  return manifest;
}

if (process.argv[1]?.includes('fetch-olir-catalog.mjs')) {
  fetchOlirCatalog()
    .then((manifest) =>
      console.log(
        `Wrote ${manifest.total_entries} OLIR catalog entries (${manifest.ingested_count} ingested, ${manifest.quarantined_count} quarantined) to data/olir-catalog-manifest.json`,
      ),
    )
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}
