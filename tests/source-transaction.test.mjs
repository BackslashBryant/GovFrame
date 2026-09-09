import assert from 'node:assert/strict';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync,
  readFileSync, readdirSync, rmdirSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, { after } from 'node:test';
import { runSourceTransaction } from '../scripts/lib/source-transaction.mjs';

const fixtureRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '.local', 'source-transaction-tests');
mkdirSync(fixtureRoot, { recursive: true });
after(() => rmdirSync(fixtureRoot));

function fixture(t) {
  const root = mkdtempSync(join(fixtureRoot, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, bytes) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), bytes);
  };
  const get = (path) => readFileSync(join(root, path));
  const run = (options) => runSourceTransaction({ root, sourceId: 'test-source', ...options });
  const clean = () => assert.deepEqual(readdirSync(join(root, '.local', 'source-transactions')), []);
  return { root, put, get, run, clean };
}

test('quarantine restores bytes, deleted files and modes, and removes new directory contents and ignored raw input', async (t) => {
  const { root, put, get, run, clean } = fixture(t);
  const bytes = Buffer.from([0, 255, 128, 13, 10]);
  put('maps/source/kept.json', bytes);
  put('maps/source/deleted.json', 'last-good');
  chmodSync(join(root, 'maps/source/kept.json'), 0o444);
  const mode = lstatSync(join(root, 'maps/source/kept.json')).mode & 0o777;
  let notified = false;
  const result = await run({
    paths: ['maps/source', 'data/raw.xlsx'],
    operation: () => {
      chmodSync(join(root, 'maps/source/kept.json'), 0o666);
      put('maps/source/kept.json', 'bad');
      rmSync(join(root, 'maps/source/deleted.json'));
      put('maps/source/new.json', 'bad');
      put('data/raw.xlsx', bytes);
      throw new Error('publisher unavailable');
    },
    onQuarantine: () => { assert.deepEqual(get('maps/source/kept.json'), bytes); notified = true; },
  });
  assert.equal(result.status, 'quarantined');
  assert.equal(notified, true);
  assert.deepEqual(get('maps/source/kept.json'), bytes);
  assert.equal(get('maps/source/deleted.json').toString(), 'last-good');
  assert.equal(lstatSync(join(root, 'maps/source/kept.json')).mode & 0o777, mode);
  assert.equal(existsSync(join(root, 'maps/source/new.json')), false);
  assert.equal(existsSync(join(root, 'data/raw.xlsx')), false);
  clean();
});

test('rollback of a later source retains earlier accepted shared registry and existing ignored bytes', async (t) => {
  const { put, get, run, clean } = fixture(t);
  put('data/source-registry.json', 'original');
  put('data/raw.xlsx', Buffer.from([4, 5, 6]));
  assert.equal((await run({ paths: ['data/source-registry.json'], operation: () => put('data/source-registry.json', 'source A accepted') })).status, 'accepted');
  await run({ paths: ['data/source-registry.json', 'data/raw.xlsx'], operation: () => {
    put('data/source-registry.json', 'source B failed');
    put('data/raw.xlsx', 'bad');
    throw new Error('bad B');
  } });
  assert.equal(get('data/source-registry.json').toString(), 'source A accepted');
  assert.deepEqual(get('data/raw.xlsx'), Buffer.from([4, 5, 6]));
  clean();
});

test('retry starts clean and validation runs before acceptance', async (t) => {
  const { put, get, run, clean } = fixture(t);
  put('data/catalog.json', 'good');
  const result = await run({ paths: ['data/catalog.json'], attempts: 2, operation: ({ attempt }) => {
    assert.equal(get('data/catalog.json').toString(), 'good');
    put('data/catalog.json', attempt === 1 ? 'invalid' : 'accepted');
  }, validate: () => {
    if (get('data/catalog.json').toString() !== 'accepted') throw new Error('invalid content');
  } });
  assert.equal(result.status, 'accepted');
  assert.equal(result.attempts, 2);
  assert.equal(get('data/catalog.json').toString(), 'accepted');
  clean();
});

test('final validation failure restores last-good and cleans snapshot', async (t) => {
  const { put, get, run, clean } = fixture(t);
  put('data/catalog.json', 'good');
  const result = await run({ paths: ['data/catalog.json'], operation: () => put('data/catalog.json', 'invalid'), validate: () => false });
  assert.equal(result.status, 'quarantined');
  assert.equal(get('data/catalog.json').toString(), 'good');
  clean();
});

test('a deleted declared directory is restored with its original mode', async (t) => {
  const { root, put, get, run, clean } = fixture(t);
  put('maps/source/file.json', 'good');
  chmodSync(join(root, 'maps/source'), 0o755);
  const mode = lstatSync(join(root, 'maps/source')).mode & 0o777;
  await run({ paths: ['maps/source'], operation: () => {
    rmSync(join(root, 'maps/source'), { recursive: true });
    throw new Error('deleted');
  } });
  assert.equal(get('maps/source/file.json').toString(), 'good');
  assert.equal(lstatSync(join(root, 'maps/source')).mode & 0o777, mode);
  clean();
});

test('invalid, protected and overlapping paths fail before source execution', async (t) => {
  const { root, run } = fixture(t);
  for (const paths of [
    ['../escape'], [join(root, 'absolute')], ['C:\\outside'], ['data/../escape'],
    ['.git/config'], ['.env'], ['data/source-baselines.json'],
    ['data/source-refresh-contract.json'], ['data/source-url-policy.json'],
    ['data/source-refresh-policy.json'], ['data'], ['.local'],
    ['maps/a', 'maps/a/file'], ['maps/a', 'maps/a'],
    ['maps/a', 'maps/a-other', 'maps/a/file'], ['.git./config'],
  ]) {
    await assert.rejects(run({ paths, operation: () => assert.fail('operation must not run') }));
  }
});

test('symlink ancestors and descendants are rejected without touching their target', async (t) => {
  const { root, put, get, run } = fixture(t);
  put('real/file.json', 'protected bytes');
  symlinkSync(join(root, 'real'), join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run({ paths: ['linked/file.json'], operation: () => assert.fail() }), /Symlink/);
  mkdirSync(join(root, 'maps'));
  symlinkSync(join(root, 'real'), join(root, 'maps', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(run({ paths: ['maps'], operation: () => assert.fail() }), /Symlink/);
  assert.equal(get('real/file.json').toString(), 'protected bytes');
});

test('restore infrastructure failure throws without quarantine callback and still removes snapshot', async (t) => {
  const { root, put, run, clean } = fixture(t);
  put('maps/source/file.json', 'good');
  put('real/file.json', 'untouched');
  await assert.rejects(run({ paths: ['maps/source'], operation: () => {
    rmSync(join(root, 'maps/source'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'maps/source'), process.platform === 'win32' ? 'junction' : 'dir');
    throw new Error('source failure');
  }, onQuarantine: () => assert.fail('unsafe restore cannot quarantine') }), /Symlink/);
  clean();
});
