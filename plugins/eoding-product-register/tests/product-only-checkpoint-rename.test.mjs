import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { renameReplacing } from '../src/product-only-launcher.mjs';

const failure = code => Object.assign(new Error(`${code}: operation not permitted, rename`), { code });

function flakyRename(codes) {
  const calls = [];
  return { calls, renameImpl: async (from, to) => { calls.push([from, to]); const code = codes.shift(); if (code) throw failure(code); } };
}

test('checkpoint rename retries transient Windows EPERM/EBUSY/EACCES and then replaces the file', async () => {
  const { calls, renameImpl } = flakyRename(['EPERM', 'EBUSY', 'EACCES']);
  const waits = [];
  await renameReplacing('a.tmp', 'checkpoint.json', { renameImpl, platform: 'win32', pause: async ms => { waits.push(ms); } });
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [10, 20, 40]);
});

test('checkpoint rename does not retry outside Windows or for other errors', async () => {
  for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'EXDEV']]) {
    const { calls, renameImpl } = flakyRename([code]);
    await assert.rejects(renameReplacing('a.tmp', 'checkpoint.json', { renameImpl, platform, pause: async () => {} }), { code });
    assert.equal(calls.length, 1, `${platform} ${code}`);
  }
});

test('checkpoint rename gives up after the deadline and surfaces the lock error', async () => {
  const { calls, renameImpl } = flakyRename(Array(1000).fill('EPERM'));
  await assert.rejects(renameReplacing('a.tmp', 'checkpoint.json', { renameImpl, platform: 'win32', timeoutMs: 30, pause: ms => new Promise(resolve => setTimeout(resolve, ms)) }), { code: 'EPERM' });
  assert.ok(calls.length >= 2 && calls.length < 10, `attempts: ${calls.length}`);
});

test('checkpoint rename replaces an existing checkpoint on disk', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'eoding-checkpoint-'));
  try {
    const checkpoint = path.join(directory, 'checkpoint.json'), temporary = checkpoint + '.next.tmp';
    await writeFile(checkpoint, '{"events":1}\n'); await writeFile(temporary, '{"events":2}\n');
    await renameReplacing(temporary, checkpoint);
    assert.equal(await readFile(checkpoint, 'utf8'), '{"events":2}\n');
    await assert.rejects(readFile(temporary), { code: 'ENOENT' });
  } finally { await rm(directory, { recursive: true, force: true }); }
});
