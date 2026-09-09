import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export function buildCciDiffReport(previousCatalog, nextCatalog) {
  const prevIds = new Set((previousCatalog?.records || []).map((item) => item.id));
  const nextIds = new Set((nextCatalog?.records || []).map((item) => item.id));
  const added = [...nextIds].filter((id) => !prevIds.has(id));
  const removed = [...prevIds].filter((id) => !nextIds.has(id));

  return {
    generated_at: new Date().toISOString(),
    previous_version: previousCatalog?.source_version || null,
    next_version: nextCatalog?.source_version || null,
    previous_count: prevIds.size,
    next_count: nextIds.size,
    added_count: added.length,
    removed_count: removed.length,
    added: added.slice(0, 100),
    removed: removed.slice(0, 100),
  };
}

export function writeCciDiffReport(nextCatalog) {
  const path = join(ROOT, 'data', 'ccis.json');
  const output = join(ROOT, 'data', 'generated', 'cci-diff.json');
  if (!existsSync(path)) return null;
  const previous = JSON.parse(readFileSync(path, 'utf8'));
  const report = buildCciDiffReport(previous, nextCatalog);
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}
