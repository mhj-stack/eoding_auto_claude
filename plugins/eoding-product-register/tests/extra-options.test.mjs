import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { validateExtraOptionsPlan, readSubOptions, buildSubOptionSave, resolveExtraOptions, runExtraOptions, extraOptionsSummary, subOptionUrls } from '../src/extra-options.mjs';

const ORIGIN = 'https://basecamp.team', TOKEN = 'fixture-csrf', GROUP = '5202';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const select = (name, options, value) => `<select name="${name}">${options.map(([v, label]) => `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`).join('')}</select>`;

/** Renders the 추가옵션 tab like the ERP: a Django formset form plus blank row templates outside it. */
function renderTab(options, { extraTemplateField = false } = {}) {
  const rows = options.map((option, i) => {
    const prices = `option_price-sub_option-${i}-sub_option_price`;
    return `<div class="sub_option_box">
      <input type="hidden" name="sub_option-${i}-date_linked_flag" value=""><input type="hidden" name="sub_option-${i}-sort" value="${i}">
      <input type="hidden" name="sub_option-${i}-use_flag" value="True"><input type="hidden" name="sub_option-${i}-id" value="${option.id}">
      <input type="hidden" name="sub_option-${i}-sub_option_group" value="${GROUP}"><input type="text" name="sub_option-${i}-name" value="${escape(option.name)}">
      ${select(`sub_option-${i}-suboption_type`, [['1', '단일선택'], ['2', '다중선택']], option.selection)}
      ${select(`sub_option-${i}-is_required`, [['False', '선택구매'], ['True', '필수구매']], option.required)}
      <input type="checkbox" name="sub_option-${i}-DELETE">
      <input type="hidden" name="${prices}-TOTAL_FORMS" value="${option.items.length}"><input type="hidden" name="${prices}-INITIAL_FORMS" value="${option.items.length}">
      <input type="hidden" name="${prices}-MIN_NUM_FORMS" value="0"><input type="hidden" name="${prices}-MAX_NUM_FORMS" value="1000">
      ${option.items.map((item, j) => `<input type="hidden" name="${prices}-${j}-id" value="${item.id}"><input type="hidden" name="${prices}-${j}-sort" value="${j}">
        <input type="hidden" name="${prices}-${j}-use_flag" value="True"><input type="text" name="${prices}-${j}-name" value="${escape(item.name)}">
        <input type="text" input-format="money" name="${prices}-${j}-price" value="${item.price}"><input type="text" name="${prices}-${j}-description" value="${escape(item.description)}">
        <input type="checkbox" name="${prices}-${j}-count_flag"${item.countable ? ' checked' : ''}><input type="checkbox" name="${prices}-${j}-DELETE">`).join('')}
    </div>`;
  }).join('');
  const p = 'option_price-sub_option-__prefix__-sub_option_price';
  return `<div class="form box-wrapper" id="sub_option_tab"><button id="sub_option_add">추가옵션추가</button><button id="sub_option_save">저장</button>
    <form id="sub_option_form" method="post"><input type="hidden" name="csrfmiddlewaretoken" value="${TOKEN}">
      <input type="hidden" name="sub_option-TOTAL_FORMS" value="${options.length}"><input type="hidden" name="sub_option-INITIAL_FORMS" value="${options.length}">
      <input type="hidden" name="sub_option-MIN_NUM_FORMS" value="0"><input type="hidden" name="sub_option-MAX_NUM_FORMS" value="1000">
      <div id="sub_option_area">${rows}</div></form>
    <div class="empty_sub_option_area" style="display:none"><div class="sub_option_box">
      <input type="hidden" name="sub_option-__prefix__-date_linked_flag"><input type="hidden" name="sub_option-__prefix__-sort"><input type="hidden" name="sub_option-__prefix__-use_flag">
      <input type="hidden" name="sub_option-__prefix__-id"><input type="hidden" name="sub_option-__prefix__-sub_option_group" value="${GROUP}">
      <input type="text" name="sub_option-__prefix__-name">${select('sub_option-__prefix__-suboption_type', [['1', '단일선택'], ['2', '다중선택']], '1')}
      ${select('sub_option-__prefix__-is_required', [['False', '선택구매'], ['True', '필수구매']], 'False')}<input type="checkbox" name="sub_option-__prefix__-DELETE">
      <input type="hidden" name="${p}-TOTAL_FORMS" value="0"><input type="hidden" name="${p}-INITIAL_FORMS" value="0"><input type="hidden" name="${p}-MIN_NUM_FORMS" value="0"><input type="hidden" name="${p}-MAX_NUM_FORMS" value="1000">
      ${extraTemplateField ? '<input type="text" name="sub_option-__prefix__-new_erp_field">' : ''}
    </div></div>
    <div class="empty_option_price_row" style="display:none"><table><tbody><tr>
      <td><input type="hidden" name="${p}-__prefix2__-id"><input type="hidden" value="0" name="${p}-__prefix2__-sort"><input type="hidden" value="True" name="${p}-__prefix2__-use_flag">
      <input type="text" name="${p}-__prefix2__-name"></td><td><input type="text" input-format="money" name="${p}-__prefix2__-price"></td>
      <td><input type="text" name="${p}-__prefix2__-description"></td><td><input type="checkbox" name="${p}-__prefix2__-count_flag"></td><td><input type="checkbox" name="${p}-__prefix2__-DELETE"></td>
    </tr></tbody></table></div></div>`;
}

/** Applies a posted formset the way Django would: update by id, create rows without id, drop DELETE rows. */
function applySave(options, form, nextId) {
  const total = Number(form.get('sub_option-TOTAL_FORMS'));
  const next = [];
  for (let i = 0; i < total; i += 1) {
    if (form.get(`sub_option-${i}-DELETE`) === 'on') continue;
    const id = form.get(`sub_option-${i}-id`), name = form.get(`sub_option-${i}-name`), selection = form.get(`sub_option-${i}-suboption_type`), required = form.get(`sub_option-${i}-is_required`);
    if (!name || !['1', '2'].includes(selection) || !['True', 'False'].includes(required)) return null;
    if (!id && form.get(`sub_option-${i}-sub_option_group`) !== GROUP) return null;
    const prices = `option_price-sub_option-${i}-sub_option_price`, items = [];
    for (let j = 0; j < Number(form.get(`${prices}-TOTAL_FORMS`)); j += 1) {
      if (form.get(`${prices}-${j}-DELETE`) === 'on') continue;
      const price = form.get(`${prices}-${j}-price`);
      if (!form.get(`${prices}-${j}-name`) || !/^\d+$/.test(price ?? '')) return null;
      items.push({ id: form.get(`${prices}-${j}-id`) || String(nextId()), name: form.get(`${prices}-${j}-name`), price, description: form.get(`${prices}-${j}-description`) ?? '', countable: form.get(`${prices}-${j}-count_flag`) === 'on' });
    }
    next.push({ id: id || String(nextId()), name, selection, required, items });
  }
  return next;
}

async function fixture(t, { reject = false, extraTemplateField = false } = {}) {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  let id = 9000;
  const nextId = () => ++id;
  const tabs = {
    'master_product/65': [{ id: '501', name: '기존 옵션', selection: '1', required: 'False', items: [{ id: '601', name: '기존 항목', price: '10000', description: '그대로', countable: false }] }],
    'product/77': []
  };
  const posts = [];
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/tour/master_product/65/change/') return route.fulfill({ contentType: 'text/html', body: '<html><body>fixture product</body></html>' });
    const read = /^\/tour\/(master_product|product)\/sub_option\/(\d+)\/$/.exec(url.pathname);
    if (read && request.method() === 'GET') return route.fulfill({ contentType: 'text/html', body: renderTab(tabs[`${read[1]}/${read[2]}`], { extraTemplateField }) });
    const save = /^\/tour\/(master_product|product)\/sub_option\/(\d+)\/save\/$/.exec(url.pathname);
    if (save && request.method() === 'POST') {
      const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData();
      posts.push({ key: `${save[1]}/${save[2]}`, csrf: request.headers()['x-csrftoken'], entries: [...form.entries()] });
      if (reject || request.headers()['x-csrftoken'] !== TOKEN) return route.fulfill({ status: 400, json: { message: '가상 거절' } });
      const next = applySave(tabs[`${save[1]}/${save[2]}`], form, nextId);
      if (!next) return route.fulfill({ status: 400, json: { message: '입력 오류' } });
      tabs[`${save[1]}/${save[2]}`] = next;
      return route.fulfill({ status: 200, json: { success: true } });
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/tour/master_product/65/change/`);
  return { page, tabs, posts };
}

const input = {
  productId: '65', eventIds: ['77'],
  options: [
    { name: '기존 옵션', items: [{ name: '기존 항목', price: 10000, description: '그대로' }] },
    { name: '객실 업그레이드', selection: 'single', required: false, items: [{ name: '싱글룸 사용', price: 260000, description: '1인 1실' }, { name: '디럭스룸', price: 80000 }] },
    { name: '추가 서비스', selection: 'multiple', required: true, items: [{ name: '공항 라운지', price: 55000, countable: true }] }
  ]
};
const memoryJournal = (rows = []) => ({ rows, append: async row => { rows.push(row); } });

test('extra options input is validated strictly with explicit defaults', () => {
  const plan = validateExtraOptionsPlan({ options: [{ name: '옵션', items: [{ name: '항목', price: 0 }] }] });
  assert.deepEqual(plan, { productId: null, eventIds: null, options: [{ name: '옵션', selection: 'single', required: false, items: [{ name: '항목', price: 0, description: '', countable: false }] }] });
  for (const [bad, message] of [
    [{ options: [] }, /1~30개/],
    [{ options: [{ name: 'A', items: [{ name: 'x', price: 1 }] }, { name: 'A', items: [{ name: 'y', price: 1 }] }] }, /두 번/],
    [{ options: [{ name: 'A', items: [{ name: 'x', price: -1 }] }] }, /정수/],
    [{ options: [{ name: 'A', items: [{ name: 'x', price: 1.5 }] }] }, /정수/],
    [{ options: [{ name: 'A', selection: 'all', items: [{ name: 'x', price: 1 }] }] }, /single/],
    [{ options: [{ name: '<b>A</b>', items: [{ name: 'x', price: 1 }] }] }, /HTML/],
    [{ options: [{ name: 'A', items: [{ name: 'x', price: 1, color: 'red' }] }] }, /지원하지 않는/],
    [{ productId: 'abc', options: [{ name: 'A', items: [{ name: 'x', price: 1 }] }] }, /숫자 ID/],
    [{ eventIds: ['7', '7'], options: [{ name: 'A', items: [{ name: 'x', price: 1 }] }] }, /두 번/]
  ]) assert.throws(() => validateExtraOptionsPlan(bad), message);
  assert.deepEqual(subOptionUrls({ kind: 'event', id: '77' }), { read: '/tour/product/sub_option/77/', save: '/tour/product/sub_option/77/save/' });
});

test('the save payload resends every existing field unchanged and appends new formset rows', async t => {
  const { page } = await fixture(t);
  const current = await readSubOptions(page, { kind: 'product', id: '65' });
  const plan = validateExtraOptionsPlan(input);
  const fields = buildSubOptionSave(current, plan.options.slice(1));
  const map = new Map(fields);
  for (const [name, value] of current.fields) if (name !== 'sub_option-TOTAL_FORMS') assert.equal(map.get(name), value, name);
  assert.equal(map.get('sub_option-TOTAL_FORMS'), '3');
  assert.equal(map.get('sub_option-1-name'), '객실 업그레이드');
  assert.equal(map.get('sub_option-1-sub_option_group'), GROUP);
  assert.equal(map.get('sub_option-2-suboption_type'), '2');
  assert.equal(map.get('sub_option-2-is_required'), 'True');
  assert.equal(map.get('option_price-sub_option-1-sub_option_price-TOTAL_FORMS'), '2');
  assert.equal(map.get('option_price-sub_option-1-sub_option_price-0-price'), '260000');
  assert.equal(map.get('option_price-sub_option-2-sub_option_price-0-count_flag'), 'on');
  assert.equal(map.has('option_price-sub_option-1-sub_option_price-1-count_flag'), false);
  assert.equal(map.has('sub_option-1-DELETE'), false);
});

test('review then register appends only new options to the product and the event and verifies them', async t => {
  const { page, tabs, posts } = await fixture(t);
  const plan = validateExtraOptionsPlan(input);
  const resolved = await resolveExtraOptions(page, plan);
  assert.deepEqual(resolved.targets.map(target => [target.kind, target.create, target.existing, target.conflicts]), [
    ['product', ['객실 업그레이드', '추가 서비스'], ['기존 옵션'], []],
    ['event', ['기존 옵션', '객실 업그레이드', '추가 서비스'], [], []]
  ]);
  assert.match(extraOptionsSummary(plan, resolved).join('\n'), /상품 65: 기존 1개 유지 \/ 새로 추가 2개/);
  const journal = memoryJournal();
  const result = await runExtraOptions({ page, plan, resolved, journal, assertIdentity: async () => {} });
  assert.equal(posts.length, 2);
  assert.ok(posts.every(post => post.csrf === TOKEN));
  assert.deepEqual(result.targets.map(target => [target.kind, target.created.map(row => row.name), target.skipped]), [
    ['product', ['객실 업그레이드', '추가 서비스'], ['기존 옵션']],
    ['event', ['기존 옵션', '객실 업그레이드', '추가 서비스'], []]
  ]);
  assert.deepEqual(tabs['master_product/65'][0], { id: '501', name: '기존 옵션', selection: '1', required: 'False', items: [{ id: '601', name: '기존 항목', price: '10000', description: '그대로', countable: false }] });
  assert.equal(tabs['master_product/65'][2].required, 'True');
  assert.equal(tabs['master_product/65'][2].items[0].countable, true);
  const again = await runExtraOptions({ page, plan, resolved, journal, assertIdentity: async () => {} });
  assert.equal(posts.length, 2, 'a finished target is never saved twice');
  assert.deepEqual(again.targets.map(target => target.created.length), [2, 3]);
});

test('a change in ERP after review blocks the save', async t => {
  const { page, tabs, posts } = await fixture(t);
  const plan = validateExtraOptionsPlan({ ...input, eventIds: [] });
  const resolved = await resolveExtraOptions(page, plan);
  tabs['master_product/65'][0].items[0].price = '20000';
  await assert.rejects(runExtraOptions({ page, plan, resolved, journal: memoryJournal(), assertIdentity: async () => {} }), /검토 뒤에 바뀌었습니다/);
  assert.equal(posts.length, 0);
});

test('a rejected save that left ERP unchanged fails clearly after one attempt', async t => {
  const { page, posts } = await fixture(t, { reject: true });
  const plan = validateExtraOptionsPlan({ ...input, eventIds: [] });
  const resolved = await resolveExtraOptions(page, plan);
  const journal = memoryJournal();
  await assert.rejects(runExtraOptions({ page, plan, resolved, journal, assertIdentity: async () => {} }), /거절됐습니다\(400\)/);
  assert.equal(posts.length, 1);
  await assert.rejects(runExtraOptions({ page, plan, resolved, journal, assertIdentity: async () => {} }), /재조회/, 'an attempted save is not retried automatically');
  assert.equal(posts.length, 1);
});

test('an attempted save whose result is already in ERP is reconciled without posting again', async t => {
  const { page, posts } = await fixture(t);
  const plan = validateExtraOptionsPlan({ ...input, eventIds: [] });
  const resolved = await resolveExtraOptions(page, plan);
  const first = memoryJournal();
  await runExtraOptions({ page, plan, resolved, journal: first, assertIdentity: async () => {} });
  const lostResponse = memoryJournal(first.rows.filter(row => row.phase === 'save-attempt'));
  const result = await runExtraOptions({ page, plan, resolved, journal: lostResponse, assertIdentity: async () => {} });
  assert.equal(posts.length, 1);
  assert.deepEqual(result.targets[0].created.map(row => row.name), ['객실 업그레이드', '추가 서비스']);
  assert.equal(lostResponse.rows.at(-1).reconciled, true);
});

test('an unknown field in the ERP row template stops before any write', async t => {
  const { page, posts } = await fixture(t, { extraTemplateField: true });
  await assert.rejects(resolveExtraOptions(page, validateExtraOptionsPlan(input)), /형식과 다릅니다/);
  assert.equal(posts.length, 0);
});
