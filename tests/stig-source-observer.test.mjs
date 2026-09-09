import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchStigSourceObservations } from '../scripts/fetch-stig-source-observations.mjs';

import {
  parseCyberMilLanding,
  parseGithubRepoSignals,
  parseStigViewerCatalog,
  parseStigViewerPressRelease,
} from '../tools/importers/stig-source-observer.mjs';

const cyberMilHtml = `
  <html>
    <head><title>SRG and STIG Library Compilations</title></head>
    <body>
      <main>
        <h1>SRG and STIG Library Compilations</h1>
        <p>Official DISA public entrypoint for STIG library compilations.</p>
      </main>
    </body>
  </html>`;

const stigViewerCatalogHtml = `
  <html>
    <head><title>STIGs - STIG Viewer</title></head>
    <body>
      <h1>STIGs</h1>
      <p>Save STIGs to custom lists and access them via API.</p>
      <article>
        <a href="/stigs/microsoft_windows_11">Microsoft Windows 11 Security Technical Implementation Guide</a>
        <span>STIGs608</span>
      </article>
      <article>
        <a href="/stigs/application_server_security_requirements_guide">Application Server Security Requirements Guide</a>
      </article>
    </body>
  </html>`;

const stigViewerPressHtml = `
  <html>
    <head><title>March 16, 2026 STIGViewer Launches Structured STIG Data API</title></head>
    <body>
      <h1>March 16, 2026 STIGViewer Launches Structured STIG Data API</h1>
      <p>The CLKB API delivers all ~500 DISA STIG profiles as structured JSON via REST endpoints.</p>
      <p>When DISA publishes quarterly updates, the API reflects them automatically.</p>
    </body>
  </html>`;

const githubRepoHtml = `
  <html>
    <head>
      <title>NUWCDIVNPT/stig-manager</title>
      <meta name="description" content="An API and client for managing STIG assessments">
    </head>
    <body>
      <article>
        <h1>STIG Manager</h1>
        <p>Combine manual evaluations with imported scan results (XCCDF) and checklists (CKL) in a unified data management interface.</p>
        <p>Intelligent STIG Revision Management: only Rules with changed check content require re-evaluation.</p>
        <p>STIG Manager supports DISA Security Technical Implementation Guides (STIGs) and Security Requirements Guides (SRGs).</p>
      </article>
    </body>
  </html>`;

const cyberMilShellHtml = `
  <!DOCTYPE html>
  <html lang="en-US">
    <head>
      <meta http-equiv="Content-Security-Policy" content="img-src 'self' dl.dod.cyber.mil;">
      <script>globalThis.LWR = globalThis.LWR || {};</script>
      <title>Welcome to LWC Communities!</title>
    </head>
    <body>
      <webruntime-app></webruntime-app>
    </body>
  </html>`;

test('cyber.mil landing parser captures official STIG acquisition entrypoints', () => {
  assert.deepEqual(
    parseCyberMilLanding(cyberMilHtml, 'https://www.cyber.mil/stigs/compilations/'),
    {
      url: 'https://www.cyber.mil/stigs/compilations/',
      title: 'SRG and STIG Library Compilations',
      kind: 'official_entrypoint',
      signals: ['official-disa', 'stigs-entrypoint'],
      summary: 'Official DISA public entrypoint for STIG library compilations.',
    },
  );
});

test('cyber.mil landing parser recognizes Salesforce shell delivery and preserves STIG meaning', () => {
  assert.deepEqual(
    parseCyberMilLanding(cyberMilShellHtml, 'https://www.cyber.mil/stigs/compilations/'),
    {
      url: 'https://www.cyber.mil/stigs/compilations/',
      title: 'SRG and STIG Library Compilations',
      kind: 'official_entrypoint',
      signals: ['official-disa', 'stigs-entrypoint', 'salesforce-lwc-shell', 'static-html-withheld'],
      summary: 'Official DISA STIG entrypoint delivered through a Salesforce LWC shell; direct artifact links are not exposed in static HTML.',
    },
  );
});

test('STIG Viewer catalog parser captures supplemental STIG discovery signals', () => {
  const parsed = parseStigViewerCatalog(stigViewerCatalogHtml, 'https://www.stigviewer.com/stigs');
  assert.equal(parsed.kind, 'supplemental_catalog');
  assert.equal(parsed.exposes_api, true);
  assert.deepEqual(parsed.sample_slugs, [
    'microsoft_windows_11',
    'application_server_security_requirements_guide',
  ]);
});

test('STIG Viewer press release parser captures structured API and update claims', () => {
  assert.deepEqual(
    parseStigViewerPressRelease(stigViewerPressHtml, 'https://www.stigviewer.com/press-releases/2026-03-16'),
    {
      url: 'https://www.stigviewer.com/press-releases/2026-03-16',
      title: 'March 16, 2026 STIGViewer Launches Structured STIG Data API',
      kind: 'supplemental_api_announcement',
      exposes_structured_json: true,
      claims_quarterly_updates: true,
    },
  );
});

test('GitHub repo parser captures STIG Manager import and revision-management signals', () => {
  assert.deepEqual(
    parseGithubRepoSignals(githubRepoHtml, 'https://github.com/nuwcdivnpt/stig-manager'),
    {
      url: 'https://github.com/nuwcdivnpt/stig-manager',
      title: 'NUWCDIVNPT/stig-manager',
      kind: 'supplemental_tooling',
      supports_xccdf: true,
      supports_ckl: true,
      supports_revision_management: true,
      supports_stigs_and_srgs: true,
    },
  );
});

test('scheduled observation requests only the four approved targets and ignores offsite discovery links', async () => {
  const requested = [];
  const document = await fetchStigSourceObservations({
    fetchImpl: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, text: async () => `${cyberMilHtml}<a href="https://attacker.test/catalog">Catalog</a>` };
    },
  });
  assert.deepEqual(requested, [
    'https://www.cyber.mil/stigs/compilations/',
    'https://www.cyber.mil/stigs/downloads',
    'https://www.cyber.mil/stigs/gpo/',
    'https://github.com/nuwcdivnpt/stig-manager',
  ]);
  assert.equal(document.observations.length, 4);
});

test('supplemental source outages are recorded without failing required DISA observations', async () => {
  let request = 0;
  const document = await fetchStigSourceObservations({
    observedAt: '2026-08-27T12:00:00.000Z',
    fetchImpl: async () => {
      request += 1;
      if (request === 4) return { ok: false, status: 403, text: async () => '' };
      return { ok: true, status: 200, text: async () => cyberMilHtml };
    },
  });

  assert.equal(document.observations.length, 4);
  assert.equal(document.observations.slice(0, 3).every((entry) => entry.available), true);
  assert.deepEqual(document.observations[3], {
    source_id: 'nuwcdivnpt-stig-manager',
    observed_at: '2026-08-27T12:00:00.000Z',
    required: false,
    available: false,
    url: 'https://github.com/nuwcdivnpt/stig-manager',
    kind: 'supplemental_unavailable',
    error: 'fetch failed 403 for https://github.com/nuwcdivnpt/stig-manager',
  });
});

test('required DISA source outages still fail closed', async () => {
  await assert.rejects(
    fetchStigSourceObservations({
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => '' }),
    }),
    /required STIG source cyber-mil-stig-compilations failed: fetch failed 503/,
  );
});
