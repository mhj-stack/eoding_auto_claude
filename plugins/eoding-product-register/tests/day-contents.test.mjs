import test from 'node:test';
import assert from 'node:assert/strict';
import { validateDayContentPlan, resolveDayContents, runDayContents, appendPayload, dayContentSummary } from '../src/day-contents.mjs';

const ORIGIN = 'https://basecamp.team';
const row = (id, day, step, type, etc1 = '', description = null) => ({ id, day, step, type_id: type, etc1, etc2: '', etc3: '', etc4: '', etc5: '', etc6: '', description, day_title: '가상 일차', breakfast_type: 16, breakfast_text: '', lunch_type: 16, lunch_text: '', dinner_type: 16, dinner_text: '' });

/** Fixture ERP: one 3-day schedule (custom step 1 + hotel sentinel per day), searchable contents, guarded save. */
function fakeErp(t, { saveStatus = 201, loseResponse = false, mutateOther = false } = {}) {
  const schedule = { id: 98, product: 65, title: '가상 일정표', day: 3, night: 2, code: 'S1', visit_route: null };
  const tree = [1, 2, 3].flatMap(day => [row(100 + day, day, 1, 7, `${day}일차 가상 일정`, '설명'), row(200 + day, day, 999, 2)]);
  const contents = [], places = new Map([['가상 공원', '134980']]), byId = new Map([['place:134980', '가상 공원'], ['optionaltour:14617', '가상 투어']]), descriptions = new Map();
  let nextRow = 500, nextOrigin = 900, posts = [], created = [];
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const parsed = new URL(url, ORIGIN);
    if (options.method === 'POST') {
      if (parsed.pathname === '/contents/place/add/') { const name = options.body.get('name_ko'); const id = String(135000 + created.length); created.push(name); places.set(name, id); byId.set(`place:${id}`, name); descriptions.set(`place:${id}`, options.body.get('description')); return new Response(JSON.stringify({ id }), { status: 201 }); }
      assert.equal(parsed.pathname, '/tour/master_product_schedule/98/change/');
      const body = JSON.parse(options.body); posts.push(body);
      if (saveStatus >= 300) return Response.json({ message: '가상 거절' }, { status: saveStatus });
      for (const item of body.created_list) {
        const id = nextRow++;
        tree.push({ ...row(id, item.day, item.step, item.type_id, item.etc1, item.description) });
        for (const content of item.contents) contents.push({ remark: content.remark, origin_id: nextOrigin++, code: 'C' + content.contents_id, contents_id: content.contents_id, detail_id: id, name_ko: 'x', confirm: 0, detail_sort: content.sort });
      }
      if (mutateOther) tree[0].etc1 = '바뀜';
      if (loseResponse) throw Error('fixture lost save response');
      return Response.json({ success: true });
    }
    if (parsed.pathname === '/tour/master_product_schedule/98/detail/') return Response.json(structuredClone({ schedule, schedule_tree: tree, contents, images: [] }));
    if (parsed.pathname.includes('city_in_country')) return Response.json({ results: [{ id: '7', parent_id: '8', text: '가상도시(TST)' }] });
    if (parsed.pathname.includes('country_in_continent')) return Response.json({ results: [{ id: '8', parent_id: '9', text: '가상국가' }] });
    const change = /^\/contents\/(\w+)\/(\d+)\/change\/$/.exec(parsed.pathname);
    if (change) return byId.has(`${change[1]}:${change[2]}`) ? new Response(`<input name="name_ko" value="${byId.get(`${change[1]}:${change[2]}`)}"><select name="use_flag"><option value="True" selected>Y</option></select>`) : new Response('', { status: 404 });
    if (/^\/contents\/(place|optionaltour|meal)\/$/.test(parsed.pathname)) {
      const name = parsed.searchParams.get('name_ko'), id = parsed.pathname === '/contents/place/' ? places.get(name) : undefined;
      return Response.json({ data: id ? [{ id, list_name_ko: name, list_city: '가상도시', list_use_flag: 'Y' }] : [] });
    }
    throw Error('unexpected fixture request ' + parsed.pathname);
  });
  globalThis.document = { cookie: 'csrftoken=fixture' };
  globalThis.DOMParser = class { parseFromString(html) { return { querySelectorAll: selector => { const name = /name="(\w+)"/.exec(selector)[1]; const m = new RegExp(`name="${name}"[^>]*?(?:value="([^"]*)")?>(?:<option value="([^"]*)" selected)?`).exec(html); return m ? [{ value: m[1] ?? m[2] }] : []; } }; } };
  t.after(() => { delete globalThis.document; delete globalThis.DOMParser; });
  const page = { url: () => `${ORIGIN}/tour/master_product/65/change/`, goto: async () => {}, evaluate: async (fn, args) => {
    if (args?.contentReadback) { const [, type, id] = /\/contents\/(\w+)\/(\d+)\/change\/$/.exec(args.url); return { names: [byId.get(`${type}:${id}`)], descriptions: [descriptions.get(`${type}:${id}`)], use: ['True'] }; }
    return fn(args);
  } };
  return { page, tree, contents, posts: () => posts, created };
}

const input = () => ({
  productId: '65', scheduleId: '98',
  contents: [{ type: 'place', key: 'new-falls', name: '가상 폭포', cityLabel: '가상도시(TST)', description: '가상 설명' }],
  days: [
    { day: 2, cards: [{ type: 'place', title: '시내 관광', contents: [{ contentId: '134980' }, 'new-falls'] }, { type: 'optionaltour', contents: [{ contentId: '14617' }] }] },
    { day: 3, cards: [{ type: 'place', contents: [{ name: '가상 공원', cityLabel: '가상도시(TST)' }] }] }
  ]
});
const journal = () => { const rows = []; return { rows, append: async entry => { rows.push(entry); } }; };
const run = async (f, plan, resolved, j) => runDayContents({ page: f.page, plan, resolved, images: [], journal: j, assertIdentity: async () => {}, companyId: '7' });

test('day contents validation accepts the three reference forms and rejects non-card types and unused contents', () => {
  const plan = validateDayContentPlan(input());
  assert.deepEqual(plan.target, { productId: '65', scheduleId: '98' });
  assert.deepEqual(plan.days[0].cards[0].refs, [{ contentId: '134980' }, { key: 'new-falls' }]);
  const broken = edit => () => { const value = input(); edit(value); validateDayContentPlan(value); };
  assert.throws(broken(v => { v.days[0].cards[0].type = 'shopping'; }), /place\(관광지\)\/meal\(식당\)\/optionaltour/);
  assert.throws(broken(v => { v.contents[0].type = 'meal'; }), /식당라서 관광지 카드/);
  assert.throws(broken(v => { v.days[0].cards[0].contents.pop(); }), /연결하지 않는 contents/);
  assert.throws(broken(v => { delete v.scheduleId; }), /함께/);
  assert.throws(broken(v => { v.days[1].day = 2; }), /중복 없는/);
  assert.throws(broken(v => { v.days[0].cards[0].title = '<b>x</b>'; }), /HTML/);
});

test('appendPayload is the native package save shape for new content steps after the last step', () => {
  const plan = validateDayContentPlan(input());
  assert.deepEqual(appendPayload(plan.target, 2, plan.days[0].cards, [['134980', '135000'], ['14617']], 1), {
    day: 2, product_id: '65', updated_list: [], deleted_list: [],
    created_list: [
      { type_id: 4, step: 2, etc1: '시내 관광', description: '', contents: [{ contents_id: 134980, remark: '', is_new: true, sort: 0 }, { contents_id: 135000, remark: '', is_new: true, sort: 1 }], day: 2 },
      { type_id: 8, step: 3, etc1: '', description: '', contents: [{ contents_id: 14617, remark: '', is_new: true, sort: 0 }], day: 2 }
    ]
  });
});

test('review is read-only, run creates the missing content, appends cards per day and re-run reuses them', async t => {
  const f = fakeErp(t), plan = validateDayContentPlan(input());
  const resolved = await resolveDayContents(f.page, plan);
  assert.equal(f.posts().length, 0); assert.equal(f.created.length, 0);
  assert.deepEqual(resolved.existing, { 'new-falls': null });
  assert.match(dayContentSummary(plan, resolved)[0], /가상 공원\(번호 134980\), 가상 폭포\(신규 생성\)/);
  const j = journal(), result = await run(f, plan, resolved, j);
  assert.deepEqual(f.created, ['가상 폭포']);
  assert.equal(f.posts().length, 2);
  assert.deepEqual(result.days.map(day => [day.day, day.cards.map(card => [card.type, card.contentIds])]), [[2, [['place', ['134980', '135000']], ['optionaltour', ['14617']]]], [3, [['place', ['134980']]]]]);
  const day2 = f.tree.filter(r => r.day === 2).sort((a, b) => a.step - b.step).map(r => [r.step, r.type_id]);
  assert.deepEqual(day2, [[1, 7], [2, 4], [3, 8], [999, 2]]);
  // A second run sees every card saved and writes nothing.
  const again = await run(f, plan, resolved, j);
  assert.equal(f.posts().length, 2); assert.equal(f.created.length, 1);
  assert.deepEqual(again.days.map(day => day.cards.map(card => card.detailId)), result.days.map(day => day.cards.map(card => card.detailId)));
});

test('an unanswered save is never retried; a rejected unchanged save may be retried', async t => {
  const lost = fakeErp(t, { loseResponse: true }), plan = validateDayContentPlan({ productId: '65', scheduleId: '98', days: [{ day: 1, cards: [{ type: 'optionaltour', contents: [{ contentId: '14617' }] }] }] });
  const resolved = await resolveDayContents(lost.page, plan), j = journal();
  await assert.rejects(run(lost, plan, resolved, j), /lost save response/);
  // Lost response but the save persisted: the re-run reconciles it instead of posting again.
  const reconciled = await run(lost, plan, resolved, j);
  assert.equal(lost.posts().length, 1); assert.equal(reconciled.days[0].cards.length, 1);
  t.mock.restoreAll();
  const rejected = fakeErp(t, { saveStatus: 400 }), r = await resolveDayContents(rejected.page, plan), jr = journal();
  await assert.rejects(run(rejected, plan, r, jr), /응답이 400입니다. 가상 거절/);
  assert.equal(jr.rows.at(-1).phase, 'day-rejected');
  await assert.rejects(run(rejected, plan, r, jr), /응답이 400/);
  assert.equal(rejected.posts().length, 2);
  // Unanswered attempt with nothing persisted: blocked.
  const blocked = journal(); blocked.rows.push({ phase: 'day-attempt', day: 1, lastStep: 1 });
  await assert.rejects(run(rejected, plan, r, blocked), /자동 재시도하지 않습니다/);
  assert.equal(rejected.posts().length, 2);
});

test('readback fails when the save changed another row', async t => {
  const f = fakeErp(t, { mutateOther: true }), plan = validateDayContentPlan({ productId: '65', scheduleId: '98', days: [{ day: 2, cards: [{ type: 'place', contents: [{ contentId: '134980' }] }] }] });
  await assert.rejects(run(f, plan, await resolveDayContents(f.page, plan), journal()), /기존 일정 행\(1일차 1단계\)이 바뀌었습니다/);
});

test('review rejects an unknown named content, a missing content ID and a day outside the schedule', async t => {
  const f = fakeErp(t);
  await assert.rejects(resolveDayContents(f.page, validateDayContentPlan({ productId: '65', scheduleId: '98', days: [{ day: 1, cards: [{ type: 'place', contents: [{ name: '없는 곳', cityLabel: '가상도시(TST)' }] }] }] })), /ERP에 없습니다/);
  await assert.rejects(resolveDayContents(f.page, validateDayContentPlan({ productId: '65', scheduleId: '98', days: [{ day: 1, cards: [{ type: 'place', contents: [{ contentId: '1' }] }] }] })), /404/);
  await assert.rejects(resolveDayContents(f.page, validateDayContentPlan({ productId: '65', scheduleId: '98', days: [{ day: 4, cards: [{ type: 'place', contents: [{ contentId: '134980' }] }] }] })), /3일 일정표에 없습니다/);
  await assert.rejects(resolveDayContents(f.page, validateDayContentPlan({ productId: '66', scheduleId: '98', days: [{ day: 1, cards: [{ type: 'place', contents: [{ contentId: '134980' }] }] }] })), /상품 66의 일정표가 아닙니다/);
  assert.equal(f.posts().length, 0);
});

test('runtime: prepare derives only a verified package target, review binds, register runs in background and reports days', async t => {
  const { mkdtemp, rm } = await import('node:fs/promises'), os = await import('node:os'), path = await import('node:path');
  const { ProductImportPlugin } = await import('../src/plugin-runtime.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'day-contents-'));
  const f = fakeErp(t), identity = { companyId: '7', identity: { accountName: '가상 담당자', accountKey: 'fixture-account', sessionKey: 'fixture-session' } };
  const runtime = new ProductImportPlugin({ dataDir: root, browser: { ensurePage: async () => f.page, close: async () => {}, open: async () => ({}) }, identityReader: async () => structuredClone(identity) });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true, maxRetries: 3 }); });
  const job = await runtime.source({ text: '가상 패키지 자료', seasonMode: 'excluded' });
  const cards = { days: [{ day: 2, cards: [{ type: 'place', contents: [{ contentId: '134980' }] }] }] };
  await assert.rejects(runtime.dayContentsPrepare({ id: job.id, dayContents: cards }), /독립 재조회까지 완료된 패키지 상품이 없습니다/);
  const stored = await runtime.load(job.id);
  stored.status = 'completed'; stored.result = { finalCheck: 'verified', target: { productId: 65, masterCode: 'M', scheduleId: 98 } }; await runtime.save(stored);
  assert.deepEqual((await runtime.dayContentsPrepare({ id: job.id, dayContents: cards })).target, { productId: '65', scheduleId: '98' });
  const binding = await runtime.dayContentsReview({ id: job.id });
  assert.equal(binding.schedule.title, '가상 일정표');
  assert.match(binding.summary[0], /^2일차: 관광지 카드 — 가상 공원\(번호 134980\)$/);
  const args = { id: job.id, companyId: binding.companyId, accountName: binding.accountName, planDigest: binding.planDigest, delegation: { explicitUserRequest: true, userInstruction: '일정에 관광지 붙여줘' } };
  await assert.rejects(runtime.dayContentsRegister({ ...args, planDigest: 'b'.repeat(64) }), /다시 검토하세요/);
  assert.equal((await runtime.dayContentsRegister(args)).status, 'running');
  await runtime.dayContentsActive.done;
  const done = await runtime.get({ id: job.id, compact: true });
  assert.equal(done.dayContents.status, 'completed');
  assert.equal(done.dayContents.completedDays, 1);
  assert.deepEqual(done.dayContents.result.days[0].cards.map(card => card.contentIds), [['134980']]);
  assert.equal(f.posts().length, 1);
  await assert.rejects(runtime.dayContentsPrepare({ id: job.id, dayContents: cards }), /바꿀 수 없습니다/);
});
