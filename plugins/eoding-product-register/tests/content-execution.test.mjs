import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveContents, runContents } from '../src/content-execution.mjs';
import { validateContentPlan } from '../src/content-plan.mjs';

const items = count => validateContentPlan(Array.from({ length: count }, (_, i) => ({ type: 'place', key: `place-${i}`, name: `가상 장소 ${i}`, cityLabel: '가상도시(TST)', description: '사용자가 준 가상 설명' })));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function fakeErp(t, { delay = 0, failName } = {}) {
  const records = new Map(), descriptions = new Map(), requests = [];
  let inflight = 0, peak = 0, reads = 0, posts = 0, postGate = null, loseResponse = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(!options.method || options.method === 'GET');
    requests.push(String(url));
    inflight++; peak = Math.max(peak, inflight); reads++;
    try {
      await pause(delay);
      const parsed = new URL(url, 'https://basecamp.team');
      if (parsed.pathname.includes('city_in_country')) return Response.json({ results: [{ id: '7', parent_id: '8', text: '가상도시(TST)' }] });
      if (parsed.pathname.includes('country_in_continent')) return Response.json({ results: [{ id: '8', parent_id: '9', text: '가상국가' }] });
      assert.equal(parsed.pathname, '/contents/place/');
      const name = parsed.searchParams.get('name_ko');
      if (name === failName) throw Error('fixture GET failed');
      return Response.json({ data: records.has(name) ? [{ id: records.get(name), list_name_ko: name, list_city: '가상도시', list_use_flag: 'Y' }] : [] });
    } finally { inflight--; }
  });
  const page = {
    url: () => 'https://basecamp.team/contents/place/',
    evaluate: async (fn, args) => {
      if (args?.contentReadback) {
        const contentId = /\/(\d+)\/change\/$/.exec(args.url)[1];
        const name = [...records].find(([, id]) => id === contentId)?.[0];
        return { names: name ? [name] : [], use: ['True'], descriptions: [descriptions.get(name) ?? '사용자가 준 가상 설명'] };
      }
      if (args && Object.hasOwn(args, 'fields')) {
        posts++;
        if (postGate) await postGate.promise;
        const id = String(800 + records.size);
        records.set(args.fields.name_ko, id);
        descriptions.set(args.fields.name_ko, args.fields.description);
        if (loseResponse) { loseResponse = false; throw Error('fixture lost POST response'); }
        return { status: 201, text: JSON.stringify({ id }) };
      }
      return fn(args);
    }
  };
  return { page, records, descriptions, requests, stats: () => ({ inflight, peak, reads, posts }), gate: value => { postGate = value; }, loseNextResponse: () => { loseResponse = true; } };
}

test('content review resolves each city once and drains bounded read batches before returning or failing', async t => {
  const f = fakeErp(t, { delay: 8 });
  const plan = items(12), resolved = await resolveContents(f.page, plan);
  assert.equal(Object.keys(resolved.regions).length, 1);
  assert.equal(Object.keys(resolved.existing).length, 12);
  assert.deepEqual(f.stats(), { inflight: 0, peak: 4, reads: 14, posts: 0 });
  assert.ok(f.requests.findIndex(url => url.includes('/contents/')) < f.requests.findIndex(url => url.includes('country_in_continent')));
});

test('failed parallel review drains its current batch and never starts later content searches', async t => {
  const f = fakeErp(t, { delay: 8, failName: '가상 장소 0' });
  await assert.rejects(resolveContents(f.page, items(12)), /fixture GET failed/);
  assert.deepEqual(f.stats(), { inflight: 0, peak: 4, reads: 5, posts: 0 });
});

test('ambiguous content attempts are reconciled by search, never repeated when absent or changed', async t => {
  const f = fakeErp(t), plan = items(1);
  const rows = [{ phase: 'content-attempt', key: plan[0].key }];
  const journal = { rows, append: async row => { rows.push(row); } };
  const args = { page: f.page, items: plan, resolved: { regions: {} }, images: [], journal, assertIdentity: async () => {}, companyId: '7' };
  await assert.rejects(runContents(args), /자동 재생성하지 않습니다/);
  assert.equal(f.stats().posts, 0);
  f.records.set(plan[0].name, '811');
  assert.equal((await runContents(args))[0].contentId, '811');
  f.records.set(plan[0].name, '812');
  await assert.rejects(runContents(args), /콘텐츠 번호가 달라졌습니다/);
  assert.equal(f.stats().posts, 0);
});

test('identity is rechecked after the lookup before a content creation POST', async t => {
  const f = fakeErp(t), plan = items(1);
  let checks = 0;
  await assert.rejects(runContents({ page: f.page, items: plan, resolved: { regions: {} }, images: [], journal: { rows: [], append: async () => {} }, companyId: '7', assertIdentity: async () => { if (++checks === 2) throw Error('identity changed'); } }), /identity changed/);
  assert.equal(f.stats().posts, 0);
});

test('review shares identical type/name searches across cities but keeps city-specific duplicate checks', async t => {
  let searches = 0;
  const page = {
    url: () => 'https://basecamp.team/contents/place/',
    evaluate: async (_fn, { url }) => {
      if (url.includes('city_in_country')) {
        const city = new URL(url, 'https://basecamp.team').searchParams.get('q');
        return { results: [{ id: city === '가상동부' ? '7' : '10', parent_id: '8', text: `${city}(TST)` }] };
      }
      if (url.includes('country_in_continent')) return { results: [{ id: '8', parent_id: '9', text: '가상국가' }] };
      searches++;
      return { data: [{ id: '81', list_name_ko: '공통 시설명', list_city: '가상동부', list_use_flag: 'Y' }, { id: '82', list_name_ko: '공통 시설명', list_city: '가상서부', list_use_flag: 'Y' }] };
    }
  };
  const plan = validateContentPlan(['가상동부', '가상서부'].map((city, i) => ({ type: 'place', key: `shared-${i}`, name: '공통 시설명', cityLabel: `${city}(TST)`, description: '사용자 원문' })));
  const resolved = await resolveContents(page, plan);
  assert.equal(searches, 1);
  assert.deepEqual(resolved.existing, { 'shared-0': '81', 'shared-1': '82' });
});

test('a truncated saved description cannot become verified or be rewritten on continuation', async t => {
  const f = fakeErp(t), plan = items(1), rows = [];
  const evaluate = f.page.evaluate;
  f.page.evaluate = async (fn, args) => {
    const result = await evaluate(fn, args);
    if (args?.contentReadback) result.descriptions[0] = result.descriptions[0].slice(0, 3);
    return result;
  };
  const args = { page: f.page, items: plan, resolved: { regions: { '가상도시(TST)': { cityId: '7', countryId: '8', continentId: '9' } } }, images: [], journal: { rows, append: async row => rows.push(row) }, companyId: '7', assertIdentity: async () => {} };
  await assert.rejects(runContents(args), /설명 전체가 일치하지 않습니다/);
  await assert.rejects(runContents(args), /설명 전체가 일치하지 않습니다/);
  assert.equal(f.stats().posts, 1);
  assert.deepEqual(rows.map(row => row.phase), ['content-attempt']);
});

test('rich section text survives one creation and independent full readback with browser newline normalization', async t => {
  const f = fakeErp(t), rows = [];
  const paragraphs = Array.from({ length: 120 }, (_, i) => `원문 ${i + 1}번 관람 안내. 확인된 시설 특징과 이동 방법을 그대로 보존합니다.`).join('\r\n');
  const plan = validateContentPlan([{ type: 'place', key: 'rich', name: '가상 전시장', cityLabel: '가상도시(TST)', descriptionSections: [{ title: '관람 안내', text: paragraphs }] }]);
  let verified = 0;
  const evaluate = f.page.evaluate;
  f.page.evaluate = async (fn, args) => {
    const result = await evaluate(fn, args);
    if (args?.contentReadback) { result.descriptions[0] = result.descriptions[0].replace(/\r\n/g, '\n'); verified++; }
    return result;
  };
  const result = await runContents({ page: f.page, items: plan, resolved: { regions: { '가상도시(TST)': { cityId: '7', countryId: '8', continentId: '9' } } }, images: [], journal: { rows, append: async row => rows.push(row) }, companyId: '7', assertIdentity: async () => {} });
  assert.ok(plan[0].description.length > 3000);
  assert.equal(f.descriptions.get(plan[0].name), plan[0].description);
  assert.equal(verified, 1);
  assert.equal(result[0].created, true);
  assert.equal(f.stats().posts, 1);
});

test('existing approved contents retain their descriptions and missing approved records never create replacements', async t => {
  const f = fakeErp(t), plan = items(1), rows = [];
  f.records.set(plan[0].name, '811');
  f.descriptions.set(plan[0].name, '기존 담당자가 작성한 별도 설명');
  const args = { page: f.page, items: plan, resolved: { existing: { [plan[0].key]: '811' }, regions: {} }, images: [], journal: { rows, append: async row => rows.push(row) }, companyId: '7', assertIdentity: async () => {} };
  assert.equal((await runContents(args))[0].contentId, '811');
  assert.equal(f.descriptions.get(plan[0].name), '기존 담당자가 작성한 별도 설명');
  rows.length = 0; f.records.delete(plan[0].name);
  await assert.rejects(runContents(args), /검토한 기존 콘텐츠/);
  assert.equal(f.stats().posts, 0);
});

async function runtimeFixture(t) {
  const { ProductImportPlugin } = await import('../src/plugin-runtime.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'content-background-'));
  const erp = fakeErp(t), gate = deferred();
  const identity = { companyId: '7', identity: { accountName: '가상 담당자', accountKey: 'fixture-account', sessionKey: 'fixture-session' } };
  const runtime = new ProductImportPlugin({ dataDir: root, browser: { ensurePage: async () => erp.page, close: async () => {}, open: async () => ({}) }, identityReader: async () => structuredClone(identity) });
  t.after(async () => { gate.resolve(); await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const job = await runtime.source({ text: '가상 장소 자료', seasonMode: 'excluded' });
  await runtime.contentPrepare({ id: job.id, contents: items(2) });
  const binding = await runtime.contentReview({ id: job.id });
  const args = { id: job.id, companyId: binding.companyId, accountName: binding.accountName, planDigest: binding.planDigest, delegation: { explicitUserRequest: true, userInstruction: '이 가상 콘텐츠를 등록해줘' } };
  return { runtime, erp, gate, args, job };
}

test('content registration returns before slow writes, exposes progress and closes only after independent readback', async t => {
  const { runtime, erp, gate, args, job } = await runtimeFixture(t);
  erp.gate(gate);
  assert.equal((await runtime.contentRegister(args)).status, 'running');
  const active = runtime.contentActive;
  assert.ok(active);
  const live = await runtime.get({ id: job.id, compact: true });
  assert.equal(live.contents.status, 'running');
  assert.equal(live.contents.count, 2);
  assert.equal(live.contents.completedCount, 0);
  await assert.rejects(runtime.lookup({ kind: 'city', query: '가상도시' }), /처리 중/);
  await assert.rejects(runtime.contentRegister(args), /처리 중/);
  let closed = false;
  const closing = runtime.close().then(() => { closed = true; });
  await pause(5); assert.equal(closed, false);
  gate.resolve(); await active.done; await closing;
  const done = await runtime.get({ id: job.id, compact: true });
  assert.equal(done.contents.status, 'completed');
  assert.equal(done.contents.completedCount, 2);
  assert.equal(done.contents.created, 2);
  assert.equal(done.contents.reused, 0);
  assert.deepEqual(done.contents.withoutPhotos, items(2).map(item => item.name));
  assert.equal(erp.stats().posts, 2);
});

test('reviewed image bindings cannot change and interrupted running content remains visibly unresolved', async t => {
  const { runtime, args, job, erp } = await runtimeFixture(t);
  const stored = await runtime.load(job.id);
  stored.images.push({ id: 'image-fixture', sha256: 'a'.repeat(64) });
  await runtime.save(stored);
  await assert.rejects(runtime.contentRegister(args), /검토한 계획과 현재 작업이 다릅니다/);
  stored.images = []; stored.contents.status = 'running'; await runtime.save(stored);
  const state = await runtime.get({ id: job.id, compact: true });
  assert.equal(state.contents.status, 'interrupted-needs-reconciliation');
  assert.match(state.contents.failure.message, /장부와 ERP 저장 상태/);
  assert.equal(erp.stats().posts, 0);
});

test('a lost create response is reported as failed and the next run reconciles instead of duplicating it', async t => {
  const { runtime, args, job, erp } = await runtimeFixture(t);
  erp.loseNextResponse();
  await runtime.contentRegister(args); await runtime.contentActive.done;
  const failed = await runtime.get({ id: job.id, compact: true });
  assert.equal(failed.contents.status, 'failed');
  assert.equal(failed.contents.failure.erpWriteStarted, true);
  assert.match(failed.contents.failure.message, /lost POST response/);
  assert.equal(erp.stats().posts, 1);
  await runtime.contentRegister(args); await runtime.contentActive.done;
  const done = await runtime.get({ id: job.id, compact: true });
  assert.equal(done.contents.status, 'completed');
  assert.equal(done.contents.completedCount, 2);
  assert.equal(erp.stats().posts, 2);
  assert.equal(erp.records.size, 2);
});
