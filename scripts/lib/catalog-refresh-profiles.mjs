// Catalog output ownership is explicit; unknown files cannot acquire a baseline.
export const CATALOG_REFRESH_PROFILES = Object.freeze({
  'cmmc-2': 'cmmc-practices', 'csf-2': 'csf-subcategories', 'cui-policy': 'cui-policy',
  'disa-cci': 'ccis', 'disa-srg': 'srg-requirements', 'disa-stig': 'stig-rules',
  'dod-rai': 'dod-rai', 'dod-zt': 'dod-zt', 'fedramp-rev5': 'fedramp-baselines',
  'fedramp-2026': 'fedramp-2026-catalog', 'fips-199': 'fips-199', 'fips-200': 'fips-200',
  'microsoft-zt-maturity': 'microsoft-zt-maturity', 'mitre-attack': 'attack-techniques-enterprise',
  'mitre-attack-ics': 'attack-techniques-ics', 'mitre-d3fend': 'd3fend-countermeasures',
  'nist-800-171': 'requirements-800-171', 'nist-800-171-rev2': 'requirements-800-171-rev2',
  'nist-800-172': 'requirements-800-172', 'nist-800-37': 'tasks-800-37',
  'nist-800-53': 'controls-800-53', 'nist-800-53b': '800-53b-baselines',
  'nist-ai-rmf': 'ai-rmf', 'nist-iot-cybersecurity': 'nist-iot-cybersecurity',
  'nist-mobile-threats': 'nist-mobile-threats', 'nist-ssdf': 'ssdf', 'nist-zt': 'nist-zt',
});

export const INDEPENDENT_REFRESH_CATALOGS = new Set([
  'disa-cci',
  'csf-2', 'fedramp-2026', 'mitre-attack', 'mitre-attack-ics', 'mitre-d3fend',
  'nist-800-171', 'nist-800-171-rev2', 'nist-800-172', 'nist-800-53', 'nist-ai-rmf', 'nist-ssdf',
]);

export const catalogPath = (id) => {
  if (!Object.hasOwn(CATALOG_REFRESH_PROFILES, id)) throw new Error(`Unknown refresh catalog: ${id}`);
  return `data/${CATALOG_REFRESH_PROFILES[id]}.json`;
};
