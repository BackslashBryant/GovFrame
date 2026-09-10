import { Readable } from 'node:stream';
import { setTimeout as wait } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { discoverOlirLinks, olirHtmlTables } from './olir-html.mjs';
import { createStrictConditionalFetch, strictConditionalFetch } from '../../scripts/lib/strict-conditional-fetch.mjs';
import { assertOfficialSourceUrl } from '../../scripts/lib/source-url-policy.mjs';

const STRUCTURED_EXTENSIONS = /\.(xlsx|csv|json|xml)$/i;
const TIMEOUT_MS = 20_000;

// NIST delegates artifact hosting to submitters. Grant only the locations from
// the current NIST detail response, within audited public hosting services.
const OLIR_HOSTS = new Set(['github.com', 'raw.githubusercontent.com', 'docs.google.com',
  'www.nerc.com', 'p-sscrm.github.io', 'securecontrolsframework.com',
  'content.securecontrolsframework.com', 'olir.keystonedigitalholdingsgroup.com',
  'drive.google.com', 'aamcyber.com', 'cyberoon.com', 'bxaios.com', 'www.infoblox.com',
  'doi.org', 'zenodo.org', '43828014.hs-sites.com', 'www.gov.uk', 'www.cisecurity.org',
  'cyberriskinstitute.org', 'www.razil.io', 'workforce-builder.herokuapp.com',
  'irp.cdn-website.com']);

export function createRegisteredOlirFetch(registeredUrls, options = {}) {
  const exact = new Set();
  const directories = [];
  const sheets = new Set();
  function admit(input) {
    let url;
    try { url = new URL(input); if (url.hostname === '43828014.hs-sites.com') url.protocol = 'https:'; url.hash = ''; } catch { return false; }
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !OLIR_HOSTS.has(url.hostname)) return false;
    if (/[\\\s]/.test(input) || /%(?:2e|2f|5c|25)/i.test(url.pathname)) return false;
    exact.add(url.href);
    if (url.hostname === 'doi.org' && /^\/10\.5281\/zenodo\.\d+$/.test(url.pathname)) {
      exact.add(`https://zenodo.org/doi${url.pathname}`);
    }
    if (url.hostname === 'content.securecontrolsframework.com') {
      exact.add('https://securecontrolsframework.com/free-content/scf-download');
    }
    if (url.hostname === 'drive.google.com' && url.pathname === '/uc') {
      const id = url.searchParams.get('id');
      if (id && /^[\w-]+$/.test(id)) exact.add(`https://drive.usercontent.google.com/download?id=${id}&export=download`);
    }
    if (url.hostname === 'securecontrolsframework.com' && url.pathname.startsWith('/content/olir/') && !url.search) {
      exact.add(`https://content.securecontrolsframework.com${url.pathname.slice('/content'.length)}`);
    }
    if (url.hostname === 'docs.google.com') {
      const id = url.pathname.match(/^\/spreadsheets\/d\/([^/]+)\//)?.[1];
      if (id) sheets.add(id);
    }
    for (const exported of googleDownloadCandidates(url.href)) exact.add(exported);
    const target = urlForGitHubContents(url.href);
    if (!target) return true;
    exact.add(githubContentsEndpoint(target));
    if (target.directory) directories.push(target);
    else exact.add(`https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${target.path}`);
  }
  for (const input of registeredUrls.filter(Boolean)) admit(input);
  const scoped = createStrictConditionalFetch({ ...options, urlPolicy(input) {
    try { return assertOfficialSourceUrl(input); } catch { /* Check the per-submission grant. */ }
    const raw = String(input);
    const reject = () => { throw new Error('OLIR source URL policy rejected destination outside registered submission'); };
    if (/[\\\s]/.test(raw) || /%(?:2e|2f|5c|25)/i.test(raw.split(/[?#]/)[0])) reject();
    let url;
    try { url = new URL(raw); } catch { reject(); }
    if (url.protocol !== 'https:' || url.username || url.password || url.port) reject();
    if (exact.has(url.href)) return url;
    if (/^doc-[a-z0-9-]+-sheets\.googleusercontent\.com$/.test(url.hostname) &&
        url.pathname.startsWith('/export/') && sheets.has(url.pathname.split('/').at(-1)) &&
        url.search === '?format=xlsx' && !url.hash) return url;
    if (url.hostname === 'raw.githubusercontent.com' && !url.search && !url.hash && STRUCTURED_EXTENSIONS.test(url.pathname)) {
      for (const target of directories) {
        const prefix = `/${target.owner}/${target.repo}/`;
        if (!url.pathname.startsWith(prefix)) continue;
        const [ref, ...parts] = url.pathname.slice(prefix.length).split('/');
        if (target.ref !== 'HEAD' && ref !== target.ref) continue;
        const directory = target.path ? `${target.path}/` : '';
        const path = parts.join('/');
        // Contents discovery is shallow; do not grant other directories.
        if (path.startsWith(directory) && !path.slice(directory.length).includes('/')) return url;
      }
    }
    reject();
  } });
  scoped.admitArtifactLink = admit;
  return scoped;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function urlForGitHubContents(url) {
  const parsed = new URL(url);
  if (parsed.hostname !== 'github.com') return null;
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (parts.length < 2) return null;
  const [owner, repo, mode, ref, ...path] = parts;
  if (!owner || !repo) return null;
  if (mode === 'blob' || mode === 'raw' || mode === 'tree') {
    if (!ref || (!path.length && mode !== 'tree')) return null;
    return { owner, repo, ref, path: path.join('/'), directory: mode === 'tree' };
  }
  if (parts.length !== 2) return null;
  return { owner, repo, ref: 'HEAD', path: '', directory: true };
}

function googleDownloadCandidates(url) {
  const parsed = new URL(url);
  if (!/(^|\.)google\.com$/i.test(parsed.hostname)) return [];
  if (parsed.pathname.includes('/export') || parsed.searchParams.get('export') === 'download') return [];
  const fileId = parsed.pathname.match(/\/d\/([^/]+)/)?.[1]
    || parsed.pathname.match(/\/file\/d\/([^/]+)/)?.[1];
  if (!fileId) return [];
  if (parsed.hostname === 'docs.google.com' && parsed.pathname.includes('/spreadsheets/')) {
    return [`https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`];
  }
  return [`https://drive.google.com/uc?export=download&id=${fileId}`];
}

function isStructured({ url, contentType, bytes }) {
  if (STRUCTURED_EXTENSIONS.test(new URL(url).pathname)) return true;
  if (/spreadsheet|csv|json|xml/i.test(contentType || '')) return true;
  return Buffer.from(bytes).subarray(0, 2).toString('utf8') === 'PK';
}

async function requestBytes(url, fetchImpl) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'Control-Atlas-source-integrity' },
    redirect: 'follow',
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    url,
    final_url: response.url || url,
    status: response.status,
    content_type: response.headers.get('content-type'),
    bytes,
  };
}

async function githubCandidates(url, fetchImpl) {
  const target = urlForGitHubContents(url);
  if (!target) return [];
  const endpoint = githubContentsEndpoint(target);
  const response = await fetchImpl(endpoint, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Control-Atlas-source-integrity' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!response.ok) return [];
  const body = await response.json();
  const entries = Array.isArray(body) ? body : [body];
  return entries
    .filter((entry) => entry.type === 'file' && STRUCTURED_EXTENSIONS.test(entry.name || ''))
    .sort((a, b) => Number(/olir|crosswalk|mapping/i.test(b.name || '')) - Number(/olir|crosswalk|mapping/i.test(a.name || '')) || String(a.name).localeCompare(String(b.name)))
    .map((entry) => entry.download_url || `https://raw.githubusercontent.com/${target.owner}/${target.repo}/${target.ref}/${entry.path}`)
    .filter(Boolean);
}

function githubContentsEndpoint(target) {
  return `https://api.github.com/repos/${target.owner}/${target.repo}/contents/${target.path}${target.ref && target.ref !== 'HEAD' ? `?ref=${encodeURIComponent(target.ref)}` : ''}`;
}

export async function retrieveStructuredOlirArtifact(candidates, options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const attempted = [];
  const queue = [...new Set(candidates.filter(Boolean).map((url) => url.replace(/^http:\/\/43828014\.hs-sites\.com/, 'https://43828014.hs-sites.com')))];
  const visited = new Set();
  const retried = new Set();
  async function retryCandidate(candidate, index) {
    if (retried.has(candidate)) return;
    retried.add(candidate);
    visited.delete(candidate);
    queue.splice(index + 1, 0, candidate);
    // Retries count toward the same 24-candidate ceiling. A partial source
    // transaction can be accepted, so its outer retry cannot heal this failure.
    await (options.wait || wait)(1000);
  }
  for (let index = 0; index < queue.length && index < 24; index += 1) {
    const candidate = queue[index];
    if (visited.has(candidate)) continue;
    visited.add(candidate);
    try {
      const github = await githubCandidates(candidate, fetchImpl);
      if (github.length) {
        queue.splice(index + 1, 0, ...github.filter((url) => !queue.includes(url)));
        attempted.push({ kind: 'GitHub Contents API', url: candidate, status: 200, resolved_urls: github });
        continue;
      }
      const drive = googleDownloadCandidates(candidate);
      if (drive.length) {
        queue.splice(index + 1, 0, ...drive.filter((url) => !queue.includes(url)));
        attempted.push({ kind: 'Google Drive export', url: candidate, status: 200, resolved_urls: drive });
        continue;
      }
      const result = await requestBytes(candidate, fetchImpl);
      attempted.push({ kind: 'artifact download', url: candidate, status: result.status, final_url: result.final_url, content_type: result.content_type, byte_length: result.bytes.length });
      if (result.status === 429 || result.status >= 500) {
        await retryCandidate(candidate, index);
        continue;
      }
      if (result.status >= 200 && result.status < 300 && /html/i.test(result.content_type || '') && result.bytes.subarray(0, 2).toString('utf8') !== 'PK') {
        // A retired, version-specific download may redirect to today's generic
        // download page. Never replace that registered release with another one.
        if (STRUCTURED_EXTENSIONS.test(new URL(candidate).pathname)) {
          const sameArtifactPath = STRUCTURED_EXTENSIONS.test(new URL(result.final_url).pathname);
          attempted.at(-1).availability = sameArtifactPath ? 'unexpected_html_response' : 'artifact_replaced_by_html';
          if (sameArtifactPath) await retryCandidate(candidate, index);
          continue;
        }
        const tables = olirHtmlTables(result.bytes.toString('utf8'), result.final_url, options.focalCatalogId);
        if (tables.length) return { artifact: { url: result.final_url, content_type: result.content_type, bytes: result.bytes, sha256: sha256(result.bytes) }, attempted };
        for (const link of discoverOlirLinks(result.bytes.toString('utf8'), result.final_url, options)) {
          fetchImpl.admitArtifactLink?.(link);
          if (!visited.has(link) && !queue.includes(link)) queue.push(link);
        }
        continue;
      }
      if (result.status >= 200 && result.status < 300 && isStructured({ url: result.final_url, contentType: result.content_type, bytes: result.bytes })) {
        const requested = new URL(candidate);
        const stableUrl = requested.hostname === 'docs.google.com' && requested.pathname.endsWith('/export') ? candidate : result.final_url;
        return { artifact: { url: stableUrl, content_type: result.content_type, bytes: result.bytes, sha256: sha256(result.bytes) }, attempted };
      }
    } catch (error) {
      attempted.push({ kind: 'artifact download', url: candidate, error: error instanceof Error ? error.message : String(error) });
      if (['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error?.code) ||
          error?.name === 'TimeoutError' || /stale cached bytes|timed?\s*out|socket hang up|fetch failed/i.test(error?.message || '')) {
        await retryCandidate(candidate, index);
      }
    }
  }
  return { artifact: null, attempted };
}

export function olirAvailability(retrieval) {
  if (retrieval?.parse_failed) return 'parse_failed';
  if (retrieval?.mapping) return retrieval.mapping.extraction_scope === 'published_html_relationships' ? 'published_html_relationships' : 'structured_artifact';
  const attempts = retrieval?.attempts || [];
  if (attempts.some((attempt) => attempt.availability === 'unexpected_html_response')) return 'unexpected_html_response';
  if (attempts.some((attempt) => attempt.error)) return 'retrieval_failed';
  if (attempts.some((attempt) => [401, 403].includes(attempt.status))) return 'access_restricted';
  if (attempts.some((attempt) => attempt.availability === 'artifact_replaced_by_html')) return 'artifact_replaced_by_html';
  if (attempts.some((attempt) => attempt.status >= 400)) return 'retrieval_failed';
  return 'no_public_mapping_discovered';
}

function textCell(value) {
  return value == null ? '' : String(value).trim();
}

function isRelationshipHeader(row) {
  const headers = row.map((cell) => textCell(cell).replace(/\s+/g, ' ').toLowerCase());
  return headers.some((header) => /^focal(?: document)?[ _](element|id)$/.test(header)) &&
    headers.some((header) => /^reference(?: document)?[ _](element|id)$/.test(header));
}

function relationshipType(raw) {
  const value = raw || 'Concept Crosswalk';
  const lower = value.toLowerCase();
  if (lower.includes('equal') || lower.includes('equivalent')) return 'Set Theory: Equal';
  if (lower.includes('subset')) return 'Set Theory: Subset';
  if (lower.includes('superset')) return 'Set Theory: Superset';
  if (lower.includes('support')) return 'Supportive';
  if (lower.includes('derived')) return 'Derived Relationship Mapping';
  return value;
}

function parseRows(rows, sourceLocator, rowNumbers = []) {
  if (!rows.length) return [];
  const headerRow = rows.findIndex((row) => {
    const headers = row.map((value) => textCell(value).replace(/\s+/g, ' ').toLowerCase());
    return headers.some((header) => header.includes('focal')) && headers.some((header) => header.includes('reference'));
  });
  if (headerRow < 0) throw new Error('focal/reference relationship columns are absent');
  const headers = rows[headerRow].map((value) => textCell(value).replace(/\s+/g, ' ').toLowerCase());
  const focal = headers.findIndex((header) => header.includes('focal'));
  const reference = headers.findIndex((header) => header.includes('reference'));
  const relation = headers.findIndex((header) => /^(relationship|relationship[ _]type)$/.test(header));
  const strength = headers.findIndex((header) => header.includes('strength'));
  const explanation = headers.findIndex((header) => header.includes('explanation'));
  const comment = headers.findIndex((header) => header.includes('comment') || header.includes('rationale'));
  if (focal < 0 || reference < 0) throw new Error('focal/reference relationship columns are absent');
  const seen = new Set();
  return rows.slice(headerRow + 1).flatMap((row, rowIndex) => {
    const focalId = textCell(row[focal]);
    const referenceIds = textCell(row[reference]).split(/[,;\n]/).map((value) => value.trim()).filter(Boolean);
    const raw = textCell(row[relation]);
    const why = textCell(row[comment]);
    return referenceIds.flatMap((referenceId) => {
      const key = `${focalId}\u0000${referenceId}\u0000${raw}`;
      if (!focalId || seen.has(key)) return [];
      seen.add(key);
      return [{ focal_id: focalId, reference_id: referenceId, relationship_type: relationshipType(raw), raw_relationship_type: raw || 'Concept Crosswalk', relationship_strength: textCell(row[strength]) || null, relationship_explanation: textCell(row[explanation]) || null, rationale: why || null, source_locator: `${sourceLocator}#row-${rowNumbers[headerRow + rowIndex + 1] || headerRow + rowIndex + 2}` }];
    });
  });
}

export async function parseOlirStructuredArtifact(artifact, options = {}) {
  if (/html/i.test(artifact.content_type || '') && Buffer.from(artifact.bytes).subarray(0, 2).toString('utf8') !== 'PK') {
    const tables = olirHtmlTables(Buffer.from(artifact.bytes).toString('utf8'), artifact.url, options.focalCatalogId);
    return { parser: 'olir-html', relationships: tables.flatMap((table) => parseRows(table.rows, table.locator, table.rowNumbers)) };
  }
  const extension = new URL(artifact.url).pathname.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  if (extension === 'xlsx' || Buffer.from(artifact.bytes).subarray(0, 2).toString('utf8') === 'PK') {
    const workbook = new ExcelJS.Workbook();
    // Presentation tables and drawings are not relationship data. Some submitted
    // workbooks contain broken table references while their cells remain intact.
    await workbook.xlsx.load(artifact.bytes, { ignoreNodes: ['tableParts', 'drawing', 'dataValidations'] });
    const sheets = workbook.worksheets.map((sheet) => {
      const data = [];
      sheet.eachRow((row, rowNumber) => {
        // Keep blank rows so evidence locators retain publisher row numbers.
        while (data.length < rowNumber - 1) data.push([]);
        data.push(Array.from({ length: row.cellCount }, (_, index) => row.getCell(index + 1).text));
      });
      return { sheet: sheet.name, data };
    });
    const matching = sheets.filter((sheet) => /relationships|olir|mapping|crosswalk/i.test(sheet.sheet) ||
      sheet.data.some(isRelationshipHeader));
    const selected = matching.length ? matching : sheets.slice(0, 1);
    return { parser: 'olir-xlsx', relationships: selected.flatMap((sheet) => parseRows(sheet.data || [], sheet.sheet || 'workbook')) };
  }
  if (extension === 'csv' || /csv/i.test(artifact.content_type || '')) {
    const workbook = new ExcelJS.Workbook();
    const sheet = await workbook.csv.read(Readable.from([Buffer.from(artifact.bytes)]), { map: (value) => value });
    const rows = [];
    sheet.eachRow({ includeEmpty: true }, (row) => rows.push(Array.from({ length: row.cellCount }, (_, index) => row.getCell(index + 1).text)));
    return { parser: 'olir-csv', relationships: parseRows(rows, 'csv') };
  }
  if (extension === 'json' || /json/i.test(artifact.content_type || '')) {
    const body = JSON.parse(Buffer.from(artifact.bytes).toString('utf8'));
    const rows = Array.isArray(body) ? body : body.relationships || body.rows || [];
    if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object' || Array.isArray(rows[0])) throw new Error('JSON does not expose tabular OLIR relationships');
    const headers = Object.keys(rows[0]);
    return { parser: 'olir-json', relationships: parseRows([headers, ...rows.map((row) => headers.map((header) => row[header]))], 'json') };
  }
  throw new Error(`unsupported structured artifact type: ${extension || artifact.content_type || 'unknown'}`);
}
