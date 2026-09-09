import readXlsxFile from 'read-excel-file/node';
import { createHash } from 'node:crypto';

const SUBCATEGORY_ID = /^([A-Z]{2}\.[A-Z]{2}-\d{2}):\s*(.+)$/;

function lines(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function parseCsfReferenceToolRows(rows) {
  if (!Array.isArray(rows) || rows.length < 3) {
    throw new Error('CSF Reference Tool export is missing its Core worksheet rows');
  }
  const header = rows.findIndex((row) => row?.[0] === 'Function' && row?.[2] === 'Subcategory');
  if (header === -1) throw new Error('CSF Reference Tool export is missing the Core column headers');

  const records = new Map();
  for (const row of rows.slice(header + 1)) {
    const subcategoryMatch = String(row?.[2] || '').match(SUBCATEGORY_ID);
    if (!subcategoryMatch) continue;
    const [, id, title] = subcategoryMatch;
    if (records.has(id)) throw new Error(`CSF Reference Tool export repeats subcategory ${id}`);
    records.set(id, {
      title: title.trim(),
      implementation_examples: lines(row?.[3]),
      informative_references: lines(row?.[4]),
    });
  }

  if (records.size < 106) throw new Error(`CSF Reference Tool export contains only ${records.size} subcategories`);
  return { records };
}

export async function parseCsfReferenceToolWorkbook(buffer) {
  const workbook = await readXlsxFile(buffer);
  const core = workbook.find((sheet) => String(sheet.sheet).trim() === 'CSF 2.0');
  if (!core) throw new Error('CSF Reference Tool export is missing the "CSF 2.0" worksheet');
  return parseCsfReferenceToolRows(core.data);
}

export function enrichCsfCatalogFromReferenceTool(records, referenceTool) {
  const sourceIds = new Set(records.map((record) => record.id));
  const missingFromExport = [...sourceIds].filter((id) => !referenceTool.records.has(id));
  const missingFromCatalog = [...referenceTool.records.keys()].filter((id) => !sourceIds.has(id));
  if (sourceIds.size !== records.length) throw new Error('CSF catalog repeats subcategory identifiers');
  if (missingFromCatalog.length) throw new Error(`CSF catalog is missing publisher subcategories: ${missingFromCatalog.join(', ')}.`);
  if (missingFromExport.length) {
    throw new Error(
      `CSF Reference Tool export is missing active OSCAL identifiers: ${missingFromExport.join(', ')}.`,
    );
  }

  const activeFunctions = new Set();
  const activeCategories = new Set();
  let implementationExamples = 0;
  let informativeReferences = 0;
  const enrichedRecords = records.map((record) => {
    const exportRecord = referenceTool.records.get(record.id);
    if (record.description !== exportRecord.title) {
      throw new Error(`CSF Reference Tool and OSCAL title disagree for ${record.id}`);
    }
    activeFunctions.add(record.function_id);
    activeCategories.add(record.category_id);
    implementationExamples += exportRecord.implementation_examples.length;
    informativeReferences += exportRecord.informative_references.length;
    return {
      ...record,
      metadata: {
        ...(record.metadata || {}),
        implementation_examples: exportRecord.implementation_examples,
        informative_references: exportRecord.informative_references,
        primary_artifact_id: 'artifact-nist-csf-reference-tool-export',
        contributing_artifact_ids: ['artifact-nist-csf-2'],
      },
    };
  });
  if (activeFunctions.size !== 6 || activeCategories.size !== 22 || enrichedRecords.length !== 106) {
    throw new Error(
      `Active CSF Reference Tool reconciliation failed: expected 6 Functions, 22 Categories, and 106 Subcategories; got ${activeFunctions.size}, ${activeCategories.size}, and ${enrichedRecords.length}.`,
    );
  }
  return {
    records: enrichedRecords,
    publisher_inventory: {
      raw_count: referenceTool.records.size,
      eligible_count: referenceTool.records.size,
      imported_count: enrichedRecords.length,
      excluded: [],
      raw_identity_sha256: `sha256:${createHash('sha256').update(JSON.stringify([...referenceTool.records.keys()].sort())).digest('hex')}`,
      imported_identity_sha256: `sha256:${createHash('sha256').update(JSON.stringify([...sourceIds].sort())).digest('hex')}`,
    },
    reconciliation: {
      functions: activeFunctions.size,
      categories: activeCategories.size,
      subcategories: referenceTool.records.size,
      implementation_examples: implementationExamples,
      informative_references: informativeReferences,
    },
  };
}
