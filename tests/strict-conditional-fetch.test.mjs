import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createStrictConditionalFetch } from '../scripts/lib/strict-conditional-fetch.mjs';

test('strict refresh gates the initial request and every redirect before network access', async () => {
  const requested = [];
  const fetchSource = createStrictConditionalFetch({
    fetchImpl: async (url, init) => {
      requested.push(url);
      assert.equal(init.redirect, 'manual');
      return new Response('', { status: 302, headers: { location: 'https://attacker.test/bytes' } });
    },
  });
  await assert.rejects(fetchSource('https://attacker.test/'), /source URL policy/);
  assert.equal(requested.length, 0);
  await assert.rejects(fetchSource('https://csrc.nist.gov/source'), /source URL policy/);
  assert.deepEqual(requested, ['https://csrc.nist.gov/source']);
});

test('strict refresh strips Github token and private headers across approved origins', async () => {
  const requests = [];
  const fetchSource = createStrictConditionalFetch({
    fetchImpl: async (url, init) => {
      requests.push({ url, headers: new Headers(init.headers) });
      return requests.length === 1
        ? new Response('', { status: 302, headers: { location: 'https://raw.githubusercontent.com/FedRAMP/rules/main/data.json' } })
        : new Response('bytes');
    },
  });
  await fetchSource('https://api.github.com/repos/FedRAMP/rules', {
    headers: { Authorization: 'Bearer fixture-github-token', Cookie: 'session=fixture', 'X-Api-Key': 'fixture-key', Accept: 'application/json' },
  });
  assert.equal(requests[0].headers.get('authorization'), 'Bearer fixture-github-token');
  for (const name of ['authorization', 'cookie', 'x-api-key']) assert.equal(requests[1].headers.get(name), null);
  assert.equal(requests[1].headers.get('accept'), 'application/json');
});

test('strict refresh rejects unsafe redirect transport and repository destinations', async () => {
  for (const location of [
    'http://csrc.nist.gov/bytes',
    'https://csrc.nist.gov:8443/bytes',
    'https://user:password@csrc.nist.gov/bytes',
    'https://api.github.com/repos/usnistgov/unapproved',
    'https://github.com/usnistgov/oscal-content/settings',
    'https://csrc.nist.gov.attacker.test/bytes',
  ]) {
    let calls = 0;
    const fetchSource = createStrictConditionalFetch({ fetchImpl: async () => {
      calls += 1;
      return new Response('', { status: 302, headers: { location } });
    } });
    await assert.rejects(fetchSource('https://csrc.nist.gov/source'), /source URL policy/);
    assert.equal(calls, 1);
  }
});

test('strict refresh handles relative redirects and rejects loops and excessive chains', async () => {
  const loop = createStrictConditionalFetch({ fetchImpl: async () => new Response('', {
    status: 301, headers: { location: '/source' },
  }) });
  await assert.rejects(loop('https://csrc.nist.gov/source'), /redirect loop/);
  let calls = 0;
  const chain = createStrictConditionalFetch({ maxRedirects: 2, fetchImpl: async () => new Response('', {
    status: 307, headers: { location: `/source-${++calls}` },
  }) });
  await assert.rejects(chain('https://csrc.nist.gov/source'), /redirect limit/);
  assert.equal(calls, 3);
});

test('strict refresh revalidates cached redirects and their final response', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  const requests = [];
  const fixture = await startServer((request, response) => {
    requests.push(request.url);
    if (request.url === '/source') {
      response.writeHead(302, { location: '/final', 'cache-control': 'max-age=0' });
    } else {
      response.writeHead(200, { 'cache-control': 'max-age=0' });
    }
    response.end(request.url === '/final' ? 'publisher bytes' : '');
  });
  try {
    const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });
    for (let i = 0; i < 2; i += 1) {
      assert.equal(await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text(), 'publisher bytes');
    }
    assert.deepEqual(requests, ['/source', '/final', '/source', '/final']);
  } finally {
    await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});

function fixturePolicy(url) {
  const parsed = new URL(url);
  assert.equal(parsed.hostname, '127.0.0.1');
  return parsed;
}

async function startServer(handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/source`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

test('strict refresh revalidates unchanged bytes with ETag instead of downloading them again', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  let requests = 0;
  let transferredBytes = 0;
  let conditionalHeader = '';
  const body = 'publisher bytes';
  const fixture = await startServer((request, response) => {
    requests += 1;
    conditionalHeader = request.headers['if-none-match'] || conditionalHeader;
    if (request.headers['if-none-match'] === '"source-v1"') {
      response.writeHead(304, { etag: '"source-v1"', 'cache-control': 'max-age=0, must-revalidate' });
      response.end();
      return;
    }
    transferredBytes += Buffer.byteLength(body);
    response.writeHead(200, {
      'content-type': 'text/plain',
      'cache-control': 'max-age=0, must-revalidate',
      etag: '"source-v1"',
    });
    response.end(body);
  });

  try {
    const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });
    assert.equal(await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text(), body);
    const revalidated = await fetchSource(fixture.url, { noProxy: '127.0.0.1' });
    assert.equal(await revalidated.text(), body);
    assert.equal(revalidated.headers.get('x-local-cache-status'), 'revalidated');
    assert.equal(requests, 2);
    assert.equal(conditionalHeader, '"source-v1"');
    assert.equal(transferredBytes, Buffer.byteLength(body));
  } finally {
    await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});

test('strict refresh rejects automatic stale-cache fallback when the publisher is unavailable', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  const fixture = await startServer((_request, response) => {
    response.writeHead(200, { 'cache-control': 'max-age=0', etag: '"source-v1"' });
    response.end('publisher bytes');
  });
  const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });

  try {
    await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text();
    await fixture.close();
    await assert.rejects(
      fetchSource(fixture.url, { noProxy: '127.0.0.1' }),
      /strict refresh rejected stale cached bytes/,
    );
  } finally {
    if (fixture.server.listening) await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});

test('strict refresh revalidates with Last-Modified when ETag is unavailable', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  let conditionalHeader = '';
  let transferredBytes = 0;
  const body = 'publisher bytes';
  const modified = 'Wed, 02 Sep 2026 03:00:00 GMT';
  const fixture = await startServer((request, response) => {
    conditionalHeader = request.headers['if-modified-since'] || conditionalHeader;
    if (request.headers['if-modified-since'] === modified) {
      response.writeHead(304, { 'last-modified': modified, 'cache-control': 'max-age=0, must-revalidate' });
      response.end();
      return;
    }
    transferredBytes += Buffer.byteLength(body);
    response.writeHead(200, {
      'content-type': 'text/plain',
      'cache-control': 'max-age=0, must-revalidate',
      'last-modified': modified,
    });
    response.end(body);
  });

  try {
    const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });
    assert.equal(await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text(), body);
    const revalidated = await fetchSource(fixture.url, { noProxy: '127.0.0.1' });
    assert.equal(await revalidated.text(), body);
    assert.equal(revalidated.headers.get('x-local-cache-status'), 'revalidated');
    assert.equal(conditionalHeader, modified);
    assert.equal(transferredBytes, Buffer.byteLength(body));
  } finally {
    await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});

test('strict refresh accepts changed bytes returned with a new validator', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  let version = 1;
  const fixture = await startServer((_request, response) => {
    const body = `publisher bytes v${version}`;
    response.writeHead(200, {
      'content-type': 'text/plain',
      'cache-control': 'max-age=0, must-revalidate',
      etag: `"source-v${version}"`,
    });
    response.end(body);
  });

  try {
    const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });
    assert.equal(await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text(), 'publisher bytes v1');
    version = 2;
    assert.equal(await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text(), 'publisher bytes v2');
  } finally {
    await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});

test('strict refresh makes a fresh request when the publisher provides no validators', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  let requests = 0;
  let conditionalHeaders = 0;
  const fixture = await startServer((request, response) => {
    requests += 1;
    if (request.headers['if-none-match'] || request.headers['if-modified-since']) conditionalHeaders += 1;
    response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    response.end('publisher bytes');
  });

  try {
    const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });
    await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text();
    await (await fetchSource(fixture.url, { noProxy: '127.0.0.1' })).text();
    assert.equal(requests, 2);
    assert.equal(conditionalHeaders, 0);
  } finally {
    await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});

test('strict refresh rejects a bare 304 without cached publisher bytes', async () => {
  const cachePath = mkdtempSync(join(tmpdir(), 'control-atlas-http-cache-'));
  const fixture = await startServer((_request, response) => {
    response.writeHead(304, { etag: '"source-v1"' });
    response.end();
  });

  try {
    const fetchSource = createStrictConditionalFetch({ cachePath, urlPolicy: fixturePolicy });
    await assert.rejects(
      fetchSource(fixture.url, { noProxy: '127.0.0.1' }),
      /304 without reusable cached bytes/,
    );
  } finally {
    await fixture.close();
    rmSync(cachePath, { recursive: true, force: true });
  }
});
