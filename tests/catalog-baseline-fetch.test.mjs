import test from 'node:test';
import assert from 'node:assert/strict';
import { fetch80053BBaselines } from '../tools/importers/catalog-adapters-ext.mjs';

const profile = (title) => ({ profile: { metadata: { title }, imports: [{ 'include-controls': [{ 'with-ids': ['ac-1'] }] }] } });
test('baseline enrichment requires all four publisher profiles', async () => {
  let requests = 0;
  const result = await fetch80053BBaselines(async () => new Response(JSON.stringify(profile(`baseline-${requests++}`))));
  assert.equal(requests, 4);
  assert.equal(Object.keys(result).length, 4);
  assert.ok(Object.values(result).every((ids) => ids.length === 1 && ids[0] === 'AC-1'));
});
test('baseline enrichment does not silently publish partial HTTP or parse results', async () => {
  let requests = 0;
  await assert.rejects(fetch80053BBaselines(async () => requests++ ? new Response('', { status: 503 }) : new Response(JSON.stringify(profile('first')))), /503/);
  assert.equal(requests, 2);
  await assert.rejects(fetch80053BBaselines(async () => new Response('{broken')), /JSON|property/i);
});
test('baseline enrichment rejects empty selectors and duplicate labels', async () => {
  await assert.rejects(fetch80053BBaselines(async () => new Response(JSON.stringify({ profile: { imports: [] } }))), /no imports/);
  await assert.rejects(fetch80053BBaselines(async () => new Response(JSON.stringify(profile('same')))), /Duplicate/);
});
