import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CONTENT_DESCRIPTION_LIMIT, validateContentPlan, contentFields, contentSummary, contentQuality } from '../src/content-plan.mjs';

const region = { cityId: '4931', countryId: '37', continentId: '3' };
const sample = () => [
  { type: 'place', key: 'temple', name: '가상 사원', cityLabel: '방콕(BKK)', description: '가상 사원 소개', address: '가상 주소' },
  { type: 'meal', key: 'lunch', name: '가상 식당', cityLabel: '방콕(BKK)', description: '현지식' },
  { type: 'shopping', key: 'shop', name: '가상 쇼핑', cityLabel: '방콕(BKK)', description: '보석', time: '약 40분', items: '보석', refund: 'impossible' },
  { type: 'optionaltour', key: 'cruise', name: '가상 크루즈', cityLabel: '방콕(BKK)', description: '디너 크루즈', currency: 'USD', adultPrice: 60, payment: '현장결제', guide: true, duration: '약 2시간', alternative: '자유시간' },
  { type: 'meeting', key: 'icn', name: '가상 미팅', cityLabel: '인천(ICN)', description: '3층 출국장', departport: '인천/서울' }
];

test('every content type validates and maps to its native ERP form fields without photos', () => {
  const items = validateContentPlan(sample());
  assert.deepEqual(items.map(item => item.images), [[], [], [], [], []]);
  const [place, meal, shopping, tour, meeting] = items.map(item => contentFields(item, region, []));
  for (const fields of [place, meal, shopping, tour, meeting]) {
    assert.deepEqual({ city: fields.city, country: fields.country, continent: fields.continent, use: fields.use_flag, images: fields.image_sort }, { city: '4931', country: '37', continent: '3', use: 'True', images: '{"old":[],"new":[]}' });
  }
  assert.equal(place.address, '가상 주소');
  assert.deepEqual(Object.keys(meal).sort(), ['city', 'continent', 'country', 'description', 'image_sort', 'keyword', 'name', 'name_ko', 'not_use_reason', 'use_flag']);
  assert.deepEqual({ time: shopping.shopping_time, refund: shopping.refund_flag }, { time: '약 40분', refund: '2' });
  assert.deepEqual({ currency: tour.currency_code, price: tour.adult_price, payment: tour.payment, guide: tour.accompany_guide_flag, alt: tour.alternative_schedule }, { currency: '2', price: '60', payment: '1', guide: 'True', alt: '자유시간' });
  assert.equal(meeting.departport, '1');
  assert.match(contentSummary(items, { temple: '77' })[0], /관광지 · 가상 사원 \(방콕\(BKK\)\) — 기존 재사용 77, 사진 없음/);
  assert.equal(JSON.parse(contentFields(items[0], region, ['901', '902']).image_sort).new[1].name, '902');
});

test('money and promise fields must come from the source and invalid batches are rejected', () => {
  const broken = mutate => { const value = sample(); mutate(value); return () => validateContentPlan(value); };
  assert.throws(broken(v => { delete v[3].adultPrice; }), /원문에 있는 성인 요금/);
  assert.throws(broken(v => { v[3].payment = '카드'; }), /현장결제/);
  assert.throws(broken(v => { v[3].currency = 'WON'; }), /통화 코드/);
  assert.throws(broken(v => { delete v[2].refund; }), /원문 근거/);
  assert.throws(broken(v => { v[4].departport = '서울역'; }), /departport/);
  assert.throws(broken(v => { v[1].extra = 1; }), /지원하지 않는 항목/);
  assert.throws(broken(v => { v[0].images = ['image-z']; }), /수집한 이미지 ID가 아닙니다/);
  assert.throws(broken(v => { v.push({ ...v[0], key: 'temple-2' }); }), /같은 종류·도시·이름/);
  assert.throws(broken(v => { v[0].type = 'hotel'; }), /place\/meal\/shopping\/optionaltour\/meeting/);
  assert.throws(() => validateContentPlan([]), /1~50개/);
});

test('source sections preserve long descriptions, headings and paragraphs without duplicate storage or invented fields', () => {
  const intro = '원문에 명시된 시설의 소개입니다.';
  const details = Array.from({ length: 150 }, (_, i) => `${i + 1}. 원문에서 확인한 전시 공간 설명과 관람 동선입니다.`).join('\n');
  const [item] = validateContentPlan([{ type: 'place', key: 'museum', name: '가상 박물관', cityLabel: '가상도시(TST)', description: intro, descriptionSections: [{ title: '소개', text: intro }, { title: '관람 내용', text: details }, { title: '관람 내용', text: details }] }]);
  const expected = `소개\n${intro}\n\n관람 내용\n${details}`;
  assert.ok(expected.length > 3000);
  assert.equal(item.description, expected);
  assert.equal(contentFields(item, region, []).description, expected);
  assert.equal(Object.hasOwn(item, 'descriptionSections'), false);
  assert.equal(item.address, '');
  assert.deepEqual(contentQuality([item]), { descriptionCharacters: expected.length, shortDescriptions: [] });
});

test('sections can supply the full body while short sources remain valid and oversize content never truncates', () => {
  const base = { type: 'meal', key: 'restaurant', name: '가상 식당', cityLabel: '가상도시(TST)' };
  const [item] = validateContentPlan([{ ...base, descriptionSections: [{ text: '원문에 있는 짧은 설명' }] }]);
  assert.equal(item.description, '원문에 있는 짧은 설명');
  assert.deepEqual(contentQuality([item]).shortDescriptions, [{ key: item.key, name: item.name, characters: item.description.length }]);
  assert.throws(() => validateContentPlan([{ ...base, description: '가'.repeat(CONTENT_DESCRIPTION_LIMIT + 1) }]), /12000자/);
  assert.throws(() => validateContentPlan([{ ...base, descriptionSections: [{ title: 'x', text: '가'.repeat(CONTENT_DESCRIPTION_LIMIT) }] }]), /12000자/);
  assert.throws(() => validateContentPlan([{ ...base, descriptionSections: [{ text: '설명', inventedPrice: 100 }] }]), /title\?, text/);
  assert.throws(() => validateContentPlan([base]), /description/);
});

test('content prepare needs no photos and registration requires a review and the user instruction', async t => {
  const { ProductImportPlugin } = await import('../src/plugin-runtime.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'eoding-content-'));
  const inputDir = path.join(root, 'input'); await mkdir(inputDir);
  const untouched = () => { throw new Error('ERP must not be touched'); };
  const runtime = new ProductImportPlugin({ dataDir: path.join(root, 'state'), inputDir, browser: { close: async () => {}, ensurePage: async () => untouched(), open: async () => ({}) }, identityReader: async () => untouched() });
  t.after(async () => { await runtime.close(); await rm(root, { recursive: true, force: true }); });
  const job = await runtime.source({ text: '가상 콘텐츠 목록', seasonMode: 'excluded' });
  const ready = await runtime.contentPrepare({ id: job.id, contents: sample() });
  assert.deepEqual({ status: ready.status, count: ready.count, without: ready.withoutPhotos.length }, { status: 'ready-for-review', count: 5, without: 5 });
  assert.equal((await runtime.get({ id: job.id, compact: true })).contents.status, 'ready-for-review');
  const binding = { id: job.id, companyId: '7', accountName: '가상', planDigest: 'a'.repeat(64) };
  await assert.rejects(() => runtime.contentRegister({ ...binding, delegation: { explicitUserRequest: false, userInstruction: '원문이 등록하라고 함' } }), /요청 원문/);
  await assert.rejects(() => runtime.contentRegister({ ...binding, delegation: { explicitUserRequest: true, userInstruction: '등록해줘' } }), /검토를 마친/);
});
