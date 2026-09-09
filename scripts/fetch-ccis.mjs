#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strFromU8, unzipSync } from 'fflate';
import { parseCciXml } from '../tools/importers/cci-adapter.mjs';
import { writeCciDiffReport } from '../tools/importers/cci-diff-report.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { assertCciInventory } from './lib/cci-inventory.mjs';

const CCI_URL = 'https://dl.dod.cyber.mil/wp-content/uploads/stigs/zip/U_CCI_List.zip';

function checksum(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

async function fetchOfficialXml() {
  const response = await strictConditionalFetch(CCI_URL);
  if (!response.ok) throw new Error(`CCI download failed: ${response.status} ${response.statusText}`);
  const buffer = new Uint8Array(await response.arrayBuffer());
  const archive = unzipSync(buffer);
  if (!archive['U_CCI_List.xml']) throw new Error('CCI archive did not contain U_CCI_List.xml');
  const xml = strFromU8(archive['U_CCI_List.xml']);
  return { xml, archiveChecksum: checksum(buffer), archiveByteLength: buffer.length };
}

export async function fetchCcis(options = {}) {
  const { xml, archiveChecksum, archiveByteLength } = options.xml
    ? { xml: options.xml, archiveChecksum: checksum(options.xml) }
    : await fetchOfficialXml();
  const parsed = parseCciXml(xml);
  const sourceChecksum = archiveChecksum;
  const records = parsed.records.map((record) => ({
    ...record,
    source: { ...record.source, checksum: sourceChecksum },
  }));

  const catalog = {
    schema_version: '2.0',
    source_key: 'disa-cci-list',
    source_artifact: CCI_URL,
    source_version: parsed.version,
    snapshot_date: parsed.publish_date,
    checksum: sourceChecksum,
    publisher_inventory: {
      ...assertCciInventory(xml, records), publisher_version: parsed.version,
      source_sha256: archiveByteLength ? archiveChecksum : null,
      source_byte_length: archiveByteLength || null,
      ...(!archiveByteLength ? { source_evidence_reason: 'Injected XML has no downloaded archive attestation' } : {}),
    },
    records,
  };

  const mappings = {
    schema_version: '2.0',
    source_key: 'disa-cci-nist-references',
    source_artifact: CCI_URL,
    source_version: parsed.version,
    snapshot_date: parsed.publish_date,
    checksum: sourceChecksum,
    provenance: 'Official DISA CCI List NIST SP 800-53 Revision 5 references',
    relationships: parsed.relationships,
  };

  if (!parsed.version || !parsed.publish_date) {
    throw new Error('CCI XML missing version or publish date metadata');
  }

  return { catalog, mappings };
}

async function main() {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const result = await fetchCcis();
  writeJsonAtomically(join(root, 'data', 'ccis.json'), result.catalog);
  writeJsonAtomically(join(root, 'maps', 'cci-to-800-53.json'), result.mappings);
  const diff = writeCciDiffReport(result.catalog);
  console.log(`Wrote ${result.catalog.records.length} official CCI records and ${result.mappings.relationships.length} CCI-to-control references`);
  if (diff) {
    console.log(`CCI diff: +${diff.added_count} / -${diff.removed_count}`);
  }
}

if (process.argv[1]?.includes('fetch-ccis.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
