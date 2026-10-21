import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProductImportPlugin } from '../src/plugin-runtime.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-token-efficiency-'));
  const runtime = new ProductImportPlugin({
    dataDir: root, browser: { close: async () => {} },
    readers: { readSource: async () => ({ text: 'Original source menu', untrusted: true }) }
  });
  t.after(async () => { runtime.active = null; runtime.fitActive = null; runtime.dayContentsActive = null; await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: 'Source evidence. '.repeat(1000), seasonMode: 'excluded' });
  return { runtime, job };
}

test('revision polling ignores elapsed time but delivers changed phase, failure and verified final result', async t => {
  const { runtime, job } = await fixture(t);
  const writes = [{ kind: 'approval-claim', at: Date.now() }];
  runtime.active = { id: job.id, launcher: { writes } };
  const first = await runtime.get({ id: job.id, compact: true });
  await new Promise(resolve => setTimeout(resolve, 15));
  const second = await runtime.get({ id: job.id, compact: true });
  assert.equal(first.revision, second.revision);
  assert.notEqual(first.timing.elapsedMs, second.timing.elapsedMs);
  const unchanged = await runtime.get({ id: job.id, compact: true, afterRevision: first.revision });
  assert.deepEqual(unchanged, { id: job.id, status: 'running', revision: first.revision, unchanged: true, retryAfterMs: 30000 });
  const before = JSON.stringify(first, null, 2).length, after = JSON.stringify(unchanged).length;
  assert.ok(after < before / 4);
  process.stdout.write(JSON.stringify({ benchmark: 'unchanged-running-progress-characters', before, after, reductionPercent: Math.round((1 - after / before) * 100) }) + '\n');
  writes.push({ kind: 'coordinator-evidence', value: { phase: 'day:1', status: 'before-write' } });
  const changed = await runtime.get({ id: job.id, compact: true, afterRevision: first.revision, waitMs: 30000 });
  assert.notEqual(changed.revision, first.revision);
  assert.equal(changed.progress.currentPhase, 'day:1');
  assert.equal(changed.unchanged, undefined);
  runtime.active = null;
  const stored = await runtime.load(job.id);
  stored.status = 'failed'; stored.failure = { erpWriteStarted: true, retryable: false, message: 'Unknown write outcome; reconcile first.' };
  await runtime.save(stored);
  const failed = await runtime.get({ id: job.id, compact: true, afterRevision: changed.revision, waitMs: 30000 });
  assert.equal(failed.failure.erpWriteStarted, true);
  stored.status = 'completed'; stored.failure = null;
  stored.result = { finalCheck: 'verified', productUrl: 'https://basecamp.team/tour/master_product/123/change/' };
  await runtime.save(stored);
  const done = await runtime.get({ id: job.id, compact: true, afterRevision: failed.revision, waitMs: 30000 });
  assert.equal(done.result.finalCheck, 'verified');
  assert.equal((await runtime.get({ id: job.id, compact: true, afterRevision: done.revision, waitMs: 30000 })).result.finalCheck, 'verified');
});

test('bounded wait wakes for FIT stage changes and unchanged timeout remains compact', async t => {
  const { runtime, job } = await fixture(t);
  const stored = await runtime.load(job.id);
  stored.fit = { status: 'running', planDigest: 'a'.repeat(64) };
  await runtime.save(stored);
  runtime.fitActive = { id: job.id, stage: 'options', startedAt: Date.now() };
  const first = await runtime.get({ id: job.id, compact: true });
  const waiting = runtime.get({ id: job.id, compact: true, afterRevision: first.revision, waitMs: 1000 });
  const timer = setTimeout(() => { runtime.fitActive.stage = 'sales'; }, 20);
  t.after(() => clearTimeout(timer));
  const changed = await waiting;
  assert.equal(changed.fit.stage, 'sales');
  assert.notEqual(changed.revision, first.revision);
  const unchanged = await runtime.get({ id: job.id, compact: true, afterRevision: changed.revision, waitMs: 15 });
  assert.equal(unchanged.unchanged, true);
  runtime.fitActive.persistenceError = 'Failed to persist final evidence';
  const attention = await runtime.get({ id: job.id, compact: true });
  const repeatedAttention = await runtime.get({ id: job.id, compact: true, afterRevision: attention.revision, waitMs: 30000 });
  assert.equal(repeatedAttention.fit.persistenceError, 'Failed to persist final evidence');
  await assert.rejects(() => runtime.get({ id: job.id, compact: true, waitMs: 1 }), /afterRevision/);
  await assert.rejects(() => runtime.get({ id: job.id, compact: true, afterRevision: changed.revision, waitMs: 30001 }), /30000/);
  await assert.rejects(() => runtime.get({ id: job.id, afterRevision: changed.revision }), /compact/);
});

test('an unchanged child workflow never reports the completed parent as overall completion', async t => {
  const { runtime, job } = await fixture(t);
  const stored = await runtime.load(job.id);
  stored.status = 'completed'; stored.result = { finalCheck: 'verified' };
  stored.dayContents = { status: 'running', plan: { target: { productId: '123', scheduleId: '456' }, days: [{ day: 1 }] } };
  await runtime.save(stored);
  runtime.dayContentsActive = { id: job.id, stage: 'day:1', rows: [], startedAt: Date.now() };
  const first = await runtime.get({ id: job.id, compact: true });
  assert.equal(first.status, 'completed');
  assert.equal(first.dayContents.status, 'running');
  const unchanged = await runtime.get({ id: job.id, compact: true, afterRevision: first.revision });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.status, 'running');
  assert.deepEqual(unchanged.dayContents, { status: 'running', stage: 'day:1' });
});

test('source acknowledgement preserves all evidence without echoing submitted long text or supplements', async t => {
  const { runtime } = await fixture(t);
  const text = '관광지의 실제 설명과 이용 정보를 담은 원문. '.repeat(2500);
  const acknowledged = await runtime.source({ text, seasonMode: 'excluded', includeSource: false });
  assert.equal(acknowledged.source, undefined);
  const full = await runtime.get({ id: acknowledged.id, includeSource: true });
  assert.equal(full.source.evidence.text, text);
  assert.deepEqual(acknowledged.sourceDescriptor, full.sourceDescriptor);
  const before = JSON.stringify(full, null, 2).length, after = JSON.stringify(acknowledged).length;
  assert.ok(after < before / 20);
  process.stdout.write(JSON.stringify({ benchmark: 'submitted-source-acknowledgement-characters', before, after, reductionPercent: Math.round((1 - after / before) * 100) }) + '\n');
  const original = await runtime.source({ url: 'https://example.com/product/1', seasonMode: 'excluded' });
  const supplement = await runtime.supplement({ id: original.id, url: original.sourceDescriptor.reference, text, sections: ['description'], includeSource: false });
  assert.equal(supplement.source, undefined);
  assert.equal(supplement.sourceQuality.supplementCount, 1);
  const evidence = await runtime.get({ id: original.id, includeSource: true });
  assert.equal(evidence.source.supplements[0].text, text);
  assert.equal(evidence.source.supplements[0].untrusted, true);
  assert.notEqual(supplement.sourceDigest, original.sourceDigest);
});
