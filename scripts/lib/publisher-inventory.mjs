import { createHash } from 'node:crypto';

function object(value, path) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid publisher object: ${path}`);
  return value;
}
function array(value, path) {
  if (!Array.isArray(value)) throw new Error(`Invalid publisher array: ${path}`);
  return value;
}
function identity(value, path) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing publisher identity: ${path}`);
  return value;
}
function digest(ids) {
  return `sha256:${createHash('sha256').update(JSON.stringify([...ids].sort())).digest('hex')}`;
}
const clean = (value) => Array.isArray(value)
  ? value.map(clean).filter(Boolean).join(' ')
  : String(value || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function csvRows(payload) {
  if (typeof payload !== 'string') throw new Error('Invalid publisher CSV text');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let closed = false;
  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    if (quoted) {
      if (char === '"' && payload[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') { quoted = false; closed = true; }
      else field += char;
    } else if (char === ',' || char === '\n' || char === '\r') {
      row.push(field); field = ''; closed = false;
      if (char !== ',') {
        rows.push(row); row = [];
        if (char === '\r' && payload[index + 1] === '\n') index += 1;
      }
    } else if (char === '"') {
      if (field || closed) throw new Error('Invalid publisher CSV quote');
      quoted = true;
    } else {
      if (closed) throw new Error('Invalid publisher CSV trailing text');
      field += char;
    }
  }
  if (quoted) throw new Error('Invalid publisher CSV unterminated quote');
  if (field || row.length || closed) { row.push(field); rows.push(row); }
  return rows;
}

/** Reconcile a separate traversal of publisher units against projected record IDs. */
export function assertPublisherInventory(format, payload, records, options = {}) {
  const raw = new Set();
  const eligible = new Set();
  const excluded = [];
  const add = (rawId, projectedId, reason) => {
    identity(rawId, format);
    if (raw.has(rawId)) throw new Error(`Duplicate publisher identity: ${rawId}`);
    raw.add(rawId);
    if (reason) { excluded.push({ id: rawId, reason }); return; }
    identity(projectedId, rawId);
    if (eligible.has(projectedId)) throw new Error(`Duplicate eligible identity: ${projectedId}`);
    eligible.add(projectedId);
  };

  const classes = { 'oscal-800-53': ['SP800-53', 'SP800-53-enhancement'], 'oscal-800-171': ['requirement'], 'oscal-800-172': ['security_requirement'] };
  if (classes[format] || format === 'oscal-ssdf') {
    const catalog = object(object(payload, 'payload').catalog, 'catalog');
    const walk = (nodes, path, structural = false) => {
      array(nodes, path).forEach((node, index) => {
        const loc = `${path}[${index}]`;
        object(node, loc);
        if (node.controls !== undefined) array(node.controls, `${loc}.controls`);
        if (node.groups !== undefined) array(node.groups, `${loc}.groups`);
        const leaf = !node.controls?.length && !node.groups?.length;
        const selected = format === 'oscal-ssdf' ? !structural && leaf : classes[format].includes(node.class);
        const id = identity(node.id, loc);
        let projected = id;
        if (format === 'oscal-800-53') projected = id.toUpperCase();
        if (format === 'oscal-ssdf') projected = id.toUpperCase().replace(/-/g, '.');
        if (format === 'oscal-800-171' || format === 'oscal-800-172') {
          const match = id.match(format === 'oscal-800-171' ? /(\d{2})\.(\d{2})\.(\d{2})/ : /(\d{2})\.(\d{2})\.(\d{2})([A-Z]?)/i);
          if (match) projected = `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}${match[4]?.toUpperCase() || ''}`;
        }
        // These catalogs retain withdrawn/deprecated controls; only structural units are excluded.
        add(id, projected, selected ? null : 'structural or non-target OSCAL unit');
        if (node.controls) walk(node.controls, `${loc}.controls`);
        if (node.groups) walk(node.groups, `${loc}.groups`, true);
      });
    };
    if (catalog.groups) walk(catalog.groups, 'catalog.groups', true);
    if (catalog.controls) walk(catalog.controls, 'catalog.controls');
  } else if (format === 'csv-800-171-rev2') {
    const [header, ...rows] = csvRows(payload);
    if (!header) throw new Error('Missing publisher CSV header');
    const columns = header.map((value) => value.trim().toLowerCase());
    const identifierColumn = columns.indexOf('identifier');
    for (const name of ['identifier', 'security requirement', 'family', 'discussion']) {
      if (columns.filter((value) => value === name).length !== 1) throw new Error(`Missing or duplicate publisher CSV column: ${name}`);
    }
    add('csv:header', null, 'publisher column header');
    rows.forEach((row, index) => {
      if (row.every((value) => !value.trim())) { add(`csv:row:${index + 2}`, null, 'blank publisher row'); return; }
      if (row.length !== header.length) throw new Error(`Invalid publisher CSV row width: ${index + 2}`);
      const id = identity(row[identifierColumn], `csv:row:${index + 2}`);
      const match = id.match(/(\d{2})\.(\d{2})\.(\d{2})/);
      add(id, match ? `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}` : id);
    });
  } else if (format === 'd3fend') {
    const graph = array(object(payload, 'ontology')['@graph'], 'ontology.@graph');
    const byId = new Map();
    const techniqueIds = new Set();
    for (const entry of graph) {
      object(entry, 'ontology entry');
      const id = identity(entry['@id'], 'ontology entry.@id');
      if (byId.has(id)) throw new Error(`Duplicate publisher graph identity: ${id}`);
      byId.set(id, entry);
    }
    const tactics = new Set(['Model', 'Harden', 'Detect', 'Isolate', 'Deceive', 'Evict', 'Restore'].map((id) => `d3f:${id}`));
    const reachesTactic = (start) => {
      const pending = [start];
      const visited = new Set();
      while (pending.length) {
        const current = pending.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        if (tactics.has(current)) return true;
        const node = byId.get(current);
        if (!node) continue;
        for (const field of ['d3f:enables', 'rdfs:subClassOf']) {
          if (node[field] === undefined) continue;
          const links = Array.isArray(node[field]) ? node[field] : [node[field]];
          for (const link of links) {
            object(link, `${current}.${field}`);
            // Anonymous OWL restrictions are not tactic identities.
            if (link['@id'] === undefined) continue;
            const target = identity(link['@id'], `${current}.${field}.@id`);
            if (!target.startsWith('_:')) pending.push(target);
          }
        }
      }
      return false;
    };
    for (const [id, entry] of byId) {
      const technique = entry['d3f:d3fend-id'];
      if (technique === undefined || !String(technique).startsWith('D3-')) { add(id, null, 'non-technique ontology unit'); continue; }
      identity(technique, `${id}.d3fend-id`);
      if (techniqueIds.has(technique)) throw new Error(`Duplicate publisher technique identity: ${technique}`);
      techniqueIds.add(technique);
      add(id, technique, reachesTactic(id) ? null : 'no reachable publisher defensive tactic');
    }
  } else if (format === 'ai-rmf') {
    array(payload, 'playbook').forEach((entry, index) => {
      object(entry, `playbook[${index}]`);
      if (!entry.title || !entry.description) {
        add(`playbook[${index}]`, null, 'missing publisher title or description');
      } else {
        const id = identity(clean(entry.title), `playbook[${index}].title`);
        if (!clean(entry.description)) throw new Error(`Empty publisher description: ${id}`);
        add(id, id);
      }
    });
  } else if (format === 'attack-enterprise' || format === 'attack-ics') {
    array(object(payload, 'bundle').objects, 'bundle.objects').forEach((entry, index) => {
      object(entry, `objects[${index}]`);
      const id = identity(entry.id, `objects[${index}].id`);
      if (entry.type !== 'attack-pattern') { add(id, null, 'non-technique STIX object'); return; }
      const refs = array(entry.external_references, `${id}.external_references`);
      // Publisher ICS bundles use both namespaces, including the older
      // mitre-ics-attack identity on T0850 in the official v19.2 bundle.
      const namespaces = format === 'attack-ics' ? ['mitre-attack', 'mitre-ics-attack'] : ['mitre-attack'];
      const ids = new Set(refs.filter((item) => namespaces.includes(object(item, `${id}.reference`).source_name))
        .map((item) => identity(item.external_id, `${id}.${item.source_name} external_id`)));
      if (ids.size > 1) throw new Error(`Ambiguous publisher ATT&CK identity: ${id}`);
      add(id, identity([...ids][0], `${id}.MITRE external_id`));
    });
  } else if (format === 'fedramp-2026') {
    object(payload, 'rules');
    const entries = (value, path) => Object.entries(object(value, path));
    const text = (value, path) => {
      if (value === undefined || value === null) return false;
      if (Array.isArray(value)) return value.map((item) => text(item, path)).some(Boolean);
      if (typeof value !== 'string') throw new Error(`Invalid publisher text: ${path}`);
      return Boolean(value.trim());
    };
    const statements = (unit, path) => {
      const direct = text(unit.statement, `${path}.statement`);
      const variants = unit.varies_by_class === undefined ? [] : entries(unit.varies_by_class, `${path}.varies_by_class`);
      const varied = variants.map(([key, variant]) => text(object(variant, `${path}.${key}`).statement, `${path}.${key}.statement`)).some(Boolean);
      return direct || varied;
    };
    for (const [family, controls] of entries(payload.CTL, 'CTL')) for (const [id, unit] of entries(controls, `CTL.${family}`)) {
      const path = `CTL.${family}.${id}`;
      object(unit, path);
      const guidance = text(unit.guidance, `${path}.guidance`);
      const parameters = unit.parameters === undefined ? [] : array(unit.parameters, `${path}.parameters`);
      for (const parameter of parameters) {
        object(parameter, `${path}.parameter`);
        identity(parameter.parameterId, `${path}.parameterId`);
        if (parameter.value === undefined || parameter.value === null) throw new Error(`Missing publisher parameter value: ${path}`);
      }
      add(path, `CTL-${id}`, guidance || parameters.length ? null : 'no publisher guidance or parameters');
    }
    for (const [id, unit] of entries(object(payload.FRD, 'FRD').data?.all, 'FRD.data.all')) {
      object(unit, `FRD.${id}`);
      if (!text(unit.definition, `FRD.${id}.definition`)) throw new Error(`Missing publisher definition: ${id}`);
      add(`FRD.data.all.${id}`, id);
    }
    for (const [processId, process] of entries(payload.FRR, 'FRR')) for (const [applicability, subsets] of entries(object(process, processId).data, `FRR.${processId}.data`)) for (const [subsetId, rules] of entries(subsets, applicability)) for (const [id, unit] of entries(rules, subsetId)) {
      const path = `FRR.${processId}.data.${applicability}.${subsetId}.${id}`;
      add(path, id, statements(object(unit, path), path) ? null : 'no publisher statement');
    }
    for (const [groupId, group] of entries(payload.KSI, 'KSI')) for (const [id, unit] of entries(object(group, groupId).indicators, `KSI.${groupId}.indicators`)) {
      const path = `KSI.${groupId}.indicators.${id}`;
      add(path, id, statements(object(unit, path), path) ? null : 'no publisher statement');
    }
  } else {
    throw new Error(`Unsupported publisher inventory format: ${format}`);
  }
  if (!eligible.size) throw new Error(`Empty eligible publisher inventory: ${format}`);
  const imported = new Set();
  for (const record of array(records, 'records')) {
    const id = identity(object(record, 'record').id, 'record.id');
    if (imported.has(id)) throw new Error(`Duplicate imported identity: ${id}`);
    imported.add(id);
  }
  const missing = [...eligible].filter((id) => !imported.has(id));
  const unexpected = [...imported].filter((id) => !eligible.has(id));
  if (missing.length || unexpected.length) throw new Error(`Publisher inventory mismatch (${format}): missing ${JSON.stringify(missing.slice(0, 10))}; unexpected ${JSON.stringify(unexpected.slice(0, 10))}`);
  void options;
  return { raw_count: raw.size, eligible_count: eligible.size, imported_count: imported.size, excluded, raw_identity_sha256: digest(raw), imported_identity_sha256: digest(imported) };
}
