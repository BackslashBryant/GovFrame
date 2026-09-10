const ENTERPRISE_SOURCE = 'mitre-attack-enterprise';
const ICS_SOURCE = 'mitre-attack-ics';

function textValue(value) {
  if (value === undefined || value === null) return '';
  const input = typeof value === 'object' && value['#text'] !== undefined ? value['#text'] : value;
  return String(input)
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([a-f0-9]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()])
    .replace(/\s+/g, ' ')
    .trim();
}

function externalId(object, sourceName) {
  const namespaces = Array.isArray(sourceName) ? sourceName : [sourceName];
  const references = object.external_references || [];
  if (!Array.isArray(references)) throw new Error(`Invalid publisher references: ${object.id}`);
  const ids = new Set(references.filter((entry) => namespaces.includes(entry?.source_name)).map((entry) => {
    if (typeof entry.external_id !== 'string' || !entry.external_id.trim()) throw new Error(`Missing publisher identity: ${object.id}`);
    return entry.external_id;
  }));
  if (ids.size > 1) throw new Error(`Ambiguous publisher ATT&CK identity: ${object.id}`);
  return [...ids][0] || null;
}

function tacticNames(object) {
  return (object.kill_chain_phases || [])
    .map((phase) => phase.phase_name)
    .filter(Boolean);
}

function platformNames(object) {
  return (object.x_mitre_platforms || []).filter(Boolean);
}

/**
 * Build a lookup of ATT&CK tactic shortname (the slug used in
 * kill_chain_phases[].phase_name, e.g. "credential-access") to its official
 * display name and TA-code, from the STIX bundle's `x-mitre-tactic` objects.
 * The bundle already publishes this; techniques only carry the slug.
 */
export function tacticLookupFromStixBundle(stixDocument, externalSourceName) {
  const lookup = new Map();
  for (const object of stixDocument?.objects || []) {
    if (object.type !== 'x-mitre-tactic') continue;
    const shortname = object.x_mitre_shortname;
    if (!shortname) continue;
    lookup.set(shortname, {
      id: externalId(object, externalSourceName) || shortname,
      title: textValue(object.name) || shortname,
    });
  }
  return lookup;
}

/**
 * Resolve the `(Citation: <key>)` markers MITRE embeds in technique prose.
 *
 * The key is an internal `source_name`, meaningless to a reader and not
 * something anyone can follow, but the technique's own `external_references`
 * publish the full citation text and a URL for it. Only keys the description
 * actually cites are kept, so a record carries its own references and nothing
 * more. 2,722 of 2,729 markers in Enterprise v19.2 resolve with a URL; the
 * seven that do not are gaps in MITRE's data and are dropped at render rather
 * than printed as a raw key.
 */
function citationsFor(object, externalSourceName) {
  const namespaces = Array.isArray(externalSourceName) ? externalSourceName : [externalSourceName];
  const description = textValue(object.description);
  if (!description) return {};
  const references = new Map(
    (object.external_references || [])
      .filter((entry) => entry.source_name && !namespaces.includes(entry.source_name))
      .map((entry) => [entry.source_name, entry]),
  );
  const citations = {};
  for (const marker of description.match(/\(Citation:\s*[^)]+\)/g) || []) {
    const key = marker.replace(/^\(Citation:\s*/, '').replace(/\)$/, '').trim();
    if (!key || citations[key]) continue;
    const reference = references.get(key);
    if (!reference) continue;
    const title = textValue(reference.description) || key;
    citations[key] = { title, url: reference.url || '' };
  }
  return citations;
}

function normalizeAttackRecord(object, options) {
  const techniqueId = externalId(object, options.externalSourceName);
  if (!techniqueId) throw new Error(`Missing publisher identity: ${object.id}`);

  const name = textValue(object.name) || techniqueId;
  const description = textValue(object.description);
  const tactics = tacticNames(object);
  const platforms = platformNames(object);
  const tacticMemberships = tactics.map((shortname) => {
    const tactic = options.tacticLookup?.get(shortname);
    return tactic ? { id: tactic.id, title: tactic.title, shortname } : null;
  }).filter(Boolean);
  const primaryTactic = tacticMemberships[0] || null;
  const parentTechniqueId = object.x_mitre_is_subtechnique
    ? techniqueId.split('.')[0]
    : null;

  return {
    id: techniqueId,
    type: 'attack_technique',
    title: `${techniqueId} ${name}`,
    description,
    status: object.revoked ? 'withdrawn' : object.x_mitre_deprecated ? 'deprecated' : 'active',
    family: tactics[0] || '',
    metadata: {
      attack_domain: options.domain,
      tactics,
      tactic_id: primaryTactic?.id || null,
      tactic_title: primaryTactic?.title || null,
      tactic_memberships: tacticMemberships,
      platforms,
      is_subtechnique: Boolean(object.x_mitre_is_subtechnique),
      parent_technique_id: parentTechniqueId,
      citations: citationsFor(object, options.externalSourceName),
      stix_id: object.id,
    },
    source: {
      key: options.sourceKey,
      snapshot_date: options.snapshotDate,
      version: options.version,
      locator: `${options.locatorPrefix}#${techniqueId}`,
    },
  };
}

export function parseAttackStixBundle(stixDocument, options = {}) {
  const objects = stixDocument?.objects || [];
  const tacticLookup = tacticLookupFromStixBundle(
    stixDocument,
    options.externalSourceName,
  );
  const records = [];
  for (const object of objects) {
    if (object.type !== 'attack-pattern') continue;
    const record = normalizeAttackRecord(object, { ...options, tacticLookup });
    if (record) records.push(record);
  }
  records.sort((left, right) => left.id.localeCompare(right.id));
  return records;
}

export function buildAttackCatalogDocument(records, metadata) {
  return {
    schema_version: '2.0',
    source_key: metadata.sourceKey,
    source_artifact: metadata.artifactUrl,
    source_version: metadata.version,
    snapshot_date: metadata.snapshotDate,
    checksum: metadata.checksum,
    checksum_basis: metadata.checksumBasis || 'canonical_json',
    source_artifact_byte_length: metadata.byteLength,
    provenance: metadata.provenance,
    records,
  };
}

export function parseEnterpriseAttackStix(stixDocument, metadata) {
  return buildAttackCatalogDocument(
    parseAttackStixBundle(stixDocument, {
      domain: 'enterprise',
      sourceKey: ENTERPRISE_SOURCE,
      externalSourceName: 'mitre-attack',
      snapshotDate: metadata.snapshotDate,
      version: metadata.version,
      locatorPrefix: metadata.locatorPrefix || 'enterprise-attack.json',
    }),
    {
      ...metadata,
      sourceKey: ENTERPRISE_SOURCE,
      provenance: metadata.provenance || 'MITRE ATT&CK Enterprise STIX bundle',
    },
  );
}

export function parseIcsAttackStix(stixDocument, metadata) {
  return buildAttackCatalogDocument(
    parseAttackStixBundle(stixDocument, {
      domain: 'ics',
      sourceKey: ICS_SOURCE,
      externalSourceName: ['mitre-attack', 'mitre-ics-attack'],
      snapshotDate: metadata.snapshotDate,
      version: metadata.version,
      locatorPrefix: metadata.locatorPrefix || 'ics-attack.json',
    }),
    {
      ...metadata,
      sourceKey: ICS_SOURCE,
      provenance: metadata.provenance || 'MITRE ATT&CK for ICS STIX bundle',
    },
  );
}

export { ENTERPRISE_SOURCE, ICS_SOURCE };
