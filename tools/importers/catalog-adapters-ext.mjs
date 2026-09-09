import { normalize80053Id } from '../normalizers/oscal-normalize.mjs';
import readXlsxFile from 'read-excel-file/node';
import { strictConditionalFetch } from '../../scripts/lib/strict-conditional-fetch.mjs';

const FEDRAMP_BASELINE_WORKBOOK_URL = 'https://www.fedramp.gov/legacy/assets/LEGACY%20FedRAMP_Security_Controls_Baseline.xlsx';
const FEDRAMP_BASELINE_SHEETS = {
  LOW: 'Low Baseline',
  MODERATE: 'Moderate Baseline',
  HIGH: 'High Baseline',
  'LI-SAAS': 'LI-SaaS Baseline',
};

function normalizeWorkbookControlId(value) {
  return normalize80053Id(String(value || '').trim().replace(/\s*\((\d+)\)$/, '.$1'));
}

export function parseFedrampBaselineWorkbookSheets(sheets) {
  const byName = new Map(sheets.map((sheet) => [sheet.sheet, sheet.data]));
  return Object.fromEntries(
    Object.entries(FEDRAMP_BASELINE_SHEETS).map(([baseline, sheetName]) => {
      const rows = byName.get(sheetName);
      if (!rows) throw new Error(`FedRAMP baseline workbook is missing sheet: ${sheetName}`);
      const idColumn = baseline === 'LI-SAAS' ? 1 : 2;
      const controls = rows
        .map((row) => normalizeWorkbookControlId(row[idColumn]))
        .filter((id) => /^(AC|AT|AU|CA|CM|CP|IA|IR|MA|MP|PE|PL|PM|PS|PT|RA|SA|SC|SI|SR)-\d+(?:\.\d+)?$/.test(id));
      if (controls.length === 0) throw new Error(`FedRAMP baseline sheet has no control IDs: ${sheetName}`);
      return [baseline, [...new Set(controls)].sort()];
    }),
  );
}

export async function fetchFedrampBaselineMembership() {
  const response = await strictConditionalFetch(FEDRAMP_BASELINE_WORKBOOK_URL);
  if (!response.ok) {
    throw new Error(`FedRAMP baseline fetch returned status ${response.status} for ${FEDRAMP_BASELINE_WORKBOOK_URL}`);
  }
  const workbook = Buffer.from(await response.arrayBuffer());
  const sheets = await readXlsxFile(workbook, { getSheets: true });
  return parseFedrampBaselineWorkbookSheets(sheets);
}

export async function fetch80053BBaselines(fetchImpl = strictConditionalFetch) {
  const urls = [
    'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_LOW-baseline_profile.json',
    'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_MODERATE-baseline_profile.json',
    'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_HIGH-baseline_profile.json',
    'https://raw.githubusercontent.com/usnistgov/oscal-content/main/nist.gov/SP800-53/rev5/json/NIST_SP-800-53_rev5_PRIVACY-baseline_profile.json',
  ];
  const membership = {};
  for (const url of urls) {
    const response = await fetchImpl(url);
    if (!response.ok) throw new Error(`NIST 800-53B baseline fetch returned status ${response.status} for ${url}`);
    const profile = await response.json();
    const label = profile.profile?.metadata?.title || url.split('/').pop();
    if (Object.hasOwn(membership, label)) throw new Error(`Duplicate NIST 800-53B baseline label: ${label}`);
    const imports = profile.profile?.imports;
    if (!Array.isArray(imports) || !imports.length) throw new Error(`NIST 800-53B profile has no imports: ${url}`);
    const controls = new Set();
    for (const importEntry of imports) {
      const includes = importEntry?.['include-controls'];
      if (!Array.isArray(includes) || !includes.length) throw new Error(`NIST 800-53B profile requires explicit include-controls: ${url}`);
      for (const include of includes) {
        const ids = include?.['with-ids'];
        if (!Array.isArray(ids) || !ids.length || ids.some((id) => typeof id !== 'string' || !id.trim())) {
          throw new Error(`NIST 800-53B profile requires explicit control identities: ${url}`);
        }
        for (const id of ids) controls.add(normalize80053Id(id));
      }
    }
    membership[label] = [...controls].sort();
  }
  return membership;
}

export function enrichCatalogMetadata(records, enrichment = {}) {
  return records.map((record) => ({
    ...record,
    metadata: {
      ...(record.metadata || {}),
      ...enrichment[record.id],
    },
  }));
}
