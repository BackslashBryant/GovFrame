import { parse } from 'node-html-parser';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

// Convert published tables to the existing OLIR row contract. Column selection
// is explicit; unrelated inventories and summary counts are never relationships.
export function olirHtmlTables(html, url, focalCatalogId) {
  const doc = parse(html);
  const tables = [];
  for (const [index, table] of doc.querySelectorAll('table').entries()) {
    const rows = table.querySelectorAll('tr').map((row) => row.querySelectorAll('th,td').map((cell) => cell.text.trim()));
    const headerIndex = rows.findIndex((row) => row.some((cell) => /focal document\s+element/i.test(cell)) && row.some((cell) => /reference document\s+element/i.test(cell)));
    if (headerIndex >= 0) {
      const header = rows[headerIndex];
      const focalIndex = header.findIndex((cell) => /focal document\s+element/i.test(cell));
      const referenceIndex = header.findIndex((cell) => /reference document\s+element/i.test(cell));
      if (rows.slice(headerIndex + 1).some((row) => clean(row[focalIndex]) && clean(row[referenceIndex]))) {
        tables.push({ rows: rows.slice(headerIndex), rowNumbers: rows.slice(headerIndex).map((_, index) => headerIndex + index + 1), locator: `table-${index + 1}` });
      }
      continue;
    }
    const headers = (rows[0] || []).map(clean);
    let focal = -1;
    let reference = -1;
    let relation = -1;
    let explanation = -1;
    if (new URL(url).hostname === 'aamcyber.com') {
      reference = headers.findIndex((cell) => /^SDOS Controls?$/.test(cell));
      if (focalCatalogId === 'csf-2') focal = headers.indexOf('CSF 2.0 Subcategory');
      if (focalCatalogId === 'nist-800-53') focal = headers.indexOf('SP 800-53 Control');
      if (focalCatalogId === 'nist-ai-rmf' && headers.includes('AI RMF Function')) focal = headers.indexOf('Subcategory');
      explanation = headers.indexOf('Embodiment');
    }
    if (new URL(url).hostname === 'bxaios.com') {
      focal = headers.indexOf('NIST Focal Element');
      reference = headers.indexOf('BXAI-OS Step');
      relation = headers.indexOf('Relationship');
      explanation = headers.indexOf('Rationale');
    }
    if (focal < 0 || reference < 0) continue;
    const rowNumbers = [1];
    const converted = [['Focal Document Element', 'Reference Document Element', 'Relationship Type', 'Relationship Explanation']];
    for (const [rowIndex, row] of rows.slice(1).entries()) {
      if (row.length !== headers.length) continue;
      const expressions = {
        'csf-2': /\b(?:GV|ID|PR|DE|RS|RC)\.[A-Z]{2}-\d{2}\b/g,
        'nist-800-53': /\b[A-Z]{2}-\d+(?:\(\d+\))?/g,
        'nist-ai-rmf': /\b(?:GOVERN|MAP|MEASURE|MANAGE)[ -]\d+(?:\.\d+)?/g,
      };
      const ids = row[focal]?.match(expressions[focalCatalogId] || /$^/g) || [];
      for (const id of ids) { converted.push([id, row[reference], row[relation] || '', row[explanation] || '']); rowNumbers.push(rowIndex + 2); }
    }
    if (converted.length > 1) tables.push({ rows: converted, rowNumbers, locator: `table-${index + 1}` });
  }
  if (new URL(url).hostname === 'www.gov.uk' && focalCatalogId === 'csf-2') {
    let action = null;
    const rowNumbers = [1];
    const rows = [['Focal Document Element', 'Reference Document Element', 'Comments']];
    for (const [paragraphIndex, paragraph] of doc.querySelectorAll('main p').entries()) {
      const text = clean(paragraph.text);
      const match = text.match(/^Action ([A-Z]\d+):/);
      if (match) action = { id: match[1], text };
      if (action && /^Alignment with NIST CSF:/i.test(text)) {
        for (const id of text.match(/\b(?:GV|ID|PR|DE|RS|RC)\.[A-Z]{2}[.-]\d{2}\b/g) || []) { rows.push([id, action.id, action.text]); rowNumbers.push(paragraphIndex + 1); }
      }
    }
    if (rows.length > 1) tables.push({ rows, rowNumbers, locator: 'published-paragraphs' });
  }
  return tables;
}

export function discoverOlirLinks(html, url, options = {}) {
  const doc = parse(html);
  const links = doc.querySelectorAll('a').map((a) => a.getAttribute('href')).filter(Boolean);
  // Some registered pages print their repository URL without an anchor.
  links.push(...(doc.text.match(/https:\/\/github\.com\/[^\s<>"']+/g) || []));
  if (new URL(url).hostname === 'drive.google.com') {
    for (const row of doc.querySelectorAll('[data-id]')) {
      if (/\.xlsx\b/i.test(row.text) && /^[\w-]+$/.test(row.getAttribute('data-id'))) {
        links.push(`https://drive.google.com/uc?export=download&id=${row.getAttribute('data-id')}`);
      }
    }
  }
  const workforceKey = /SP-800-181/i.test(options.sourceIdentifier || '') ? 'sp800181_to_ssdf_1_0_0'
    : /CSF-v1\.1/i.test(options.sourceIdentifier || '') ? 'csf_1_1_0_to_ssdf_1_0_0' : null;
  return [...new Set(links.map((link) => { try { return new URL(link, url).href; } catch { return null; } }))]
    .filter((link) => link && (/\.(xlsx|csv|json|xml)(?:[?#]|$)/i.test(link) ||
      /^https:\/\/github\.com\//.test(link) || /^https:\/\/drive\.google\.com\/uc\?/.test(link) ||
      (workforceKey && link === `https://workforce-builder.herokuapp.com/get-olir?olir_name=${workforceKey}`)));
}
