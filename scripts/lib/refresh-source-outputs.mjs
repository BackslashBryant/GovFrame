// Output ownership is explicit: unknown remote tasks cannot run without a
// reviewed snapshot boundary. HTTP caches are not downstream data inputs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadHydrationResolutions } from '../hydrate-artifacts.mjs';
import { repositoryResourceIds } from '../enrich-commons-resources.mjs';

export function loadSourceUnitInventory(root, tasks) {
  const ids = new Set(tasks.map((task) => task.id));
  return {
    hydration: ids.has('hydrate-artifacts') ? loadHydrationResolutions(root) : [],
    resourceIds: ids.has('enrich-commons-resources')
      ? repositoryResourceIds(JSON.parse(readFileSync(join(root, 'data', 'commons-resource-dataset.json'), 'utf8'))) : [],
  };
}
const outputs = {
  'discover-nist-pages': ['data/nist-pages-discovery.json'],
  'discover-nist-structured-assets': ['data/nist-structured-asset-discovery.json'],
  'observe-disa-sources': ['data/stig-source-observations.json'],
  'fetch-fedramp-rules': ['data/fedramp-2026-rules.json', 'data/fedramp-2026-rules.schema.json', 'data/fedramp-transition-index.json', 'data/fedramp-2026-catalog.json'],
  'fetch-nara-cui': ['data/nara-cui-registry-manifest.json', 'data/source-registry.json'],
  'fetch-olir-catalog': ['data/olir-catalog-manifest.json', 'maps/olir'],
  'fetch-olir-mappings': ['maps/800-53-to-csf.json', 'maps/800-53-to-800-171.json', 'maps/800-171-to-csf.json'],
  'fetch-ccis': ['data/ccis.json', 'maps/cci-to-800-53.json', 'data/generated/cci-diff.json'],
  'fetch-disa-library': ['data/stig-rules.json', 'data/srg-requirements.json', 'maps/stig-srg-to-cci.json', 'data/disa-artifact-manifest.json'],
  'fetch-mitre': ['data/attack-techniques-enterprise.json', 'data/attack-techniques-ics.json', 'data/d3fend-countermeasures.json', 'maps/attack-to-d3fend.json', 'maps/d3fend-to-800-53.json', 'data/artifact-hydration-manifest.json'],
  'fetch-zero-trust-workbooks': ['data/curated/nist-zt/mappings.json', 'data/curated/nist-zt/microsoft-questionnaire.json', 'data/curated/nist-zt/structured-source-manifest.json'],
  'fetch-nist-zero-trust': ['data/curated/nist-zt/sp800-207-core.json', 'data/curated/nist-zt/sp800-207a-core.json', 'data/curated/nist-zt/sp1800-35-overview.json', 'data/curated/nist-zt/sp1800-35-builds.json', 'data/curated/nist-zt/nist-source-manifest.json'],
  'fetch-nist-structured-catalogs': ['data/curated/nist-structured-catalogs/iot-requirements.json', 'data/curated/nist-structured-catalogs/mobile-threats.json', 'data/curated/nist-structured-catalogs/source-manifest.json'],
  'hydrate-artifacts': ['data/source-registry.json', 'data/artifact-hydration-manifest.json'],
  'enrich-commons-resources': ['data/commons-resource-dataset.json'],
};

const frameworkOutputs = {
  'nist-800-53-rev5': ['data/controls-800-53.json'],
  'nist-csf-2': ['data/csf-subcategories.json', 'data/csf-reference-tool-manifest.json'],
  'nist-800-171-rev3': ['data/requirements-800-171.json'],
  'nist-800-171-rev2': ['data/requirements-800-171-rev2.json'],
  'nist-800-172-rev3': ['data/requirements-800-172.json'],
  'nist-ai-rmf-playbook': ['data/ai-rmf.json'],
  'nist-ssdf-oscal': ['data/ssdf.json'],
};

const publicCatalogIds = [
  'cmmc-practices', 'fips-199', 'fips-200',
  '800-53b-baselines', 'tasks-800-37', 'dod-rai',
];
const derivedCatalogs = {
  'fetch-nara-cui': ['cui-policy'],
  'fetch-zero-trust-workbooks': ['nist-zt', 'microsoft-zt-maturity'],
  'fetch-nist-zero-trust': ['nist-zt'],
  'fetch-nist-structured-catalogs': ['nist-iot-cybersecurity', 'nist-mobile-threats'],
};

export function sourceUnitsForTask(task, inventory = {}) {
  if (!task.remote_fetch || task.isolation !== 'quarantinable') {
    throw new Error(`Task ${task.id} is not a quarantinable remote task`);
  }
  const base = {
    taskId: task.id, script: task.script, args: task.args || [],
    stages: task.stages, scope: task.scope, retries: task.retries,
    isolation: 'quarantinable',
  };
  if (task.id === 'fetch-framework-catalogs') {
    return [
      ...Object.entries(frameworkOutputs).map(([sourceId, paths]) => ({ ...base, sourceId, paths: [...paths], args: ['--only', sourceId] })),
      { ...base, sourceId: 'fedramp-baselines', paths: ['data/fedramp-baselines.json'], args: ['--public', 'fedramp-baselines'] },
    ];
  }
  if (task.id === 'hydrate-artifacts' || task.id === 'enrich-commons-resources') {
    const hydration = task.id === 'hydrate-artifacts';
    const ids = hydration ? inventory.hydration?.map((entry) => entry.id) : inventory.resourceIds;
    if (!ids?.length || new Set(ids).size !== ids.length) throw new Error(`Missing or duplicate source units for ${task.id}`);
    return ids.map((sourceId) => ({
      ...base, sourceId, paths: [...outputs[task.id]],
      args: hydration ? ['--only', sourceId] : ['--refresh', `--id=${sourceId}`],
    }));
  }
  if (!outputs[task.id]) throw new Error(`Remote task ${task.id} has no declared output ownership`);
  const derived = derivedCatalogs[task.id] || [];
  return [{
    ...base, sourceId: task.id,
    paths: [...outputs[task.id], ...derived.map((id) => `data/${id}.json`)],
    ...(derived.length ? { followUp: { script: 'fetch-framework-catalogs.mjs', args: ['--public', ...derived] } } : {}),
  }];
}

export function localProjectionForTask(task) {
  if (task.id === 'extract-dod-zero-trust') return {
    taskId: task.id, sourceId: 'dod-zero-trust-projection',
    script: 'fetch-framework-catalogs.mjs', args: ['--public', 'dod-zt'],
    paths: ['data/dod-zt.json'], isolation: 'fail_fast', stages: task.stages, scope: task.scope,
  };
  return task.id === 'fetch-framework-catalogs' ? {
    taskId: task.id, sourceId: 'framework-public-projections',
    script: task.script, args: ['--public', ...publicCatalogIds],
    paths: publicCatalogIds.map((id) => `data/${id}.json`),
    isolation: 'fail_fast', stages: task.stages, scope: task.scope,
  } : null;
}
