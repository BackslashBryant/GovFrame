#!/usr/bin/env node
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './lib/write-json-atomically.mjs';
import { strictConditionalFetch } from './lib/strict-conditional-fetch.mjs';

import {
  parseCyberMilLanding,
  parseGithubRepoSignals,
} from '../tools/importers/stig-source-observer.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_PATH = join(ROOT, 'data', 'stig-source-observations.json');

const TARGETS = [
  {
    id: 'cyber-mil-stig-compilations',
    required: true,
    url: 'https://www.cyber.mil/stigs/compilations/',
    parser: parseCyberMilLanding,
  },
  {
    id: 'cyber-mil-stig-downloads',
    required: true,
    url: 'https://www.cyber.mil/stigs/downloads',
    parser: parseCyberMilLanding,
  },
  {
    id: 'cyber-mil-stig-gpo',
    required: true,
    url: 'https://www.cyber.mil/stigs/gpo/',
    parser: parseCyberMilLanding,
  },
  {
    id: 'nuwcdivnpt-stig-manager',
    required: false,
    url: 'https://github.com/nuwcdivnpt/stig-manager',
    parser: parseGithubRepoSignals,
  },
];

async function fetchHtml(url, fetchImpl) {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`fetch failed ${response.status} for ${url}`);
  }
  return {
    html: await response.text(),
    cacheStatus: response.headers?.get?.('x-local-cache-status') || null,
  };
}

export async function fetchStigSourceObservations(options = {}) {
  const fetchImpl = options.fetchImpl || strictConditionalFetch;
  const observedAt = options.observedAt || new Date().toISOString();
  const observations = [];

  for (const target of TARGETS) {
    try {
      const { html, cacheStatus } = await fetchHtml(target.url, fetchImpl);
      observations.push({
        source_id: target.id,
        observed_at: observedAt,
        required: target.required,
        available: true,
        ...(cacheStatus ? { retrieval_status: cacheStatus } : {}),
        ...target.parser(html, target.url),
      });
    } catch (error) {
      if (target.required) {
        throw new Error(`required STIG source ${target.id} failed: ${error.message}`, { cause: error });
      }
      observations.push({
        source_id: target.id,
        observed_at: observedAt,
        required: false,
        available: false,
        url: target.url,
        kind: 'supplemental_unavailable',
        error: error.message,
      });
    }
  }

  return {
    schema_version: '1.0',
    generated_at: observedAt,
    observations,
  };
}

async function main() {
  const document = await fetchStigSourceObservations();
  writeJsonAtomically(OUTPUT_PATH, document);
  console.log(`Wrote ${document.observations.length} STIG source observations`);
}

if (process.argv[1]?.includes('fetch-stig-source-observations.mjs')) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
