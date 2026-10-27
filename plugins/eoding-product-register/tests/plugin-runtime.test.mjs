import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';
import { png } from './fixtures/product-only-page.mjs';

import { normalized, registration } from './fixtures/plugin-plan.mjs';
async function fixture(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-plugin-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const imagePath = path.join(inputDir, 'source.png'); await writeFile(imagePath, png);
  const runtime = new ProductImportPlugin({ dataDir: path.join(root, 'state'), inputDir, browser: { close: async () => {} }, ...extra });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: 'Synthetic product source', seasonMode: 'excluded' });
  return { runtime, job, root, inputDir, imagePath };
}

test('source → byte-bound image → normalized draft produces one reviewable product with no writes', async t => {
  const f = await fixture(t);
  const image = await f.runtime.image({ id: f.job.id, filePath: f.imagePath, alt: 'Source image' });
  const result = await f.runtime.prepare({ id: f.job.id, product: normalized(f.job), registration: registration(image) });
  assert.equal(result.status, 'ready-for-review', JSON.stringify(result.validation));
  assert.equal(result.validation.erpVerified, false);
  assert.equal((await f.runtime.get({ id: f.job.id, includeSource: true })).source.evidence.text, 'Synthetic product source');
  assert.deepEqual(await f.runtime.image({ id: f.job.id, filePath: f.imagePath, alt: 'same bytes' }), image);
});

test('incomplete data returns grouped questions and rejects foreign source/extra write instructions', async t => {
  const f = await fixture(t), product = normalized(f.job);
  const result = await f.runtime.prepare({ id: f.job.id, product, registration: {} });
  assert.equal(result.status, 'needs-input');
  assert.ok(result.validation.questions.length);
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product, registration: { events: [] } }), /registration/);
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product, registration: { display: { fields: { badge1: 'TOP PICK', badge2: '노팁·노쇼핑', badge3: '5성급 호텔' } } } }), /뱃지 3개.*15자/);
  product.sources[0] = { ...product.sources[0], reference: 'unrelated source' };
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product, registration: {} }), /sourceDescriptor/);
});

test('out-of-root image, changed source and a competing host fail before any review', async t => {
  const f = await fixture(t);
  const outside = path.join(f.root, 'outside.png'); await writeFile(outside, png);
  await assert.rejects(() => f.runtime.image({ id: f.job.id, filePath: outside, alt: 'outside' }), /EODING_INPUT_DIR/);
  const second = new ProductImportPlugin({ dataDir: f.runtime.root, inputDir: f.inputDir, browser: { close: async () => {} } });
  await assert.rejects(() => second.source({ text: 'Other', seasonMode: 'excluded' }), /다른 AI/);
  const file = path.join(f.runtime.directory(f.job.id), 'job.json');
  const stored = JSON.parse(await readFile(file, 'utf8')); stored.source.evidence.text = 'changed';
  await writeFile(file, JSON.stringify(stored));
  await assert.rejects(() => f.runtime.get({ id: f.job.id }), /원문이 변경/);
});

test('persisted pending execution is never silently made retryable after restart', async t => {
  const f = await fixture(t);
  const file = path.join(f.runtime.directory(f.job.id), 'job.json');
  const stored = JSON.parse(await readFile(file, 'utf8')); stored.status = 'awaiting-approval';
  await writeFile(file, JSON.stringify(stored));
  assert.equal((await f.runtime.get({ id: f.job.id })).status, 'interrupted-needs-reconciliation');
  await assert.rejects(() => f.runtime.prepare({ id: f.job.id, product: normalized(f.job), registration: {} }), /이미 검토/);
  await assert.rejects(() => f.runtime.review({ id: f.job.id }), /등록 준비/);
});

test('batch images use bounded parallel reads, deduplicate bytes, and do not persist a partial failed batch', async t => {
  let concurrent = 0, peak = 0;
  const f = await fixture(t, { readers: { readImage: async url => {
    concurrent++; peak = Math.max(peak, concurrent); await new Promise(resolve => setTimeout(resolve, 8)); concurrent--;
    if (url.endsWith('/bad')) throw new Error('fixture image failed');
    return { bytes: png, mimeType: 'image/png', sourceUrl: url };
  } } });
  const result = await f.runtime.images({ id: f.job.id, images: Array.from({ length: 9 }, (_, index) => ({ url: `https://example.com/${index}`, alt: `image ${index}` })) });
  assert.equal(peak, 4); assert.equal(result.images.length, 1); assert.equal(result.inputImageIds.length, 9); assert.equal(result.totalImages, 1);
  const second = await f.runtime.source({ text: 'Second source', seasonMode: 'excluded' });
  await assert.rejects(() => f.runtime.images({ id: second.id, images: [{ url: 'https://example.com/good', alt: 'good' }, { url: 'https://example.com/bad', alt: 'bad' }] }), /fixture image failed/);
  assert.equal((await f.runtime.get({ id: second.id })).images.length, 0);
});

test('source supplement retains the original descriptor, binds new evidence, and rejects another URL', async t => {
  const f = await fixture(t, { readers: { readSource: async () => ({ text: '메뉴만 수집', untrusted: true }) } });
  const original = await f.runtime.source({ url: 'https://example.com/product/1', seasonMode: 'excluded' });
  assert.equal(original.sourceQuality.needsBrowserRead, true);
  const next = await f.runtime.supplement({ id: original.id, url: 'https://example.com/product/1', text: '1일차 세부 일정과 식사', sections: ['1일차'] });
  assert.deepEqual(next.sourceDescriptor, original.sourceDescriptor); assert.notEqual(next.sourceDigest, original.sourceDigest);
  assert.equal(next.source.supplements[0].untrusted, true);
  await assert.rejects(() => f.runtime.supplement({ id: original.id, url: 'https://example.com/product/2', text: 'wrong', sections: ['detail'] }), /같은 상품/);
});
