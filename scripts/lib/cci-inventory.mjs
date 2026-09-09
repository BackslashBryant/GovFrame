import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

export function assertCciInventory(xml, records) {
  if (XMLValidator.validate(xml) !== true) throw new Error('Malformed publisher CCI XML');
  const raw = new XMLParser({ ignoreAttributes: false, isArray: (name) => name === 'cci_item' }).parse(xml);
  const items = raw.cci_list?.cci_items?.cci_item;
  if (!Array.isArray(items) || !items.length) throw new Error('Empty publisher CCI inventory');
  const ids = items.map((item) => item['@_id']);
  const imported = records.map((record) => record.id);
  if (ids.some((id) => !/^CCI-\d{6}$/.test(id)) || new Set(ids).size !== ids.length ||
      new Set(imported).size !== imported.length || JSON.stringify([...ids].sort()) !== JSON.stringify([...imported].sort())) {
    throw new Error('Publisher CCI identity reconciliation failed');
  }
  const hash = `sha256:${createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')}`;
  return { raw_count: ids.length, eligible_count: ids.length, imported_count: imported.length,
    excluded: [], raw_identity_sha256: hash, imported_identity_sha256: hash };
}
