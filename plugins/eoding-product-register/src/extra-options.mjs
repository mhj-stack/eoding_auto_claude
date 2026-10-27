// Product extra options (상품 상세 > 추가옵션 tab): the ERP stores them as a Django formset
// (sub_option-N-* with a nested option_price-sub_option-N-sub_option_price-M-* formset) and saves the
// whole tab in one multipart POST. This flow only appends new options after the existing ones: every
// existing option and item is sent back unchanged, one guarded POST per target, then an independent
// re-read must show the existing options untouched and each new option exactly once. Events (행사)
// keep their own copy of the tab, so they are separate targets.

const fail = message => { throw new Error(message); };
const ID = /^[1-9][0-9]{0,12}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** ERP values of 항목선택방식(홈페이지). */
export const EXTRA_OPTION_SELECTION = Object.freeze({ single: '1', multiple: '2' });
const SELECTION_LABEL = Object.freeze({ 1: '단일선택', 2: '다중선택' });
const MAX_OPTIONS = 30, MAX_ITEMS = 50, MAX_PRICE = 999_999_999;

/** Read and save URLs of the 추가옵션 tab for a master product or an event (tour product). */
export function subOptionUrls({ kind, id }) {
  if (!['product', 'event'].includes(kind) || !ID.test(String(id))) fail('추가옵션 대상은 상품(product) 또는 행사(event)의 ERP 숫자 ID입니다.');
  const prefix = kind === 'product' ? 'master_product' : 'product';
  return { read: `/tour/${prefix}/sub_option/${id}/`, save: `/tour/${prefix}/sub_option/${id}/save/` };
}

const text = (value, where, max, { optional = false } = {}) => {
  if (value === undefined && optional) return '';
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || /[<>\u0000-\u001f]/.test(value)) fail(`${where}는 앞뒤 공백·HTML 없는 ${max}자 이하 문자열이어야 합니다.`);
  return value;
};
const flag = (value, where, fallback) => {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') fail(`${where}는 true/false입니다.`);
  return value;
};
const erpId = (value, where) => { const result = String(value ?? ''); if (!ID.test(result)) fail(`${where}는 ERP 숫자 ID여야 합니다.`); return result; };

/**
 * Validates the extra options input: `options[]` of {name, selection?, required?, items[]} where an
 * item is {name, price, description?, countable?}. `productId`/`eventIds` are optional here; the
 * runtime fills them from the job's verified package result.
 */
export function validateExtraOptionsPlan(input) {
  if (!plainObject(input)) fail('extraOptions 입력은 객체여야 합니다.');
  const extra = Object.keys(input).filter(key => !['productId', 'eventIds', 'options'].includes(key));
  if (extra.length) fail(`지원하지 않는 항목: ${extra.join(', ')}`);
  const productId = input.productId === undefined ? null : erpId(input.productId, 'productId');
  let eventIds = null;
  if (input.eventIds !== undefined) {
    if (!Array.isArray(input.eventIds) || input.eventIds.length > 20) fail('eventIds는 0~20개 행사 ID 배열입니다.');
    eventIds = input.eventIds.map((value, index) => erpId(value, `eventIds[${index}]`));
    if (new Set(eventIds).size !== eventIds.length) fail('eventIds에 같은 행사가 두 번 있습니다.');
  }
  if (!Array.isArray(input.options) || input.options.length < 1 || input.options.length > MAX_OPTIONS) fail(`options는 1~${MAX_OPTIONS}개 추가옵션 배열입니다.`);
  const names = new Set();
  const options = input.options.map((option, index) => {
    const where = `options[${index}]`;
    if (!plainObject(option)) fail(`${where}는 객체여야 합니다.`);
    const unknown = Object.keys(option).filter(key => !['name', 'selection', 'required', 'items'].includes(key));
    if (unknown.length) fail(`${where}에 지원하지 않는 항목이 있습니다: ${unknown.join(', ')}`);
    const name = text(option.name, `${where}.name`, 100);
    if (names.has(name)) fail(`추가옵션 이름 "${name}"이 두 번 있습니다.`);
    names.add(name);
    const selection = option.selection === undefined ? 'single' : option.selection;
    if (!Object.hasOwn(EXTRA_OPTION_SELECTION, selection)) fail(`${where}.selection은 single(단일선택) 또는 multiple(다중선택)입니다.`);
    if (!Array.isArray(option.items) || option.items.length < 1 || option.items.length > MAX_ITEMS) fail(`${where}.items는 1~${MAX_ITEMS}개 항목 배열입니다.`);
    const itemNames = new Set();
    const items = option.items.map((item, itemIndex) => {
      const at = `${where}.items[${itemIndex}]`;
      if (!plainObject(item)) fail(`${at}는 객체여야 합니다.`);
      const extraKeys = Object.keys(item).filter(key => !['name', 'price', 'description', 'countable'].includes(key));
      if (extraKeys.length) fail(`${at}에 지원하지 않는 항목이 있습니다: ${extraKeys.join(', ')}`);
      const itemName = text(item.name, `${at}.name`, 100);
      if (itemNames.has(itemName)) fail(`${name}의 항목 "${itemName}"이 두 번 있습니다.`);
      itemNames.add(itemName);
      if (!Number.isSafeInteger(item.price) || item.price < 0 || item.price > MAX_PRICE) fail(`${at}.price는 0~${MAX_PRICE}의 정수(원) 판매가입니다.`);
      return { name: itemName, price: item.price, description: text(item.description, `${at}.description`, 200, { optional: true }), countable: flag(item.countable, `${at}.countable`, false) };
    });
    return { name, selection, required: flag(option.required, `${where}.required`, false), items };
  });
  return { productId, eventIds, options };
}

/** Comparable shape of one option: ERP form values reduced to what this flow writes. */
function comparable(option) {
  return { name: option.name, selection: EXTRA_OPTION_SELECTION[option.selection] ?? option.selection, required: option.required === true || option.required === 'True' ? 'True' : 'False', items: option.items.map(item => ({ name: item.name, price: String(item.price), description: item.description ?? '', countable: item.countable === true })) };
}

/**
 * Reads the tab through the logged-in page (read-only GET) and returns the exact form payload the ERP
 * button would send, the active options, and the blank row templates the new options are built from.
 */
export async function readSubOptions(page, target) {
  const { read } = subOptionUrls(target);
  const state = await page.evaluate(async url => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error(`ERP 추가옵션 조회 실패 ${response.status}: ${url}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const forms = doc.querySelectorAll('form#sub_option_form');
    if (forms.length !== 1) throw new Error('ERP 추가옵션 폼을 정확히 하나 찾지 못했습니다.');
    const form = forms[0];
    // Same entries as `new FormData(form)`, which the ERP save button posts.
    const fields = [];
    for (const element of form.querySelectorAll('input, select, textarea')) {
      if (!element.name || element.disabled) continue;
      if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) { if (element.checked) fields.push([element.name, element.value || 'on']); continue; }
      if (element.tagName === 'INPUT' && ['file', 'submit', 'button', 'image', 'reset'].includes(element.type)) continue;
      if (element.tagName === 'SELECT') { const chosen = [...element.options].filter(option => option.selected); for (const option of chosen.length || element.multiple ? chosen : element.options.length ? [element.options[0]] : []) fields.push([element.name, option.value]); continue; }
      fields.push([element.name, element.value]);
    }
    const value = name => { const element = form.querySelector(`[name="${name}"]`); if (!element) return null; if (element.type === 'checkbox') return element.checked; if (element.tagName === 'SELECT') return element.value; return element.value; };
    const total = Number(value('sub_option-TOTAL_FORMS'));
    if (!Number.isInteger(total) || total < 0) throw new Error('ERP 추가옵션 TOTAL_FORMS를 읽지 못했습니다.');
    const options = [];
    for (let i = 0; i < total; i += 1) {
      const prefix = `option_price-sub_option-${i}-sub_option_price`, itemTotal = Number(value(`${prefix}-TOTAL_FORMS`) ?? 0);
      const items = [];
      for (let j = 0; j < itemTotal; j += 1) items.push({ id: value(`${prefix}-${j}-id`) ?? '', name: value(`${prefix}-${j}-name`) ?? '', price: value(`${prefix}-${j}-price`) ?? '', description: value(`${prefix}-${j}-description`) ?? '', countable: value(`${prefix}-${j}-count_flag`) === true, deleted: value(`${prefix}-${j}-DELETE`) === true });
      options.push({ index: i, id: value(`sub_option-${i}-id`) ?? '', name: value(`sub_option-${i}-name`) ?? '', selection: value(`sub_option-${i}-suboption_type`) ?? '', required: value(`sub_option-${i}-is_required`) ?? '', deleted: value(`sub_option-${i}-DELETE`) === true, items });
    }
    const names = selector => [...doc.querySelectorAll(`${selector} input, ${selector} select, ${selector} textarea`)].map(element => element.name).filter(Boolean);
    const groups = [...doc.querySelectorAll('.empty_sub_option_area [name="sub_option-__prefix__-sub_option_group"]')].map(element => element.value);
    const csrf = [...form.querySelectorAll('input[name="csrfmiddlewaretoken"]')].map(element => element.value);
    return { fields, total, options, csrf, template: { option: names('.empty_sub_option_area'), price: names('.empty_option_price_row'), groups } };
  }, read);
  const optionNames = ['date_linked_flag', 'sort', 'use_flag', 'id', 'sub_option_group', 'name', 'suboption_type', 'is_required', 'DELETE'].map(name => `sub_option-__prefix__-${name}`)
    .concat(['TOTAL_FORMS', 'INITIAL_FORMS', 'MIN_NUM_FORMS', 'MAX_NUM_FORMS'].map(name => `option_price-sub_option-__prefix__-sub_option_price-${name}`));
  const priceNames = ['id', 'sort', 'use_flag', 'name', 'price', 'description', 'count_flag', 'DELETE'].map(name => `option_price-sub_option-__prefix__-sub_option_price-__prefix2__-${name}`);
  // The option template also embeds the price template; only unknown names mean the ERP form changed.
  if (!same([...new Set(state.template.option)].filter(name => !priceNames.includes(name)).sort(), [...optionNames].sort()) || !same([...state.template.price].sort(), [...priceNames].sort())) fail('ERP 추가옵션 양식이 이 기능이 아는 형식과 다릅니다. 플러그인을 업데이트하거나 ERP에서 직접 입력하세요.');
  if (state.template.groups.length !== 1 || !ID.test(state.template.groups[0])) fail('ERP 추가옵션 그룹 번호를 정확히 하나 읽지 못했습니다.');
  if (state.csrf.length !== 1 || !state.csrf[0]) fail('ERP 추가옵션 폼의 CSRF 값을 정확히 하나 읽지 못했습니다.');
  return { target: { ...target, id: String(target.id) }, fields: state.fields, total: state.total, options: state.options, group: state.template.groups[0], csrf: state.csrf[0] };
}

/** Existing options that are not marked deleted, in the comparable shape (ids kept for the readback). */
export function activeOptions(current) {
  return current.options.filter(option => !option.deleted).map(option => ({ id: option.id, ...comparable({ ...option, items: option.items.filter(item => !item.deleted).map(item => ({ ...item, price: String(item.price).replace(/,/g, '').replace(/\.0+$/, '') })) }) }));
}

/** The exact multipart entries for one save: the current form unchanged plus the new options appended. */
export function buildSubOptionSave(current, options) {
  if (!options.length) fail('저장할 새 추가옵션이 없습니다.');
  const total = current.total + options.length;
  const fields = current.fields.map(([name, value]) => [name, name === 'sub_option-TOTAL_FORMS' ? String(total) : value]);
  if (fields.filter(([name]) => name === 'sub_option-TOTAL_FORMS').length !== 1) fail('ERP 추가옵션 폼에 TOTAL_FORMS가 정확히 하나 있어야 합니다.');
  let sort = current.options.filter(option => !option.deleted).length;
  options.forEach((option, offset) => {
    const i = current.total + offset, row = `sub_option-${i}`, prices = `option_price-sub_option-${i}-sub_option_price`;
    fields.push([`${row}-date_linked_flag`, ''], [`${row}-sort`, String(sort++)], [`${row}-use_flag`, ''], [`${row}-id`, ''], [`${row}-sub_option_group`, current.group],
      [`${row}-name`, option.name], [`${row}-suboption_type`, EXTRA_OPTION_SELECTION[option.selection]], [`${row}-is_required`, option.required ? 'True' : 'False'],
      [`${prices}-TOTAL_FORMS`, String(option.items.length)], [`${prices}-INITIAL_FORMS`, '0'], [`${prices}-MIN_NUM_FORMS`, '0'], [`${prices}-MAX_NUM_FORMS`, '1000']);
    option.items.forEach((item, j) => {
      fields.push([`${prices}-${j}-id`, ''], [`${prices}-${j}-sort`, String(j)], [`${prices}-${j}-use_flag`, 'True'], [`${prices}-${j}-name`, item.name], [`${prices}-${j}-price`, String(item.price)], [`${prices}-${j}-description`, item.description]);
      if (item.countable) fields.push([`${prices}-${j}-count_flag`, 'on']);
    });
  });
  return fields;
}

async function postSubOptions(page, url, fields, csrf) {
  return page.evaluate(async ({ url, fields, csrf }) => {
    const body = new FormData();
    for (const [name, value] of fields) body.append(name, value);
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'X-CSRFTOKEN': csrf, 'X-Requested-With': 'XMLHttpRequest' }, body });
    return { status: response.status, type: response.type };
  }, { url, fields, csrf });
}

function targetsOf(plan) {
  if (!plan.productId) fail('추가옵션을 넣을 상품 ID가 없습니다.');
  return [{ kind: 'product', id: plan.productId }, ...(plan.eventIds ?? []).map(id => ({ kind: 'event', id }))];
}
const keyOf = target => `${target.kind}:${target.id}`;
const label = target => `${target.kind === 'product' ? '상품' : '행사'} ${target.id}`;

/** Read-only review: each target's current options, which planned options are new and which already exist. */
export async function resolveExtraOptions(page, plan) {
  const targets = [];
  for (const target of targetsOf(plan)) {
    const current = await readSubOptions(page, target), active = activeOptions(current);
    const create = [], existing = [], conflicts = [];
    for (const option of plan.options) {
      const found = active.filter(row => row.name === option.name);
      if (!found.length) create.push(option.name);
      else if (found.length === 1 && same({ ...found[0], id: undefined }, { ...comparable(option), id: undefined })) existing.push(option.name);
      else conflicts.push(option.name);
    }
    targets.push({ ...current.target, baseline: active, create, existing, conflicts });
  }
  return { targets };
}

export function extraOptionsSummary(plan, resolved) {
  const byName = new Map(plan.options.map(option => [option.name, option]));
  const describe = name => { const option = byName.get(name); return `${name}(${SELECTION_LABEL[EXTRA_OPTION_SELECTION[option.selection]]}·${option.required ? '필수' : '선택'}구매, 항목 ${option.items.length}개)`; };
  return resolved.targets.map(target => `${label(target)}: 기존 ${target.baseline.length}개 유지` +
    (target.create.length ? ` / 새로 추가 ${target.create.length}개 — ${target.create.map(describe).join(', ')}` : ' / 새로 추가할 옵션 없음') +
    (target.existing.length ? ` / 이미 같은 내용으로 있음: ${target.existing.join(', ')}` : '') +
    (target.conflicts.length ? ` / 같은 이름이 다른 내용으로 있어 건너뜀: ${target.conflicts.join(', ')}` : ''));
}

/** The re-read must show every baseline option untouched and each new option exactly once, appended. */
function verifySaved(after, baseline, planned, target) {
  const active = activeOptions(after);
  if (active.length !== baseline.length + planned.length) fail(`${label(target)} 저장 뒤 추가옵션 수(${active.length})가 계획(${baseline.length + planned.length})과 다릅니다.`);
  if (!same(active.slice(0, baseline.length), baseline)) fail(`${label(target)} 저장 뒤 기존 추가옵션이 바뀌었습니다.`);
  const added = active.slice(baseline.length);
  planned.forEach((option, index) => {
    const { id, ...saved } = added[index];
    if (!ID.test(id) || !same(saved, comparable(option))) fail(`${label(target)}의 "${option.name}" 재조회가 계획과 다릅니다.`);
  });
  return added.map(({ id, name }) => ({ id, name }));
}

/**
 * Appends the reviewed options target by target. A re-run reconciles from the journal: a target whose
 * save was attempted is accepted only when the re-read already shows the exact planned result.
 */
export async function runExtraOptions({ page, plan, resolved, journal, assertIdentity, progress = () => {} }) {
  const results = [];
  for (const reviewed of resolved.targets) {
    const target = { kind: reviewed.kind, id: reviewed.id }, key = keyOf(target);
    const done = journal.rows.find(row => row.phase === 'target-done' && row.key === key);
    if (done) { results.push({ ...target, created: done.created, skipped: [...reviewed.existing, ...reviewed.conflicts] }); continue; }
    progress(key);
    const planned = plan.options.filter(option => reviewed.create.includes(option.name));
    const current = await readSubOptions(page, target);
    await assertIdentity();
    const attempted = journal.rows.some(row => row.phase === 'save-attempt' && row.key === key);
    if (attempted) {
      let created;
      try { created = verifySaved(current, reviewed.baseline, planned, target); }
      catch (error) { fail(`${label(target)} 추가옵션 저장을 시도한 기록이 있지만 재조회 결과가 계획과 다릅니다(${error.message}). 자동으로 다시 저장하지 않습니다. ERP에서 확인한 뒤 새 작업으로 진행하세요.`); }
      await journal.append({ phase: 'target-done', key, created, reconciled: true });
      results.push({ ...target, created, skipped: [...reviewed.existing, ...reviewed.conflicts] });
      continue;
    }
    if (!same(activeOptions(current), reviewed.baseline)) fail(`${label(target)}의 추가옵션이 검토 뒤에 바뀌었습니다. 다시 검토하세요.`);
    if (!planned.length) {
      await journal.append({ phase: 'target-done', key, created: [] });
      results.push({ ...target, created: [], skipped: [...reviewed.existing, ...reviewed.conflicts] });
      continue;
    }
    const fields = buildSubOptionSave(current, planned);
    await journal.append({ phase: 'save-attempt', key, options: planned.map(option => option.name) });
    const response = await postSubOptions(page, subOptionUrls(target).save, fields, current.csrf);
    await journal.append({ phase: 'save-response', key, status: response.status, type: response.type });
    const after = await readSubOptions(page, target);
    await assertIdentity();
    const accepted = (response.status >= 200 && response.status < 300) || response.type === 'opaqueredirect';
    if (!accepted && same(activeOptions(after), reviewed.baseline)) fail(`${label(target)} 추가옵션 저장이 거절됐습니다(${response.status}). ERP에는 바뀐 것이 없습니다.`);
    const created = verifySaved(after, reviewed.baseline, planned, target);
    await journal.append({ phase: 'target-done', key, created });
    results.push({ ...target, created, skipped: [...reviewed.existing, ...reviewed.conflicts] });
  }
  return { targets: results };
}
