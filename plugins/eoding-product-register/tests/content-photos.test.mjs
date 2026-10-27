import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { validateContentPhotosPlan, readContentForm, buildContentPhotoSave, resolveContentPhotos, runContentPhotos, contentPhotosSummary } from '../src/content-photos.mjs';

const ORIGIN = 'https://basecamp.team', TOKEN = 'fixture-csrf', COMPANY = '361';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
const select = (name, options, value) => `<select id="id_${name}" name="${name}">${options.map(([v, text]) => `<option value="${v}"${v === value ? ' selected="selected"' : ''}>${text}</option>`).join('')}</select>`;
const text = (name, value, extra = '') => `<input autocomplete="off" id="id_${name}" name="${name}" type="text" value="${escape(value)}"${extra}>`;

/** Renders the content change form fragment the way the ERP returns /contents/<type>/<id>/change/. */
function renderForm(record, { extraField = false } = {}) {
  const f = record.fields;
  const typeFields = record.type === 'place'
    ? `<input type="hidden" name="spotpoi_id" id="id_spotpoi_id" label="">${text('spotpoi_name_ko', f.spotpoi_name_ko, ' readonly')}`
    : `${select('currency_code', [['1', 'KRW'], ['2', 'USD']], f.currency_code)}${text('adult_price', f.adult_price)}${select('payment', [['1', '현장결제'], ['2', '여행사결제']], f.payment)}
       ${select('accompany_guide_flag', [['True', 'Y'], ['False', 'N']], f.accompany_guide_flag)}${text('travel_time', f.travel_time)}${text('alternative_schedule', f.alternative_schedule)}`;
  const images = record.images.map(image => `<div class="image_list" data-type="old" data-id="${image.id}"><label class="check"><input type="checkbox" value="${image.id}" class="filled-in" id="image-old-${image.id}" name="old" /><span></span></label>
      <label class="image" for="image-old-${image.id}"><img src="${image.src}" ></label></div>`).join('');
  return `<div class="form"><div class="erp_cont_head"><h4>상세정보 수정</h4><div class="right_header"><button class="btn" id="save">저장</button></div></div>
    <form id="default" method="POST" enctype="multipart/form-data" style="width:100%">
      <input type="hidden" name="geo_lat" id="id_geo_lat" label=""><input type="hidden" name="geo_lng" id="id_geo_lng" label="">
      <input type="hidden" name="image_sort" id="id_image_sort" label="이미지">
      ${text('name_ko', f.name_ko)}${text('name', f.name)}
      <select data-init-id="${f.continent}" data-url="/destination/autocomplete/region/continent/" id="id_continent" name="continent" autocomplete disabled></select>
      <select data-init-id="${f.country}" data-url="/destination/autocomplete/region/country_in_continent/" id="id_country" name="country" autocomplete disabled></select>
      <select data-init-id="${f.city}" data-url="/destination/autocomplete/region/city_in_country/" id="id_city" name="city" autocomplete></select>
      ${select('use_flag', [['True', 'Y'], ['False', 'N']], f.use_flag)}${text('not_use_reason', f.not_use_reason)}
      ${text('address', f.address, ' maxlength="500"')}${text('location', f.location, ' readonly')}${text('homepage', f.homepage)}${text('keyword', f.keyword)}
      ${typeFields}
      <textarea name="description" id="id_description">\n${escape(f.description)}</textarea>
      ${extraField ? text('naver_ticket_code', '') : ''}
      <div class="m6  control" id="id_image_sort_container"><div class="image_area_header"><button type="button" class="btn dan" id="image_delete">선택삭제</button></div>
        <div id="contents_image_area" class="image_area flex">${images}</div></div>
    </form></div>`;
}

const common = { continent: '3', country: '40', city: '2786', use_flag: 'True', not_use_reason: '', address: '', location: '', homepage: '', keyword: '', geo_lat: '', geo_lng: '' };
const seed = () => ({
  'place/135511': { type: 'place', fields: { ...common, name_ko: '빅토리아 피크', name: 'Victoria Peak', spotpoi_id: '', spotpoi_name_ko: '', description: '소개\n홍콩의 가장 화려한 관광지입니다.\n\n피크 트램\n급경사를 오릅니다.' }, images: [] },
  'optionaltour/14645': { type: 'optionaltour', fields: { ...common, name_ko: '[예시] 심포니 오브 라이트 하버 크루즈', name: '', currency_code: '2', adult_price: '45', payment: '1', accompany_guide_flag: 'True', travel_time: '약 60분', alternative_schedule: '미참여 시 자유시간', description: '가상 선택관광입니다.' }, images: [] },
  'optionaltour/14652': { type: 'optionaltour', fields: { ...common, name_ko: '[예시] 홍콩 공항 라운지 이용', name: '', currency_code: '2', adult_price: '40', payment: '1', accompany_guide_flag: 'False', travel_time: '약 90분', alternative_schedule: '미참여 시 출국장 대기', description: '가상 라운지' }, images: [{ id: '2387671', src: `https://media.eoding.com/media/travelagent/${COMPANY}/imagecontent/lounge.jpg` }] }
});

async function fixture(t, { reject = false, extraField = false, mutateOnSave = false } = {}) {
  const browser = await chromium.launch({ headless: true, args: ['--host-resolver-rules=MAP * ~NOTFOUND'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  await context.addCookies([{ name: 'csrftoken', value: TOKEN, url: ORIGIN }]);
  const records = seed(), posts = [], uploads = [];
  let imageId = 2390000;
  await context.route(`${ORIGIN}/**`, async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname === '/contents/place/') return route.fulfill({ contentType: 'text/html', body: '<html><body>fixture list</body></html>' });
    if (url.pathname === '/contents/image/create_modal/' && request.method() === 'POST') {
      uploads.push(request.headers()['x-csrftoken']);
      const id = String(++imageId);
      return route.fulfill({ status: 201, json: { id, src: `https://media.eoding.com/media/travelagent/${COMPANY}/imagecontent/upload-${id}.jpg` } });
    }
    const change = /^\/contents\/(place|optionaltour)\/(\d+)\/change\/$/.exec(url.pathname);
    const record = change && records[`${change[1]}/${change[2]}`];
    if (record && request.method() === 'GET') return route.fulfill({ contentType: 'text/html', body: renderForm(record, { extraField }) });
    if (record && request.method() === 'POST') {
      const form = await new Response(request.postDataBuffer(), { headers: { 'content-type': request.headers()['content-type'] } }).formData();
      posts.push({ key: `${change[1]}/${change[2]}`, csrf: request.headers()['x-csrftoken'], entries: [...form.entries()] });
      if (reject || request.headers()['x-csrftoken'] !== TOKEN) return route.fulfill({ status: 400, json: { message: '가상 거절' } });
      const sort = JSON.parse(form.get('image_sort'));
      for (const [name, value] of form.entries()) if (name !== 'image_sort') record.fields[name] = value;
      if (mutateOnSave) record.fields.keyword = '서버가 바꾼 값';
      record.images = [...record.images.filter(image => sort.old.some(row => row.name === image.id)), ...sort.new.map(row => ({ id: row.name, src: `https://media.eoding.com/media/travelagent/${COMPANY}/imagecontent/upload-${row.name}.jpg` }))];
      return route.fulfill({ status: 200, json: { success: true } });
    }
    return route.abort();
  });
  const page = await context.newPage();
  await page.goto(`${ORIGIN}/contents/place/`);
  return { page, records, posts, uploads };
}

async function images(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'content-photos-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return Promise.all(['peak', 'harbour'].map(async (name, index) => {
    const bytes = Buffer.from(`fixture-jpeg-${name}`), file = path.join(dir, `${name}.jpg`);
    await writeFile(file, bytes);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    return { id: `image-${sha256.slice(0, 24)}`, sha256, path: file, name: `${name}.jpg`, mimeType: 'image/jpeg', alt: `가상 사진 ${index}` };
  }));
}

const memoryJournal = (rows = []) => ({ rows, append: async row => { rows.push(row); } });
const planFor = jobImages => validateContentPhotosPlan({ contents: [
  { type: 'place', contentId: '135511', name: '빅토리아 피크', images: [jobImages[0].id, jobImages[1].id] },
  { type: 'optionaltour', contentId: '14645', name: '[예시] 심포니 오브 라이트 하버 크루즈', images: [jobImages[1].id] },
  { type: 'optionaltour', contentId: '14652', name: '[예시] 홍콩 공항 라운지 이용', images: [jobImages[0].id] }
] }, { imageIds: new Set(jobImages.map(image => image.id)) });
const run = (f, plan, resolved, jobImages, journal) => runContentPhotos({ page: f.page, plan, resolved, images: jobImages, journal, assertIdentity: async () => {}, companyId: COMPANY });

test('content photos input is validated strictly against the job images', () => {
  const ids = new Set(['image-0123456789abcdef01234567']);
  const ok = { type: 'place', contentId: '135511', name: '빅토리아 피크', images: ['image-0123456789abcdef01234567'] };
  assert.deepEqual(validateContentPhotosPlan({ contents: [ok] }, { imageIds: ids }), { contents: [ok] });
  for (const [bad, message] of [
    [{ contents: [] }, /1~50개/],
    [{ contents: [{ ...ok, type: 'meal' }] }, /검증하지 않았습니다/],
    [{ contents: [{ ...ok, contentId: 'abc' }] }, /숫자 번호/],
    [{ contents: [{ ...ok, name: ' 빅토리아 피크' }] }, /명칭/],
    [{ contents: [{ ...ok, images: [] }] }, /1~10개/],
    [{ contents: [{ ...ok, images: ['image-ffffffffffffffffffffffff'] }] }, /수집한 이미지/],
    [{ contents: [ok, ok] }, /두 번/],
    [{ contents: [{ ...ok, description: 'x' }] }, /지원하지 않는/],
    [{ contents: [ok], extra: true }, /contents/]
  ]) assert.throws(() => validateContentPhotosPlan(bad, { imageIds: ids }), message);
});

test('the save resends every field as read and carries only the new photos in image_sort', async t => {
  const f = await fixture(t);
  const current = await readContentForm(f.page, { type: 'place', contentId: '135511', name: '빅토리아 피크' });
  assert.equal(current.fields.continent, '3', 'disabled region selects keep their saved value');
  assert.equal(current.fields.description, f.records['place/135511'].fields.description);
  const fields = buildContentPhotoSave(current, ['901', '902']);
  for (const [name, value] of Object.entries(current.baseline)) assert.equal(fields[name], value, name);
  assert.equal(fields.image_sort, '{"old":[],"new":[{"name":"901","value":0},{"name":"902","value":1}]}');
  const withPhotos = await readContentForm(f.page, { type: 'optionaltour', contentId: '14652', name: '[예시] 홍콩 공항 라운지 이용' });
  assert.deepEqual(withPhotos.images.map(image => image.id), ['2387671']);
  assert.throws(() => buildContentPhotoSave(withPhotos, ['901']), /이미 사진이 있는/);
});

test('review then register adds photos only to contents without any and verifies each by re-reading', async t => {
  const f = await fixture(t), jobImages = await images(t), plan = planFor(jobImages);
  const before = structuredClone(f.records);
  const resolved = await resolveContentPhotos(f.page, plan);
  assert.deepEqual(resolved.contents.map(row => [row.key, row.action]), [['place:135511', 'add'], ['optionaltour:14645', 'add'], ['optionaltour:14652', 'has-photos']]);
  assert.match(contentPhotosSummary(plan, resolved).join('\n'), /관광지 빅토리아 피크\(135511\): 사진 2장 추가[\s\S]*이미 사진 1장이 있어 건너뜀/);
  const journal = memoryJournal();
  const results = await run(f, plan, resolved, jobImages, journal);
  assert.equal(f.posts.length, 2);
  assert.ok(f.posts.every(post => post.csrf === TOKEN));
  assert.equal(f.uploads.length, 2, 'the same photo bytes are uploaded once and reused');
  assert.deepEqual(results.map(row => [row.contentId, row.status, row.photos.length]), [['135511', 'added', 2], ['14645', 'added', 1], ['14652', 'skipped-has-photos', 0]]);
  assert.deepEqual(results[1].photos, [results[0].photos[1]]);
  for (const key of ['place/135511', 'optionaltour/14645']) {
    const { description, ...rest } = f.records[key].fields, { description: was, ...restBefore } = before[key].fields;
    assert.deepEqual(rest, restBefore, key);
    assert.equal(description.replace(/\r\n/g, '\n'), was);
  }
  assert.deepEqual(f.records['optionaltour/14652'], before['optionaltour/14652'], 'a content with photos is never posted');
  const again = await run(f, plan, resolved, jobImages, journal);
  assert.equal(f.posts.length, 2, 'a finished content is never saved twice');
  assert.deepEqual(again.map(row => row.status), ['added', 'added', 'skipped-has-photos']);
});

test('a name that does not match the content number stops the review', async t => {
  const f = await fixture(t), jobImages = await images(t);
  const plan = validateContentPhotosPlan({ contents: [{ type: 'place', contentId: '135511', name: '소호 거리', images: [jobImages[0].id] }] }, { imageIds: new Set(jobImages.map(image => image.id)) });
  await assert.rejects(resolveContentPhotos(f.page, plan), /저장된 이름은 "빅토리아 피크"/);
});

test('an unknown field in the ERP change form stops before any write', async t => {
  const f = await fixture(t, { extraField: true }), jobImages = await images(t);
  await assert.rejects(resolveContentPhotos(f.page, planFor(jobImages)), /형식과 다릅니다/);
  assert.equal(f.posts.length + f.uploads.length, 0);
});

test('a change in ERP after review blocks the save', async t => {
  const f = await fixture(t), jobImages = await images(t), plan = planFor(jobImages);
  const resolved = await resolveContentPhotos(f.page, plan);
  f.records['place/135511'].fields.keyword = '다른 사람이 고침';
  await assert.rejects(run(f, plan, resolved, jobImages, memoryJournal()), /검토 뒤에 바뀌었습니다/);
  assert.equal(f.posts.length + f.uploads.length, 0);
});

test('a rejected save that left ERP unchanged fails clearly after one attempt and is not retried', async t => {
  const f = await fixture(t, { reject: true }), jobImages = await images(t), plan = planFor(jobImages);
  const resolved = await resolveContentPhotos(f.page, plan), journal = memoryJournal();
  await assert.rejects(run(f, plan, resolved, jobImages, journal), /거절됐습니다\(400\)/);
  assert.equal(f.posts.length, 1);
  await assert.rejects(run(f, plan, resolved, jobImages, journal), /자동으로 다시 저장하지 않습니다/);
  assert.equal(f.posts.length, 1);
  assert.equal(f.uploads.length, 2, 'uploads already made are not repeated');
});

test('an attempted save whose result is already in ERP is reconciled without posting again', async t => {
  const f = await fixture(t), jobImages = await images(t), plan = planFor(jobImages);
  const resolved = await resolveContentPhotos(f.page, plan), first = memoryJournal();
  await run(f, plan, resolved, jobImages, first);
  const lostResponse = memoryJournal(first.rows.filter(row => ['image', 'photos-attempt'].includes(row.phase)));
  const results = await run(f, plan, resolved, jobImages, lostResponse);
  assert.equal(f.posts.length, 2);
  assert.deepEqual(results.map(row => row.status), ['added', 'added', 'skipped-has-photos']);
  assert.equal(lostResponse.rows.filter(row => row.reconciled).length, 2);
});

test('a save that changed another field fails the re-read', async t => {
  const f = await fixture(t, { mutateOnSave: true }), jobImages = await images(t), plan = planFor(jobImages);
  const resolved = await resolveContentPhotos(f.page, plan);
  await assert.rejects(run(f, plan, resolved, jobImages, memoryJournal()), /사진 외의 항목이 바뀌었습니다/);
  assert.equal(f.posts.length, 1);
});
