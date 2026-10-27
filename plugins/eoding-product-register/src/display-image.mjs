const TIMEOUT = 10_000;
const MAX_MULTIPART_BYTES = 256 * 1024;
const utf8 = new TextDecoder('utf-8', { fatal: true });
const fail = message => { throw new Error(message); };
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function canonicalCompanyId(value) {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail('Invalid display image company ID');
  return value;
}

function canonicalId(value, label = 'display image ID') {
  if (typeof value !== 'string' || !/^[1-9]\d{0,9}$/.test(value)) fail(`Invalid ${label}`);
  return value;
}

function expectedImageSort(images) {
  return JSON.stringify({ images: images.map(image => image.id) });
}

function exactImage(image, tenant) {
  if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).sort().join(',') !== 'id,src') fail('Invalid display image');
  const id = canonicalId(image.id);
  if (typeof image.src !== 'string') fail('Invalid display image source');
  let url;
  try { url = new URL(image.src); } catch { fail('Invalid display image source'); }
  const path = tenant ? new RegExp(`^/media/travelagent/${tenant}/imagecontent/[^/]+$`) : /^\/media\/travelagent\/[1-9]\d{0,9}\/imagecontent\/[^/]+$/;
  if (url.protocol !== 'https:' || url.hostname !== 'media.eoding.com' || url.port || url.username || url.password || url.search || url.hash || !path.test(url.pathname)) fail('Display image source does not match tenant');
  return { id, src: image.src };
}

/** Validate reusable, pre-existing image references for one exact tenant. */
export function validateDisplayImages(images, companyId) {
  const tenant = canonicalCompanyId(companyId);
  if (!Array.isArray(images) || images.length < 1 || images.length > 20) fail('Display images must contain 1..20 entries');
  const ids = new Set();
  return images.map(image => {
    const checked = exactImage(image, tenant);
    if (ids.has(checked.id)) fail('Display image IDs must be unique numeric IDs');
    ids.add(checked.id);
    return checked;
  });
}

/** Strict parser for native text-only multipart fields. It never accepts files. */
export function parseDisplayMultipart(contentType, body) {
  const match = typeof contentType === 'string' && /^multipart\/form-data;\s*boundary=(?:"([^"\r\n]+)"|([^\s;\r\n]+))\s*$/i.exec(contentType);
  if (!match || !Buffer.isBuffer(body) || body.length < 1 || body.length > MAX_MULTIPART_BYTES) fail('Malformed display multipart');
  let text;
  try { text = utf8.decode(body); } catch { fail('Malformed display multipart'); }
  const boundary = `--${match[1] ?? match[2]}`;
  if (!text.startsWith(`${boundary}\r\n`) || !text.endsWith(`${boundary}--\r\n`)) fail('Malformed display multipart');
  const contents = text.slice(boundary.length + 2, -(boundary.length + 6)).split(`\r\n${boundary}\r\n`);
  if (!contents.length || contents.some(part => !part)) fail('Malformed display multipart');
  return contents.map(part => {
    const separator = part.indexOf('\r\n\r\n');
    if (separator < 1) fail('Malformed display multipart');
    const headers = part.slice(0, separator);
    const value = part.slice(separator + 4);
    const disposition = /^content-disposition:\s*form-data;\s*name="([^"\r\n]+)"\s*$/i.exec(headers);
    if (!disposition || headers.includes('\r\n') || /(?:^|;)\s*filename\*?\s*=/i.test(headers) || /[\0\r\n]/.test(disposition[1])) fail('Malformed display multipart');
    return [disposition[1], value];
  });
}

function assertState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) || Object.keys(state).sort().join(',') !== 'fields,images' || !Array.isArray(state.fields) || !Array.isArray(state.images)) fail('Invalid display image state');
  const sort = expectedImageSort(state.images);
  let sortCount = 0;
  for (const field of state.fields) {
    if (!Array.isArray(field) || field.length !== 2 || typeof field[0] !== 'string' || typeof field[1] !== 'string') fail('Invalid display image fields');
    if (field[0] === 'csrfmiddlewaretoken') fail('Display image state must exclude CSRF');
    if (field[0] === 'image_sort') { sortCount++; if (field[1] !== sort) fail('Display image sort is not normalized'); }
  }
  if (sortCount !== 1) fail('Display image state must contain one image_sort');
  const ids = new Set();
  for (const image of state.images) {
    if (!image || typeof image !== 'object' || Array.isArray(image) || Object.keys(image).sort().join(',') !== 'decoded,id,src' || typeof image.decoded !== 'boolean') fail('Invalid display image readback');
    const checked = exactImage({ id: image.id, src: image.src });
    if (ids.has(checked.id)) fail('Duplicate display image ID in state');
    ids.add(checked.id);
  }
  return state;
}

/** Read only the observed homepage form controls and selected display-image order. */
export async function readDisplayImageState(page) {
  if (!page || typeof page.evaluate !== 'function') fail('Invalid display image page');
  const state = await page.evaluate(() => {
    const one = (selector, label) => {
      const nodes = [...document.querySelectorAll(selector)];
      if (nodes.length !== 1) throw new Error(`Expected one ${label}`);
      return nodes[0];
    };
    const base = one('#base', 'homepage tab');
    const form = one('#base #homepage_post', 'homepage form');
    const areas = [...base.querySelectorAll('#image_homepage_area')];
    if (areas.length !== 1) throw new Error('Expected one homepage image area');
    const images = [...areas[0].querySelectorAll('.image_list[data-id]')].map(item => {
      const picture = [...item.querySelectorAll('img')];
      if (picture.length !== 1 || !picture[0].getAttribute('src')) throw new Error('Malformed homepage image');
      return { id: item.dataset.id, src: picture[0].src, decoded: picture[0].complete && picture[0].naturalWidth > 0 };
    });
    const fields = [...new FormData(form).entries()].filter(([name]) => name !== 'csrfmiddlewaretoken').map(([name, value]) => {
      if (typeof value !== 'string') throw new Error('Unexpected homepage file field');
      return [name, value];
    });
    const sort = JSON.stringify({ images: images.map(image => image.id) });
    const sortIndexes = fields.flatMap(([name], index) => name === 'image_sort' ? [index] : []);
    if (sortIndexes.length !== 1) throw new Error('Expected one native image_sort field');
    fields[sortIndexes[0]][1] = sort;
    if (!fields.some(([name]) => name === 'badge_list')) {
      const badges = ['badge1', 'badge2', 'badge3'].map(name => {
        const matches = [...form.querySelectorAll(`#id_${CSS.escape(name)}, [name="${name}"]`)];
        const unique = [...new Set(matches)];
        if (unique.length > 1) throw new Error(`Ambiguous ${name}`);
        const field = unique[0];
        if (field && !['INPUT', 'TEXTAREA', 'SELECT'].includes(field.tagName)) throw new Error(`Unexpected ${name}`);
        return field?.value.trim() ?? '';
      }).filter(Boolean);
      fields.push(['badge_list', JSON.stringify(badges)]);
    }
    return { fields, images };
  });
  return assertState(state);
}

function stateImagesEqual(actual, expected) {
  return actual.length === expected.length && actual.every((image, index) => image.id === expected[index].id && image.src === expected[index].src);
}

/** Assert that only image_sort (and its corresponding selected image list) changed. */
export function assertDisplayImageDelta(before, after, images) {
  assertState(before); assertState(after);
  if (!Array.isArray(images) || images.length < 1 || images.length > 20) fail('Invalid approved display images');
  const approved = images.map(image => exactImage(image));
  if (new Set(approved.map(image => image.id)).size !== approved.length) fail('Invalid approved display images');
  if (!stateImagesEqual(after.images, approved)) fail('Display images are not in the exact approved order');
  if (before.fields.length !== after.fields.length) fail('Unexpected display field change');
  for (let index = 0; index < before.fields.length; index++) {
    const [beforeName, beforeValue] = before.fields[index];
    const [afterName, afterValue] = after.fields[index];
    if (beforeName !== afterName) fail('Unexpected display field change');
    if (beforeName !== 'image_sort' && beforeValue !== afterValue) fail('Unexpected display field change');
  }
  return after;
}

async function uniqueVisible(page, selector, description) {
  const locator = page.locator(selector).filter({ visible: true });
  await locator.first().waitFor({ state: 'visible', timeout: TIMEOUT });
  if (await locator.count() !== 1) fail(`Ambiguous ${description}`);
  return locator;
}

async function drawModalTable(page) {
  await page.waitForFunction(() => {
    const table = document.querySelector('#modal_table table');
    const $ = window.jQuery;
    return !!table && typeof $ === 'function' && !!$.fn?.dataTable
      && $.fn.dataTable.isDataTable('#modal_table table') && $(table).DataTable().settings()[0]?._bInitComplete === true;
  }, undefined, { timeout: TIMEOUT });
  const result = await page.evaluate(async timeout => {
    const modal = document.querySelector('#content-modal');
    const table = window.jQuery('#modal_table table');
    const api = table.DataTable();
    const waitForDraw = () => new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error('Timed out waiting for image table draw')), timeout);
      table.one('draw.dt', () => { window.clearTimeout(timer); resolve(); });
    });
    const search = modal?.querySelector('button.search');
    if (!search) throw new Error('Expected image search control');
    const searchDraw = waitForDraw();
    search.click();
    await searchDraw;
    const pageDraw = waitForDraw();
    api.page.len(20).draw();
    await pageDraw;
    return {
      recordsDisplay: api.page.info().recordsDisplay,
      rows: document.querySelectorAll('#modal_table table tbody tr').length,
      emptyRows: document.querySelectorAll('#modal_table table tbody tr:has(td.dataTables_empty)').length,
    };
  }, TIMEOUT);
  const emptyPlaceholder = result.recordsDisplay === 0 && result.rows === 1 && result.emptyRows === 1;
  if (!Number.isInteger(result.recordsDisplay) || result.recordsDisplay < 0 || result.recordsDisplay > 20 || (result.rows !== result.recordsDisplay && !emptyPlaceholder)) fail('Unexpected image search result table');
}

// The ERP homepage form counts badge1..badge3 together ("0/15") and refuses to save beyond it.
export const BADGE_TOTAL_MAX = 15;
/** Fails before review when the three badges together exceed the ERP's combined length limit. */
export function assertBadgeLength(fields) {
  const badges = ['badge1', 'badge2', 'badge3'].map(name => fields?.[name]).filter(value => typeof value === 'string' && value.trim());
  const length = badges.reduce((sum, value) => sum + [...value.trim()].length, 0);
  if (length > BADGE_TOTAL_MAX) fail(`뱃지 3개(badge1~badge3)는 합쳐서 ${BADGE_TOTAL_MAX}자 이하여야 합니다(ERP 제한, 공백 포함). 지금 ${length}자: ${badges.join(' / ')}`);
  return length;
}

/** The file name the ERP stored for an image. It differs from the uploaded name when that name already exists (ERP appends a suffix such as `_Eq3X4Um`). */
export function storedImageName(src) {
  const name = decodeURIComponent(new URL(src).pathname.split('/').pop() ?? '');
  if (!name) fail('Image source has no stored file name');
  return name;
}

function validateImageQueries(approved, query, fallbackQueries) {
  if (typeof query !== 'string' || !query || query !== query.trim()) fail('Invalid display image search query');
  if (fallbackQueries !== undefined && (!Array.isArray(fallbackQueries) || fallbackQueries.length !== approved.length || fallbackQueries.some(value => typeof value !== 'string' || !value || value !== value.trim()))) fail('Invalid image fallback queries');
}

async function importExistingModalImages(page, approved, query, fallbackQueries) {
  await (await uniqueVisible(page, '#content-modal', 'image modal')).waitFor({ state: 'visible', timeout: TIMEOUT });
  const selectedRows = () => page.locator('#content-modal #selected_image_area .import-image').evaluateAll(rows => rows.map(row => ({ id: row.getAttribute('data-id'), src: row.getAttribute('src') })));
  if ((await selectedRows()).length) fail('Image modal already contains selected rows');
  await (await uniqueVisible(page, '#content-modal #id_title', 'image search field')).fill(query, { timeout: TIMEOUT });
  await drawModalTable(page);
  for (const [index, image] of approved.entries()) {
    const selector = `#content-modal .select-row[data-id="${image.id}"]`;
    if (await page.locator(selector).count() === 0 && fallbackQueries?.[index] && fallbackQueries[index] !== query) {
      await (await uniqueVisible(page, '#content-modal #id_title', 'image search field')).fill(fallbackQueries[index], { timeout: TIMEOUT });
      await drawModalTable(page);
    }
    if (await page.locator(selector).count() !== 1) fail('Approved image search result is missing or ambiguous');
    const button = await uniqueVisible(page, selector, `image ${image.id} selection`);
    if (await button.getAttribute('data-src') !== image.src) fail('Image selection source does not exactly match approval');
    await button.click({ timeout: TIMEOUT });
    if (!stateImagesEqual(await selectedRows(), approved.slice(0, index + 1))) fail('Image selection did not stick in exact approved order');
  }
  await (await uniqueVisible(page, '#content-modal #import-image-btn', 'image import control')).click({ timeout: TIMEOUT });
  await page.locator('#content-modal').waitFor({ state: 'hidden', timeout: TIMEOUT });
}

/** Select existing exact image-library rows and import them into the unsaved homepage form. Never saves or uploads. */
export async function prepareExistingDisplayImages(page, { images, companyId, query, fallbackQueries } = {}) {
  const approved = validateDisplayImages(images, companyId);
  validateImageQueries(approved, query, fallbackQueries);
  const before = await readDisplayImageState(page);
  if (before.images.length) {
    if (!stateImagesEqual(before.images, approved)) fail('Cannot overwrite nonempty display images');
    return before;
  }
  await (await uniqueVisible(page, '#image_popup', 'image popup control')).click({ timeout: TIMEOUT });
  await importExistingModalImages(page, approved, query, fallbackQueries);
  const after = await readDisplayImageState(page);
  return assertDisplayImageDelta(before, after, approved);
}

/** Attach one verified prior upload through the reference image picker. Never saves or uploads. */
export async function prepareExistingReferenceImage(page, { control, receipt, companyId, query } = {}) {
  const approved = validateDisplayImages([receipt], companyId);
  validateImageQueries(approved, query);
  if (!control || await control.count() !== 1 || !await control.isVisible() || !await control.evaluate(node => node.matches('#reference_body .control[data-type="4"]'))) fail('Invalid reference image control');
  const rows = () => control.locator('.tr_image_list').evaluateAll(items => items.map(item => {
    const pictures = item.querySelectorAll('img');
    if (pictures.length !== 1) throw new Error('Malformed reference image row');
    return { id: item.getAttribute('data-id'), src: pictures[0].getAttribute('src') };
  }));
  if ((await rows()).length) fail('Cannot overwrite nonempty reference images');
  const button = control.locator('.add_reference_image');
  if (await button.count() !== 1 || !await button.isVisible() || !await button.isEnabled()) fail('Reference image search control is missing or ambiguous');
  await button.click({ timeout: TIMEOUT });
  await importExistingModalImages(page, approved, query);
  if (!stateImagesEqual(await rows(), approved)) fail('Reference image attachment differs from the exact approved receipt');
  return approved[0];
}
