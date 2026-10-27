// Photos for existing ERP contents (관광지·선택관광) that have none yet. The native change form
// (/contents/<type>/<id>/change/) lists saved photos as `.image_list[data-type="old"]` and posts its
// fields with `image_sort` = {old:[...], new:[...]}. This flow only touches contents with zero photos,
// so `old` is always empty and the payload matches the add form's verified shape: every other field is
// sent back exactly as read, one guarded POST per content, then an independent re-read must show the
// other fields untouched and exactly the planned photos in order.
import { uploadImage } from './fit-execution.mjs';

const fail = message => { throw new Error(message); };
const ID = /^[1-9][0-9]{0,12}$/;
const IMAGE_ID = /^image-[0-9a-f]{24}$/;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

/** Content types whose change form was read from the live ERP; others are refused until verified. */
const COMMON_FIELDS = ['image_sort', 'name_ko', 'name', 'continent', 'country', 'city', 'use_flag', 'not_use_reason', 'description', 'keyword', 'geo_lat', 'geo_lng', 'address', 'location', 'homepage'];
export const PHOTO_CONTENT_TYPES = Object.freeze({
  place: { label: '관광지', path: 'place', fields: [...COMMON_FIELDS, 'spotpoi_id', 'spotpoi_name_ko'] },
  optionaltour: { label: '선택관광', path: 'optionaltour', fields: [...COMMON_FIELDS, 'currency_code', 'adult_price', 'payment', 'accompany_guide_flag', 'travel_time', 'alternative_schedule'] }
});
const MAX_CONTENTS = 50, MAX_PHOTOS = 10;

export const contentChangeUrl = ({ type, contentId }) => `/contents/${PHOTO_CONTENT_TYPES[type].path}/${contentId}/change/`;
const keyOf = item => `${item.type}:${item.contentId}`;
const label = item => `${PHOTO_CONTENT_TYPES[item.type].label} ${item.name}(${item.contentId})`;

/**
 * Validates `{contents:[{type, contentId, name, images[]}]}`. `name` must equal the saved 명칭(한글) so a
 * mistyped number never puts photos on another record; `images` are this job's collected image IDs.
 */
export function validateContentPhotosPlan(input, { imageIds = new Set() } = {}) {
  if (!plainObject(input) || Object.keys(input).some(key => key !== 'contents')) fail('contentPhotos 입력은 {contents:[...]}만 받습니다.');
  if (!Array.isArray(input.contents) || input.contents.length < 1 || input.contents.length > MAX_CONTENTS) fail(`contents는 1~${MAX_CONTENTS}개 배열입니다.`);
  const contents = input.contents.map((item, index) => {
    const where = `contents[${index}]`;
    if (!plainObject(item)) fail(`${where}는 객체여야 합니다.`);
    const unknown = Object.keys(item).filter(key => !['type', 'contentId', 'name', 'images'].includes(key));
    if (unknown.length) fail(`${where}에 지원하지 않는 항목이 있습니다: ${unknown.join(', ')}`);
    if (!Object.hasOwn(PHOTO_CONTENT_TYPES, item.type)) fail(`${where}.type은 ${Object.keys(PHOTO_CONTENT_TYPES).join('/')} 중 하나입니다. 다른 종류는 아직 ERP 수정 화면을 검증하지 않았습니다.`);
    const contentId = String(item.contentId ?? '');
    if (!ID.test(contentId)) fail(`${where}.contentId는 ERP 콘텐츠 숫자 번호입니다.`);
    if (typeof item.name !== 'string' || !item.name.trim() || item.name !== item.name.trim() || item.name.length > 100) fail(`${where}.name은 ERP에 저장된 명칭(한글) 그대로여야 합니다.`);
    if (!Array.isArray(item.images) || item.images.length < 1 || item.images.length > MAX_PHOTOS || new Set(item.images).size !== item.images.length) fail(`${where}.images는 중복 없는 1~${MAX_PHOTOS}개 이미지 ID입니다.`);
    for (const id of item.images) if (!IMAGE_ID.test(id) || !imageIds.has(id)) fail(`${where}.images의 ${id}는 이 작업에서 수집한 이미지 ID가 아닙니다.`);
    return { type: item.type, contentId, name: item.name, images: [...item.images] };
  });
  if (new Set(contents.map(keyOf)).size !== contents.length) fail('같은 콘텐츠가 두 번 있습니다.');
  return { contents };
}

/**
 * Reads the change form (read-only GET): every named field as the save would send it (region
 * autocompletes carry their saved value in data-init-id) and the saved photos in display order.
 */
export async function readContentForm(page, item) {
  const state = await page.evaluate(async url => {
    const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (response.status !== 200) throw new Error(`ERP 콘텐츠 조회 실패 ${response.status}: ${url}`);
    const doc = new DOMParser().parseFromString(await response.text(), 'text/html');
    const forms = doc.querySelectorAll('form#default');
    if (forms.length !== 1) throw new Error('ERP 콘텐츠 수정 폼을 정확히 하나 찾지 못했습니다.');
    const form = forms[0], fields = [];
    for (const element of form.querySelectorAll('input, select, textarea')) {
      if (!element.name) continue;
      // Photo selection checkboxes (name="old") only drive the 선택삭제 button.
      if (element.tagName === 'INPUT' && ['checkbox', 'radio'].includes(element.type)) { if (element.name !== 'old') fields.push([element.name, element.checked ? element.value || 'on' : null]); continue; }
      if (element.tagName === 'INPUT' && ['file', 'submit', 'button', 'image', 'reset'].includes(element.type)) { fields.push([element.name, null]); continue; }
      if (element.tagName === 'SELECT') {
        if (element.hasAttribute('data-init-id')) { fields.push([element.name, element.getAttribute('data-init-id')]); continue; }
        const chosen = [...element.options].find(option => option.selected) ?? element.options[0];
        fields.push([element.name, chosen ? chosen.value : '']); continue;
      }
      fields.push([element.name, element.value]);
    }
    const areas = doc.querySelectorAll('#contents_image_area');
    const images = areas.length === 1 ? [...areas[0].querySelectorAll('.image_list')].map(node => ({ type: node.getAttribute('data-type'), id: node.getAttribute('data-id'), src: node.querySelector('img')?.getAttribute('src') ?? '' })) : null;
    return { fields, images };
  }, contentChangeUrl(item));
  const names = state.fields.map(([name]) => name);
  const expected = PHOTO_CONTENT_TYPES[item.type].fields;
  if (new Set(names).size !== names.length || !same([...names].sort(), [...expected].sort()) || state.fields.some(([, value]) => value === null)) fail(`${label(item)} 수정 화면이 이 기능이 아는 형식과 다릅니다. 플러그인을 업데이트하거나 ERP에서 직접 입력하세요.`);
  if (!state.images) fail(`${label(item)} 수정 화면의 이미지 영역을 정확히 하나 찾지 못했습니다.`);
  // Multipart encoding sends CRLF and the form reads it back as LF; compare and resend as LF.
  const entries = state.fields.map(([name, value]) => [name, value.replace(/\r\n?/g, '\n')]);
  const fields = Object.fromEntries(entries);
  return { fields, baseline: Object.fromEntries(entries.filter(([name]) => name !== 'image_sort')), images: state.images };
}

/** The exact multipart entries for one save: fields as read, with image_sort carrying only new photos. */
export function buildContentPhotoSave(current, erpImageIds) {
  if (current.images.length) fail('이미 사진이 있는 콘텐츠에는 덧붙이지 않습니다.');
  if (!erpImageIds.length || erpImageIds.some(id => !ID.test(id))) fail('덧붙일 ERP 이미지 번호가 없습니다.');
  return { ...current.baseline, image_sort: JSON.stringify({ old: [], new: erpImageIds.map((name, value) => ({ name, value })) }) };
}

async function postContentForm(page, url, fields) {
  return page.evaluate(async ({ url, fields }) => {
    const token = document.cookie.split('; ').find(item => item.startsWith('csrftoken='))?.slice(10) ?? '';
    const body = new FormData();
    for (const [name, value] of Object.entries(fields)) body.append(name, value);
    const response = await fetch(url, { method: 'POST', credentials: 'same-origin', redirect: 'manual', headers: { 'X-CSRFToken': token, 'X-Requested-With': 'XMLHttpRequest' }, body });
    return { status: response.status, type: response.type };
  }, { url, fields });
}

/** Read-only review: each content's saved name, use state and photo count; contents with photos are skipped. */
export async function resolveContentPhotos(page, plan) {
  const contents = [];
  for (const item of plan.contents) {
    const current = await readContentForm(page, item);
    if (current.fields.name_ko !== item.name) fail(`${PHOTO_CONTENT_TYPES[item.type].label} ${item.contentId}의 저장된 이름은 "${current.fields.name_ko}"입니다. 번호와 이름을 확인하세요.`);
    if (current.fields.use_flag !== 'True') fail(`${label(item)}은 사용 안 함 상태입니다. ERP에서 확인하세요.`);
    contents.push({ key: keyOf(item), type: item.type, contentId: item.contentId, name: item.name, action: current.images.length ? 'has-photos' : 'add', existingPhotos: current.images.length, baseline: current.baseline });
  }
  return { contents };
}

export function contentPhotosSummary(plan, resolved) {
  const byKey = new Map(plan.contents.map(item => [keyOf(item), item]));
  return resolved.contents.map(row => row.action === 'add'
    ? `${label(row)}: 사진 ${byKey.get(row.key).images.length}장 추가`
    : `${label(row)}: 이미 사진 ${row.existingPhotos}장이 있어 건너뜀(기존 사진은 바꾸지 않음)`);
}

/** The re-read must show the other fields untouched and exactly the planned photos, in order. */
function verifySaved(after, reviewed, erpImageIds, companyId) {
  if (!same(after.baseline, reviewed.baseline)) fail(`${label(reviewed)} 저장 뒤 사진 외의 항목이 바뀌었습니다. ERP에서 확인하세요.`);
  const prefix = `https://media.eoding.com/media/travelagent/${companyId}/`;
  if (!same(after.images.map(image => [image.type, image.id]), erpImageIds.map(id => ['old', id])) || after.images.some(image => !image.src.startsWith(prefix))) fail(`${label(reviewed)} 저장 뒤 사진이 계획(${erpImageIds.join(', ')})과 다릅니다.`);
}

/**
 * Uploads and attaches photos content by content. A re-run reconciles from the journal: uploads are
 * reused by bytes, and a content whose save was attempted is accepted only when the re-read already
 * shows the exact planned photos; otherwise it stops without saving again.
 */
export async function runContentPhotos({ page, plan, resolved, images, journal, assertIdentity, companyId, progress = () => {} }) {
  const byId = new Map(images.map(image => [image.id, image]));
  const uploaded = new Map(journal.rows.filter(row => row.phase === 'image').map(row => [row.sha256, row.erpId]));
  const byKey = new Map(plan.contents.map(item => [keyOf(item), item]));
  const results = [];
  for (const reviewed of resolved.contents) {
    const item = byKey.get(reviewed.key) ?? fail(`검토한 ${reviewed.key}가 계획에 없습니다.`);
    const base = { type: item.type, contentId: item.contentId, name: item.name };
    if (reviewed.action === 'has-photos') { results.push({ ...base, status: 'skipped-has-photos', photos: [] }); continue; }
    const done = journal.rows.find(row => row.phase === 'photos-done' && row.key === reviewed.key);
    if (done) { results.push({ ...base, status: 'added', photos: done.photos }); continue; }
    progress(`${PHOTO_CONTENT_TYPES[item.type].label}:${item.name}`);
    await assertIdentity();
    const current = await readContentForm(page, item);
    const attempt = journal.rows.findLast(row => row.phase === 'photos-attempt' && row.key === reviewed.key);
    if (attempt) {
      try { verifySaved(current, reviewed, attempt.photos, companyId); }
      catch (error) { fail(`${label(item)} 사진 저장을 시도한 기록이 있지만 재조회 결과가 계획과 다릅니다(${error.message}). 자동으로 다시 저장하지 않습니다. ERP에서 확인한 뒤 새 작업으로 진행하세요.`); }
      await journal.append({ phase: 'photos-done', key: reviewed.key, photos: attempt.photos, reconciled: true });
      results.push({ ...base, status: 'added', photos: attempt.photos });
      continue;
    }
    if (!same(current.baseline, reviewed.baseline) || current.images.length) fail(`${label(item)}이 검토 뒤에 바뀌었습니다. 다시 검토하세요.`);
    const erpImages = [];
    for (const id of item.images) {
      const image = byId.get(id) ?? fail(`이미지 ${id}가 작업에 없습니다.`);
      if (!uploaded.has(image.sha256)) {
        await assertIdentity();
        const result = await uploadImage(page, image, image.alt);
        if (result.status !== 201) fail(`이미지 업로드 응답이 ${result.status}입니다: ${id}`);
        const body = JSON.parse(result.text), erpId = String(body.id ?? '');
        if (!ID.test(erpId) || !String(body.src ?? '').startsWith(`https://media.eoding.com/media/travelagent/${companyId}/`)) fail('이미지 업로드 영수증이 이 회사의 이미지가 아닙니다.');
        await journal.append({ phase: 'image', imageId: id, sha256: image.sha256, erpId, src: body.src }); uploaded.set(image.sha256, erpId);
      }
      erpImages.push(uploaded.get(image.sha256));
    }
    if (new Set(erpImages).size !== erpImages.length) fail(`${label(item)}에 같은 사진이 두 번 들어갑니다.`);
    const fields = buildContentPhotoSave(current, erpImages);
    await assertIdentity();
    await journal.append({ phase: 'photos-attempt', key: reviewed.key, photos: erpImages });
    const response = await postContentForm(page, contentChangeUrl(item), fields);
    await journal.append({ phase: 'photos-response', key: reviewed.key, status: response.status, type: response.type });
    const after = await readContentForm(page, item);
    await assertIdentity();
    const accepted = (response.status >= 200 && response.status < 300) || response.type === 'opaqueredirect';
    if (!accepted && same(after.baseline, reviewed.baseline) && !after.images.length) fail(`${label(item)} 사진 저장이 거절됐습니다(${response.status}). ERP에는 바뀐 것이 없습니다.`);
    verifySaved(after, reviewed, erpImages, companyId);
    await journal.append({ phase: 'photos-done', key: reviewed.key, photos: erpImages });
    results.push({ ...base, status: 'added', photos: erpImages });
  }
  return results;
}
