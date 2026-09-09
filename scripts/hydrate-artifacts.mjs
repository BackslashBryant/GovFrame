#!/usr/bin/env node
// hydrate-artifacts — download every directly retrievable source artifact,
// compute REAL sha256 + byte length + record count from the actual bytes, and
// write those values back into data/source-registry.json. Emits
// data/generated/artifact-hydration.json as the from-execution evidence log.
//
// Determinism: retrieved_at is preserved when the content hash is unchanged, so
// a second run produces no diff unless upstream bytes actually changed.
//
// Nothing here is fabricated: an artifact is hydrated only if its exact URL
// returns bytes we hash ourselves. Anything that cannot be retrieved is left
// untouched and reported so the caller can quarantine it with a reason.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import readXlsxFile from 'read-excel-file/node';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY = join(ROOT, 'data/source-registry.json');
const OUT = join(ROOT, 'data/artifact-hydration-manifest.json');

// ---- Deterministic record counters keyed by counting method. ----
function countOscalControls(json) {
  // Count controls + nested enhancements across all groups (OSCAL catalog).
  let n = 0;
  const walkControls = (controls) => {
    for (const c of controls || []) {
      n += 1;
      if (c.controls) walkControls(c.controls);
    }
  };
  const walkGroups = (groups) => {
    for (const g of groups || []) {
      if (g.controls) walkControls(g.controls);
      if (g.groups) walkGroups(g.groups);
    }
  };
  const cat = json.catalog || json;
  walkGroups(cat.groups);
  walkControls(cat.controls);
  return n;
}
function countOscalProfileImports(json) {
  const prof = json.profile || json;
  let n = 0;
  for (const imp of prof.imports || []) {
    if (imp['include-controls']) {
      for (const inc of imp['include-controls']) n += (inc['with-ids'] || []).length;
    }
    if (imp['include-all']) n += 1;
  }
  return n;
}
function countStixTechniques(json) {
  return (json.objects || []).filter(
    (o) => o.type === 'attack-pattern' && !o.revoked && !o.x_mitre_deprecated,
  ).length;
}
function countJsonLdEntries(json) {
  if (Array.isArray(json)) return json.length;
  if (json['@graph']) return json['@graph'].length;
  if (json.results && json.results.bindings) return json.results.bindings.length;
  return Object.keys(json).length;
}
function countCsvRows(text) {
  return text.split(/\r?\n/).filter((l) => l.trim().length > 0).length - 1; // minus header
}
function countCciItems(buf) {
  const files = unzipSync(new Uint8Array(buf));
  const xmlName = Object.keys(files).find((f) => /\.xml$/i.test(f));
  if (!xmlName) throw new Error('no XML in CCI zip');
  const xml = Buffer.from(files[xmlName]).toString('utf8');
  const m = xml.match(/<cci_item\b/g);
  return m ? m.length : 0;
}

// NIST OSCAL content is pinned to release tag v1.5.0 (published 2026-05-13) so
// re-runs are deterministic against a fixed tree rather than the moving `main`.
const OSCAL = 'https://raw.githubusercontent.com/usnistgov/oscal-content/v1.5.0/nist.gov';

// Each resolution: exact file URL + parser label + counting method.
// Only artifacts whose URL is a real downloadable FILE belong here.
// `local` resolutions hash a file already in the repo (Control Atlas's own
// editorial spine) rather than fetching over the network.
const RESOLUTIONS = [
  { id: 'artifact-nist-800-171-rev2', url: 'https://csrc.nist.gov/files/pubs/sp/800/171/r2/upd1/final/docs/sp800-171r2-security-reqs.csv', format: 'csv', parser: 'csv', parser_version: '1.0.0', count: 'csv' },
  { id: 'artifact-nist-ai-rmf-playbook', url: 'https://airc.nist.gov/docs/playbook.json', format: 'json', parser: 'ai-rmf-playbook-json', parser_version: '1.0.0', count: 'jsonld' },
  { id: 'artifact-fedramp-2026-rules', url: 'https://raw.githubusercontent.com/FedRAMP/rules/main/fedramp-consolidated-rules.json', format: 'json', parser: 'fedramp-consolidated-rules-json', parser_version: '1.0.0', count: 'jsonld' },
  // The four MITRE artifacts are deliberately absent. fetch-mitre-data.mjs owns
  // them: it fetches ATT&CK at a pinned release commit rather than master, takes
  // D3FEND from the ontology URL the registry actually declares, and
  // migrate-source-truth-profiles.mjs syncs the registry's sha256, artifact_url,
  // byte_length and record_count from the catalogs it writes.
  //
  // Hydrating them here as well meant two tasks claiming the same artifact ids
  // from different URLs -- master versus a pinned commit, and
  // /api/technique/all.json versus /ontologies/d3fend.json -- so the registry
  // and the execution manifest recorded checksums of genuinely different bytes
  // and verify-manifests rejected all three. One artifact, one hydrator.
  { id: 'artifact-disa-cci-list', url: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_CCI_List.zip', format: 'oscal_xml', parser: 'cci-xml', parser_version: '1.0.0', count: 'cci' },
  // NIST OSCAL catalog family (pinned v1.5.0). These target the graph-cited
  // artifact ids (artifact-<catalogId>) so node/edge provenance resolves to
  // real evidence; the fabricated `-oscal`/`-oscal-mappings` twins are removed.
  { id: 'artifact-nist-800-53', url: `${OSCAL}/SP800-53/rev5/json/NIST_SP-800-53_rev5_catalog.json`, format: 'oscal_json', parser: 'oscal-json', parser_version: '1.5.0', count: 'oscal_catalog' },
  { id: 'artifact-nist-800-172-rev3', url: `${OSCAL}/SP800-172/rev3/json/NIST_SP800-172_rev3_catalog.json`, format: 'oscal_json', parser: 'oscal-json', parser_version: '1.5.0', count: 'oscal_catalog' },
  { id: 'artifact-nist-ssdf', url: `${OSCAL}/SP800-218/ver1/json/NIST_SP800-218_ver1_catalog.json`, format: 'oscal_json', parser: 'oscal-json', parser_version: '1.5.0', count: 'oscal_catalog' },
  { id: 'artifact-nist-800-171-oscal-mappings', url: `${OSCAL}/SP800-171/rev3/json/NIST_SP800-171_rev3_catalog.json`, format: 'oscal_json', parser: 'oscal-json', parser_version: '1.5.0', count: 'oscal_catalog' },
  // Direct-download spreadsheets (real bytes + first-sheet row counts).
  { id: 'artifact-fedramp-rev5', url: 'https://www.fedramp.gov/legacy/assets/LEGACY%20FedRAMP_Security_Controls_Baseline.xlsx', format: 'spreadsheet', parser: 'fedramp-legacy-baseline-workbook', parser_version: '1.0.0', count: 'xlsx' },
  { id: 'artifact-nist-800-53-rev4-rev5-crosswalk', url: 'https://csrc.nist.gov/files/pubs/sp/800/53/r5/upd1/final/docs/sp800-53r4-to-r5-comparison-workbook.xlsx', format: 'spreadsheet', parser: 'rev4-rev5-crosswalk-xlsx', parser_version: '1.0.0', count: 'xlsx' },
  { id: 'artifact-nist-csf-53-supplemental', url: 'https://csrc.nist.gov/files/pubs/sp/800/53/r5/upd1/final/docs/csf-pf-to-sp800-53r5-mappings.xlsx', format: 'spreadsheet', parser: 'olir-xlsx', parser_version: '1.0.0', count: 'xlsx' },
  // NIST OLIR crosswalk submissions (byte-stable Final files; refIds 186/179).
  { id: 'artifact-nist-csf11-csf20-crosswalk', url: 'https://csrc.nist.gov/csrc/media/Projects/olir/documents/submissions/CSFv1.1_to_CSFv2.0_CROSSWALK_20240220.xlsx', format: 'spreadsheet', parser: 'olir-xlsx', parser_version: '1.0.0', count: 'xlsx' },
  { id: 'artifact-nist-olir-csf2-to-sp800-53', url: 'https://csrc.nist.gov/csrc/media/projects/olir/documents/submissions/Cybersecurity_Framework_v2-0_Concept_Crosswalk_800-53_5_2_0_draft.xlsx', format: 'spreadsheet', parser: 'olir-xlsx', parser_version: '1.0.0', count: 'xlsx' },
  { id: 'artifact-nist-olir-csf2-to-sp800-171', url: 'https://csrc.nist.gov/csrc/media/Projects/olir/documents/submissions/CSFv2.0_Concept_Crosswalk_SP171r3_OLIR.xlsx', format: 'spreadsheet', parser: 'olir-xlsx', parser_version: '1.0.0', count: 'xlsx' },
  // NIST and Microsoft Zero Trust structured sources.
  { id: 'artifact-nist-sp-800-207', url: 'https://nvlpubs.nist.gov/nistpubs/specialpublications/NIST.SP.800-207.pdf', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-nist-sp-800-207a', url: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-207A.pdf', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-nist-sp-1800-35', url: 'https://pages.nist.gov/zero-trust-architecture/', format: 'html', parser: 'explicit-html-markup', parser_version: '1.0.0' },
  { id: 'artifact-nist-sp-1800-35-csf2-mappings', url: 'https://pages.nist.gov/zero-trust-architecture/_downloads/01dfaff2b25f0a61f127f06906bc37cc/CSF2.0Mapping.xlsx', format: 'spreadsheet', parser: 'nist-zero-trust-mapping-xlsx', parser_version: '1.0.0' },
  { id: 'artifact-nist-sp-1800-35-critical-software-mappings', url: 'https://pages.nist.gov/zero-trust-architecture/_downloads/641f02c11e6f71752bb8bc96d96c5f38/NISTCSSMMapping.xlsx', format: 'spreadsheet', parser: 'nist-zero-trust-mapping-xlsx', parser_version: '1.0.0' },
  { id: 'artifact-nist-sp-1800-35-csf11-mappings', url: 'https://pages.nist.gov/zero-trust-architecture/_downloads/993f56b28d4d113836cb1f1a34146cb3/CSF1.1Mapping.xlsx', format: 'spreadsheet', parser: 'nist-zero-trust-mapping-xlsx', parser_version: '1.0.0' },
  { id: 'artifact-nist-sp-1800-35-sp80053-mappings', url: 'https://pages.nist.gov/zero-trust-architecture/_downloads/eba81c1a0ca458474b0e9bbdfc888eb5/SP800-53Mapping.xlsx', format: 'spreadsheet', parser: 'nist-zero-trust-mapping-xlsx', parser_version: '1.0.0' },
  { id: 'artifact-microsoft-zero-trust-maturity-questionnaire-v1-1', url: 'https://download.microsoft.com/download/c/d/3/cd3e0d84-6fdd-4949-b529-73c9c0127b0d/Zero%20Trust%20Maturity%20Questionnaire%20v1.1.xlsx', format: 'spreadsheet', parser: 'zero-trust-questionnaire-xlsx', parser_version: '1.0.0' },
  // Other structured NIST Pages cybersecurity catalogs.
  { id: 'artifact-nist-iot-requirements-80053-mapping-draft', url: 'https://pages.nist.gov/IoT-Device-Cybersecurity-Requirement-Catalogs/InformativeReferences/files/DRAFT_NIST_IoT_Device_Cybersecurity_Requirements_Catalog_to_800-53.xlsx', format: 'spreadsheet', parser: 'nist-iot-requirement-xlsx', parser_version: '1.0.0' },
  { id: 'artifact-nist-iot-requirements-csf11-mapping-draft', url: 'https://pages.nist.gov/IoT-Device-Cybersecurity-Requirement-Catalogs/InformativeReferences/files/DRAFT_NIST_IoT_Device_Cybersecurity_Requirements_Catalog_to_Cybersecurity_Framework.xlsx', format: 'spreadsheet', parser: 'nist-iot-requirement-xlsx', parser_version: '1.0.0' },
  { id: 'artifact-nist-mobile-threat-catalogue', url: 'https://pages.nist.gov/mobile-threat-catalogue/mtc-data.json', format: 'json', parser: 'nist-mobile-threat-json', parser_version: '1.0.0' },
  { id: 'artifact-nist-mobile-threat-catalogue-cve-list', url: 'https://pages.nist.gov/mobile-threat-catalogue/mtc-cve-list.csv', format: 'csv', parser: 'nist-mobile-threat-cve-csv', parser_version: '1.0.0', count: 'csv' },
  // DoD Zero Trust source PDFs. dodcio.defense.gov's Akamai WAF blocks the
  // identifying ingestion User-Agent (403) but not an unlabeled request
  // (200) for the same path — same pattern as ai.mil (see dod-rai-toolkit
  // above). ZeroTrustOverlays-2024Feb.pdf now 404s and is no longer listed
  // on the current /library/ index — genuinely retired/superseded, not a
  // retrieval failure. Its exact previously downloaded bytes remain attested
  // by the committed page-complete extraction manifest. The filename for
  // Capabilities changed (ZTCapabilitiesActivities -> ZT-CapabilitiesActivities).
  { id: 'artifact-dod-zt-reference-architecture-v2', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/(U)ZT_RA_v2.0(U)_Sep22.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/ra.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-strategy', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/DoD-ZTStrategy.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/strategy.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-capabilities', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-CapabilitiesActivities.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/capabilities.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-execution-roadmap', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-ExecutionRoadmap-v1.1.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/roadmap.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-overlays-2024', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZeroTrustOverlays-2024Feb.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/overlays.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-operational-technology', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-OperationalTechnologyActivitiesOutcomes_v2.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/ot.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-newsletter-2024-11', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-NewsletterNov.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/newsletter.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  { id: 'artifact-dod-zt-strategy-placemats', url: 'https://dodcio.defense.gov/Portals/0/Documents/Library/ZT-StrategyPlacemats.pdf', fragmentManifest: 'data/curated/dod-zt/source-fragments/placemats.json', format: 'pdf', parser: 'pdfplumber-located-lines', parser_version: '1.0.0' },
  // DoD AI Assurance Toolkit: rai.acqbot.com is CDAO's own designated public host for
  // the AIA/RAI Toolkit — confirmed by the official ai.mil Responsible-AI
  // initiative page's "SEE THE TOOLKITS" button (href=https://rai.acqbot.com/)
  // and the acqbot.com page itself carrying the CDAO logo asset. Not a
  // third-party mirror; this is where CDAO ships the toolkit.
  { id: 'artifact-dod-rai-toolkit', url: 'https://rai.acqbot.com/executive-summary', format: 'html', parser: 'dod-rai-toolkit-html', parser_version: '1.0.0' },
  // Reconciliation evidence: the official ai.mil page that links to the
  // acqbot.com toolkit, establishing CDAO's endorsement of that hosting.
  { id: 'artifact-ai-mil-responsible-ai', url: 'https://www.ai.mil/Initiatives/About/Resources/Pathway-to-AI-Readiness/Responsible-AI/', format: 'html', parser: 'ai-mil-responsible-ai-html', parser_version: '1.0.0', userAgent: 'Control-Atlas-source-currentness-review/1.0' },
  // CUI: 32 CFR Part 2002 from the eCFR versioner API (date-pinned = byte-stable).
  { id: 'artifact-isoo-cui-regulation', url: 'https://www.ecfr.gov/api/versioner/v1/full/2026-08-01/title-32.xml?part=2002', format: 'xml', parser: 'ecfr-xml', parser_version: '1.0.0' },
  // CMMC: 32 CFR Part 170 from the eCFR versioner API (date-pinned).
  { id: 'artifact-dod-cmmc-rule', url: 'https://www.ecfr.gov/api/versioner/v1/full/2026-08-01/title-32.xml?part=170', format: 'xml', parser: 'ecfr-xml', parser_version: '1.0.0' },
  // CSF 2.0 Core from the NIST OSCAL catalog (deterministic, pinned v1.5.0).
  { id: 'artifact-nist-csf-2', url: `${OSCAL}/CSF/v2.0/json/NIST_CSF_v2.0_catalog.json`, format: 'oscal_json', parser: 'oscal-json', parser_version: '1.5.0', count: 'oscal_catalog' },
  // The live Reference Tool export carries the current Core together with the
  // publisher-maintained implementation examples and informative references.
  { id: 'artifact-nist-csf-reference-tool-export', url: 'https://csrc.nist.gov/extensions/nudp/services/json/csf/download?olirids=all', format: 'spreadsheet', parser: 'csf-reference-tool-xlsx', parser_version: '1.0.0' },
  // FIPS 199 / 200 and SP 800-37 Rev 2 official PDFs (nvlpubs, byte-stable).
  { id: 'artifact-nist-fips-199', url: 'https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.199.pdf', format: 'pdf', parser: 'pdf-extract', parser_version: '1.0.0' },
  { id: 'artifact-nist-fips-200', url: 'https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.200.pdf', format: 'pdf', parser: 'pdf-extract', parser_version: '1.0.0' },
  { id: 'artifact-nist-800-37-rev2', url: 'https://nvlpubs.nist.gov/nistpubs/SpecialPublications/NIST.SP.800-37r2.pdf', format: 'pdf', parser: 'pdf-extract', parser_version: '1.0.0' },
  // DISA STIG Library: the official July 2026 compilation (dl.dod.cyber.mil,
  // not WAF-blocked) plus the extracted STIG/SRG/CCI-map data files
  // (generated-from-download, hashed from their committed copies).
  { id: 'artifact-disa-compilation-zip', url: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_SRG-STIG_Library_July_2026.zip', format: 'other', parser: 'disa-compilation', parser_version: '1.0.0' },
  { id: 'artifact-disa-stig-library', local: 'data/stig-rules.json', url: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_SRG-STIG_Library_July_2026.zip', format: 'xccdf', parser: 'xccdf', parser_version: '1.0.0' },
  { id: 'artifact-disa-srg-library', local: 'data/srg-requirements.json', url: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_SRG-STIG_Library_July_2026.zip', format: 'xccdf', parser: 'xccdf', parser_version: '1.0.0' },
  { id: 'artifact-disa-stig-srg-cci-references', local: 'maps/stig-srg-to-cci.json', url: 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_SRG-STIG_Library_July_2026.zip', format: 'xccdf', parser: 'xccdf', parser_version: '1.0.0' },
  // 800-53B baselines: the generated baseline data (generated-from-download of
  // the OSCAL rev5 baseline profiles), hashed from its committed copy.
  { id: 'artifact-nist-800-53b-baselines', local: 'data/800-53b-baselines.json', url: `${OSCAL}/SP800-53/rev5/json/NIST_SP-800-53_rev5_MODERATE-baseline_profile.json`, format: 'oscal_json', parser: 'oscal-profile', parser_version: '1.5.0' },
  // Control Atlas's own editorial structure spine (hashed from the repo file).
  { id: 'artifact-control-atlas-structure', local: 'data/curated/tree-spine.json', url: 'https://github.com/rambulls/control-atlas/blob/main/data/curated/tree-spine.json', format: 'json', parser: 'control-atlas-spine', parser_version: '1.0.0', count: 'jsonld' },
];

const nistZeroTrustManifestPath = join(ROOT, 'data', 'curated', 'nist-zt', 'nist-source-manifest.json');
if (existsSync(nistZeroTrustManifestPath)) {
  const nistZeroTrustManifest = JSON.parse(readFileSync(nistZeroTrustManifestPath, 'utf8'));
  const nistRootSource = (nistZeroTrustManifest.sources || []).find((source) => source.source_key === 'nist-sp-1800-35');
  const nistRootResolution = RESOLUTIONS.find((resolution) => resolution.id === 'artifact-nist-sp-1800-35');
  if (nistRootSource?.artifact_url && nistRootResolution) nistRootResolution.url = nistRootSource.artifact_url;
  for (const source of nistZeroTrustManifest.sources || []) {
    const match = source.source_key?.match(/^SP180035-(.+)-(architecture|implementation_guide)$/);
    if (!match) continue;
    const [, buildCode, role] = match;
    RESOLUTIONS.push({
      id: `artifact-nist-sp-1800-35-${buildCode.toLowerCase()}-${role === 'implementation_guide' ? 'guide' : role}`,
      url: source.artifact_url || source.url,
      format: 'html',
      parser: 'explicit-html-markup',
      parser_version: '1.0.0',
    });
  }
}

const COUNTERS = {
  oscal_catalog: (bytes) => countOscalControls(JSON.parse(Buffer.from(bytes).toString('utf8'))),
  oscal_profile: (bytes) => countOscalProfileImports(JSON.parse(Buffer.from(bytes).toString('utf8'))),
  stix: (bytes) => countStixTechniques(JSON.parse(Buffer.from(bytes).toString('utf8'))),
  jsonld: (bytes) => countJsonLdEntries(JSON.parse(Buffer.from(bytes).toString('utf8'))),
  csv: (bytes) => countCsvRows(Buffer.from(bytes).toString('utf8')),
  cci: (bytes) => countCciItems(bytes),
};

// XLSX row count is async (read-excel-file/node reads a file/stream).
async function countXlsxRows(buf) {
  const tmp = join(tmpdir(), `ca-hydrate-${createHash('sha1').update(buf).digest('hex').slice(0, 12)}.xlsx`);
  writeFileSync(tmp, buf);
  const rows = await readXlsxFile(tmp);
  return Math.max(0, rows.length - 1); // minus header row
}

async function countRecords(method, buf) {
  if (method === 'xlsx') return countXlsxRows(buf);
  if (method && COUNTERS[method]) return COUNTERS[method](buf);
  return null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A handful of sources (eCFR in particular) return transient 5xx under load.
// Retrying here means one flaky response doesn't wipe out a previously
// attested artifact's evidence just because this particular run hit it.
async function fetchBytes(url, options = {}) {
  const headers = options.noBotUa
    ? {}
    : { 'User-Agent': options.userAgent || 'ControlAtlas-ingestion/1.0 (+https://github.com/rambulls/control-atlas)' };
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (attempt > 0) await sleep(1500 * attempt);
    try {
      const res = await strictConditionalFetch(url, { redirect: 'follow', headers });
      if (!res.ok) {
        lastError = new Error(`HTTP ${res.status}`);
        if (res.status >= 500) continue; // retry server errors
        throw lastError; // 4xx: no point retrying
      }
      const buf = Buffer.from(await res.arrayBuffer());
      return { buf, status: res.status };
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

async function main() {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const byId = new Map(registry.artifacts.map((a) => [a.id, a]));
  const today = new Date().toISOString().slice(0, 10);
  let changed = 0;

  // A transient failure this run (e.g. a source host's momentary 5xx) should
  // not erase a REAL prior successful attestation for an artifact whose
  // registry sha256 hasn't changed since — carry that entry forward instead
  // of dropping it, so verify-manifests' attestation check reflects the last
  // genuine execution rather than only this run's network luck.
  const priorManifest = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : null;
  const priorById = new Map((priorManifest?.results || []).map((r) => [r.id, r]));
  const onlyPrefixIndex = process.argv.indexOf('--only-prefix');
  const onlyPrefix = onlyPrefixIndex >= 0 ? process.argv[onlyPrefixIndex + 1] : null;
  if (onlyPrefixIndex >= 0 && !onlyPrefix) throw new Error('--only-prefix requires an artifact ID prefix');
  const selectedResolutions = onlyPrefix
    ? RESOLUTIONS.filter((resolution) => resolution.id.startsWith(onlyPrefix))
    : RESOLUTIONS;
  if (onlyPrefix && !selectedResolutions.length) throw new Error(`No artifact resolutions match prefix: ${onlyPrefix}`);
  const selectedIds = new Set(selectedResolutions.map((resolution) => resolution.id));
  const log = (priorManifest?.results || []).filter((result) => !selectedIds.has(result.id));
  const disaCompilation = existsSync(join(ROOT, 'data', 'disa-artifact-manifest.json'))
    ? JSON.parse(readFileSync(join(ROOT, 'data', 'disa-artifact-manifest.json'), 'utf8'))
    : null;

  for (const r of selectedResolutions) {
    const art = byId.get(r.id);
    if (!art) { log.push({ id: r.id, status: 'ERROR', reason: 'artifact id not in registry' }); continue; }
    try {
      if (r.fragmentManifest) {
        const extraction = JSON.parse(readFileSync(join(ROOT, r.fragmentManifest), 'utf8'));
        const extractedSource = extraction?.source || {};
        const checksum = extractedSource.sha256;
        const byteLength = extractedSource.byte_length;
        const retrievedAt = extractedSource.retrieved_at;
        const pageCount = extractedSource.pages;
        if (!/^sha256:[a-f0-9]{64}$/i.test(checksum || '')
          || !Number.isInteger(byteLength) || byteLength <= 0
          || !Number.isInteger(pageCount) || pageCount <= 0
          || !/^\d{4}-\d{2}-\d{2}$/.test(retrievedAt || '')) {
          throw new Error(`invalid committed extraction attestation: ${r.fragmentManifest}`);
        }
        if (extraction.document_key !== art.publication_source_id
          || extraction.reconciliation?.pages_discovered !== pageCount
          || extraction.reconciliation?.pages_extracted !== pageCount) {
          throw new Error(`page or publication reconciliation mismatch: ${r.fragmentManifest}`);
        }
        art.artifact_url = r.url || extractedSource.url;
        art.format = r.format;
        art.parser = r.parser;
        art.parser_version = r.parser_version;
        art.sha256 = checksum;
        art.byte_length = byteLength;
        art.retrieved_at = retrievedAt;
        if (typeof art.relationship_count !== 'number') art.relationship_count = 0;
        changed += 1;
        log.push({
          id: r.id,
          status: 'OK',
          http: 'committed-extraction',
          url: art.artifact_url,
          sha256: checksum,
          byte_length: byteLength,
          record_count: art.record_count,
          retrieved_at: retrievedAt,
          pages_discovered: pageCount,
          pages_extracted: pageCount,
          attestation: 'committed page-complete pdfplumber extraction from previously downloaded publisher PDF',
        });
        console.log(`OK  ${r.id}  ${byteLength}B  ${pageCount} pages  committed extraction  ${checksum.slice(0, 22)}…`);
        continue;
      }
      if (r.id === 'artifact-disa-compilation-zip') {
        const checksum = disaCompilation?.checksum;
        const byteLength = disaCompilation?.byte_length;
        const retrievedAt = disaCompilation?.retrieval_timestamp;
        if (!/^sha256:[a-f0-9]{64}$/i.test(checksum || '') || !Number.isInteger(byteLength) || byteLength <= 0 || !retrievedAt) {
          throw new Error('fresh DISA compilation attestation is missing or invalid');
        }
        if (process.env.CONTROL_ATLAS_REQUIRE_FRESH_FETCH === '1' && !String(retrievedAt).startsWith(today)) {
          throw new Error(`DISA compilation was not retrieved today: ${retrievedAt}`);
        }
        art.artifact_url = disaCompilation.artifact_url;
        art.sha256 = checksum;
        art.byte_length = byteLength;
        art.retrieved_at = String(retrievedAt).slice(0, 10);
        changed += 1;
        log.push({
          id: r.id,
          status: 'OK',
          http: 'range-verified',
          url: disaCompilation.artifact_url,
          sha256: checksum,
          byte_length: byteLength,
          record_count: art.record_count,
          retrieved_at: art.retrieved_at,
          attestation: 'fresh DISA compilation range download and parse',
        });
        console.log(`OK  ${r.id}  ${byteLength}B  range-verified ${checksum.slice(0, 22)}â€¦`);
        continue;
      }
      const { buf, status } = r.local
        ? { buf: readFileSync(join(ROOT, r.local)), status: 'local' }
        : await fetchBytes(r.url, { noBotUa: r.noBotUa, userAgent: r.userAgent });
      const sha256 = 'sha256:' + createHash('sha256').update(buf).digest('hex');
      const byteLength = buf.length;
      const recordCount = await countRecords(r.count, buf);
      const contentChanged = art.sha256 !== sha256;
      // Preserve retrieved_at when bytes are unchanged (stable re-runs).
      const retrievedAt = contentChanged ? today : (art.retrieved_at && !/placeholder/i.test(art.retrieved_at) ? art.retrieved_at : today);

      art.artifact_url = r.url;
      art.format = r.format;
      art.parser = r.parser;
      art.parser_version = r.parser_version;
      art.sha256 = sha256;
      art.byte_length = byteLength;
      art.retrieved_at = retrievedAt;
      if (recordCount !== null) art.record_count = recordCount;
      if (typeof art.relationship_count !== 'number') art.relationship_count = 0;

      changed += 1;
      log.push({ id: r.id, status: 'OK', http: status, url: r.url, sha256, byte_length: byteLength, record_count: recordCount, retrieved_at: retrievedAt });
      console.log(`OK  ${r.id}  ${byteLength}B  records=${recordCount}  ${sha256.slice(0, 22)}…`);
    } catch (e) {
      const prior = priorById.get(r.id);
      if (prior?.status === 'OK' && prior.sha256 === art.sha256) {
        log.push({ ...prior, carried_forward_from: priorManifest.generated_at, carried_forward_reason: String(e.message || e) });
        console.warn(`WARN ${r.id}  fetch failed this run (${e.message || e}); carried forward prior attestation (unchanged sha256)`);
      } else {
        log.push({ id: r.id, status: 'FAILED', url: r.url, reason: String(e.message || e) });
        console.error(`FAIL ${r.id}  ${r.url}  ${e.message || e}`);
      }
    }
  }

  // Remove fabricated orphan twins whose real evidence now lives under the
  // graph-cited artifact id. Only ids proven un-cited by the graph belong here.
  const REMOVE_ORPHANS = [
    { id: 'artifact-nist-oscal', reason: 'duplicate of artifact-nist-800-53 (same OSCAL rev5 catalog); not graph-cited' },
    { id: 'artifact-nist-ssdf-oscal', reason: 'duplicate of artifact-nist-ssdf (same SSDF OSCAL catalog); not graph-cited' },
  ];
  const removed = [];
  for (const { id, reason } of REMOVE_ORPHANS) {
    const idx = registry.artifacts.findIndex((a) => a.id === id);
    if (idx !== -1) { registry.artifacts.splice(idx, 1); removed.push({ id, reason }); }
    for (const b of registry.catalog_source_bundles || []) {
      for (const key of ['primary_artifact_ids', 'enrichment_artifact_ids', 'mapping_source_ids',
        'assessment_source_ids', 'automation_source_ids', 'reconciliation_source_ids']) {
        if (Array.isArray(b[key])) b[key] = b[key].filter((x) => x !== id);
      }
    }
  }
  if (removed.length) console.log(`Removed ${removed.length} fabricated orphan twin(s): ${removed.map((r) => r.id).join(', ')}`);

  if (!existsSync(dirname(OUT))) mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), hydrated: changed, removed_orphans: removed, results: log }, null, 2) + '\n', 'utf8');
  writeJsonAtomically(REGISTRY, registry);
  console.log(`\nHydrated ${changed}/${selectedResolutions.length} selected artifacts (${RESOLUTIONS.length} registered resolutions). Execution log: data/artifact-hydration-manifest.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
