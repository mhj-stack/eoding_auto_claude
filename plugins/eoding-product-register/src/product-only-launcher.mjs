import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual as same } from 'node:util';
import { chromium } from 'playwright';
import { ALLOWED_ORIGIN, ERP_URL } from './browser.mjs';
import { digest } from './core.mjs';
import { ProductOnlyExecutionCoordinator, createProductOnlyApprovalBinding, preflightProductOnlyExecution } from './product-only-execution.mjs';
import { createProductOnlyAdapters } from './product-only-adapters.mjs';
import { createProductLowLevelAdapters } from './product-execution.mjs';
import { ProductOnlyReviewStore, startProductOnlyReviewUI } from './product-only-review.mjs';
import { ScheduleSessionBrowser } from './schedule-session.mjs';
import { flightPreflight } from './plugin-workflow.mjs';
import { departurePreflight } from './plugin-departure.mjs';
import { installStageTransport } from './stage-transport.mjs';

const MAX_IMAGE_BYTES = 2_000_000;
const MAX_CDN_BYTES = 2_100_000;
const MASTER_PAGE_LENGTH = 2000;
const DEFAULT_TTL_MS = 15 * 60 * 1000;
const clone = value => structuredClone(value);
const fail = message => { throw new Error(message); };
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const text = (value, name) => {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim()) fail(`${name} must be a nonempty trimmed string`);
  return value;
};
const positiveId = (value, name) => {
  const result = text(String(value), name);
  if (!/^[1-9]\d{0,9}$/.test(result)) fail(`${name} must be a positive decimal ID`);
  return result;
};
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const own = (value, key) => Object.hasOwn(value, key);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const REQUIRED_SEASON_PRICE_KEYS = Object.freeze(['adult_base_price', 'child_base_price', 'infant_base_price', 'adult_fuel_price', 'child_fuel_price', 'infant_fuel_price']);
const REQUIRED_FLIGHT_FIELD_KEYS = Object.freeze(['depart-0-depart_date', 'depart-0-flight_no', 'depart-0-depart_time', 'depart-0-arrive_time', 'arrive-0-depart_date', 'arrive-0-flight_no', 'arrive-0-depart_time', 'arrive-0-arrive_time']);
const REQUIRED_FLIGHT_LABEL_KEYS = Object.freeze(['departport', 'depart-0-airline', 'depart-0-depart_cd', 'depart-0-arrive_cd', 'arrive-0-airline', 'arrive-0-depart_cd', 'arrive-0-arrive_cd']);

function privateDirectory(value, name, { create = true, fresh = false } = {}) {
  const resolved = path.resolve(text(value, name));
  if (resolved === path.parse(resolved).root || resolved === homedir() || resolved.startsWith(String.fromCharCode(92, 92)) || existsSync(path.join(resolved, '.git')) || existsSync(path.join(resolved, 'package.json'))) fail(`${name} must be a dedicated private directory`);
  return (async () => {
    if (create) await mkdir(resolved, { recursive: true, mode: 0o700 });
    const stat = await lstat(resolved).catch(error => { if (error.code === 'ENOENT') fail(`${name} path does not exist`); throw error; });
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${name} must be a non-symlink directory`);
    if (fresh) {
      const entries = await readdir(resolved);
      if (entries.length) fail(`${name} was already used; choose a new empty private journal directory`);
    }
    return resolved;
  })();
}

function validateImageEvidence(image, index) {
  if (!plain(image) || typeof image.id !== 'string' || !image.id || typeof image.path !== 'string' || !path.isAbsolute(image.path) || typeof image.name !== 'string' || !image.name || /[\\/\0\r\n]/.test(image.name) || !['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType) || !/^[a-f0-9]{64}$/.test(image.sha256 ?? '') || typeof image.alt !== 'string' || !image.alt) fail(`source image ${index + 1} must have an absolute local path, name, MIME, SHA-256, and alt text`);
}

function wholeMoney(value, name) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)$/.test(value)) fail(`${name} must be an explicit nonnegative decimal string (zero is exactly "0")`);
  const amount = Number(value);
  if (!Number.isSafeInteger(amount)) fail(`${name} is outside the safe money range`);
  return amount;
}

function selectedSeasonDeparture(plan) {
  const dates = plan.season?.selectedDates;
  if (!Array.isArray(dates) || dates.length !== 1 || !ISO_DATE.test(dates[0])) fail('Season must select exactly one ISO departure date');
  const matches = (plan.product.departures ?? []).filter(departure => departure?.startDate === dates[0]);
  if (matches.length !== 1) fail('The selected season date must identify exactly one approved departure start');
  const selected = matches[0].prices?.[matches[0].selectedPrice];
  if (!selected || typeof selected !== 'object') fail('The selected departure price is missing');
  return { date: dates[0], departure: matches[0], selected };
}

function validateSeasonCommercialBinding(plan) {
  const season = plan.season, fields = season?.fields, labels = season?.selectLabels;
  if (!plain(season) || !plain(fields) || !plain(season.selects)) fail('Season fields and selects are required');
  if (fields.currency_code !== plan.product.currency) fail('Season currency must equal the approved product currency');
  for (const key of REQUIRED_SEASON_PRICE_KEYS) wholeMoney(fields[key], `season.fields.${key}`);
  for (const key of ['min_pax_count', 'max_pax_count']) {
    const value = wholeMoney(fields[key], `season.fields.${key}`);
    if (value < 1) fail(`season.fields.${key} must be at least 1`);
  }
  if (Number(fields.min_pax_count) > Number(fields.max_pax_count)) fail('Season minimum passengers exceeds maximum passengers');
  for (const key of REQUIRED_FLIGHT_FIELD_KEYS) text(fields[key], `season.fields.${key}`);
  if (!plain(labels)) fail('Season selectLabels are required for the human review');
  for (const key of REQUIRED_FLIGHT_LABEL_KEYS) text(labels[key], `season.selectLabels.${key}`);
  const { date, selected, departure } = selectedSeasonDeparture(plan);
  const flightIssues = flightPreflight(season, departure);
  if (flightIssues.length) fail(flightIssues.map(issue => `${issue.field}: ${issue.message}`).join('; '));
  if (fields['depart-0-depart_date'] !== date) fail('Season outbound date must equal the selected departure start');
  for (const kind of ['adult', 'child', 'infant']) {
    const price = selected[kind];
    if (!plain(price) || !Number.isSafeInteger(price.amount) || price.amount < 0 || price.currency !== plan.product.currency) fail(`Selected ${kind} price must be an approved nonnegative ${plan.product.currency} amount`);
    const total = wholeMoney(fields[`${kind}_base_price`], `season.fields.${kind}_base_price`) + wholeMoney(fields[`${kind}_fuel_price`], `season.fields.${kind}_fuel_price`);
    if (price.amount !== total) fail(`Selected ${kind} price must equal the season base price plus fuel surcharge`);
  }
}

/** Validate and finalize the new-product-only boundary before a browser opens or an approval can be shown. */
export function validateProductOnlyLaunchPlan(input) {
  if (!plain(input)) fail('product-only plan must be an object');
  const plan = clone(input);
  if (!same(plan.target, { mode: 'NEW' }) || own(plan, 'productId')) fail('product-only launcher supports exactly a NEW product target');
  for (const key of ['event', 'events', 'eventCreation', 'hotel', 'hotels', 'hotelAssignments']) if (own(plan, key)) fail(`${key} is outside the product-only launcher boundary`);
  if (!plain(plan.product) || !plain(plan.product.company) || !text(plan.product.title, 'product title') || !text(String(plan.product.company.tenant ?? ''), 'product company tenant')) fail('normalized product and exact company tenant are required');
  positiveId(plan.companyId, 'companyId');
  if (!plain(plan.identity) || Object.keys(plan.identity).sort().join(',') !== 'accountKey,accountName,sessionKey' || Object.values(plan.identity).some(value => typeof value !== 'string' || !value.trim() || value !== value.trim())) fail('plan identity must exactly contain accountName, accountKey, and sessionKey');
  if (!plain(plan.source) || !Array.isArray(plan.source.rows) || !plan.source.rows.length || !Array.isArray(plan.source.images) || !plan.source.images.length) fail('product-only plan requires source rows and local image evidence');
  if (new Set(plan.source.images.map(image => image?.id)).size !== plan.source.images.length) fail('source image IDs must be unique');
  plan.source.images.forEach(validateImageEvidence);
  if (plan.seasonMode === 'excluded') {
    if (own(plan, 'season')) fail('Excluded season mode requires plan.season to be absent');
  } else validateSeasonCommercialBinding(plan);
  if (own(plan, 'departure')) {
    const checked = departurePreflight(plan);
    if (!checked.canExecute) fail(checked.blockers.join('; '));
  }
  const binding = createProductOnlyApprovalBinding(plan);
  if (plan.approvalBinding === undefined) plan.approvalBinding = binding;
  else if (!same(plan.approvalBinding, binding)) fail('approvalBinding must bind the exact plan and product-only scope');
  return Object.freeze(plan);
}

function imageMime(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(Buffer.from('RIFF')) && bytes.subarray(8, 12).equals(Buffer.from('WEBP'))) return 'image/webp';
  return null;
}

/** Byte loader used by the production adapter: no URL input and no unbound image bytes. */
export async function loadApprovedProductOnlyImage(source) {
  validateImageEvidence(source, 0);
  const file = path.resolve(source.path), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_IMAGE_BYTES) fail('Approved image must be a regular local file within the size limit');
  const bytes = await readFile(file);
  if (bytes.length !== stat.size || imageMime(bytes) !== source.mimeType || sha256(bytes) !== source.sha256) fail('Approved image bytes, MIME, or SHA-256 changed after review preparation');
  return bytes;
}

async function boundedBytes(response) {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(contentLength) || Number(contentLength) < 1 || Number(contentLength) > MAX_CDN_BYTES) fail('CDN image content length is unsafe');
  }
  const reader = response.body?.getReader();
  if (!reader) fail('CDN image body is unavailable');
  const chunks = []; let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CDN_BYTES) fail('CDN image exceeds the bounded read limit');
      chunks.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  if (!total) fail('CDN image is empty');
  return Buffer.concat(chunks, total);
}

/** Credential-free HTTPS CDN re-read that proves the returned image remains in the approved tenant. */
export async function verifyApprovedProductOnlyCdnImage({ receipt, source, companyId, fetchImpl = fetch } = {}) {
  if (!plain(receipt) || typeof receipt.src !== 'string' || !plain(source) || typeof fetchImpl !== 'function') fail('Upload receipt, source, and fetch implementation are required');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(source.mimeType) || !/^[a-f0-9]{64}$/.test(source.sha256 ?? '')) fail('Approved image MIME and SHA-256 are required for CDN verification');
  const tenant = positiveId(companyId, 'companyId');
  const url = new URL(receipt.src);
  const prefix = `https://media.eoding.com/media/travelagent/${tenant}/imagecontent/`;
  if (url.href !== receipt.src || !receipt.src.startsWith(prefix) || url.username || url.password || url.search || url.hash) fail('Uploaded image receipt is outside the exact company CDN prefix');
  const signal = AbortSignal.timeout(10_000);
  const response = await fetchImpl(url, { method: 'GET', redirect: 'error', credentials: 'omit', signal, headers: { Accept: source.mimeType } });
  if (!response.ok || response.url !== url.href || response.redirected) fail('CDN image readback did not return the exact approved URL');
  const contentType = response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType && contentType !== source.mimeType) fail('CDN image MIME differs from the approved source');
  const bytes = await boundedBytes(response);
  if (imageMime(bytes) !== source.mimeType || sha256(bytes) !== source.sha256) fail('CDN image SHA-256 differs from the approved source');
  return { tenantId: tenant, src: receipt.src, sha256: source.sha256, bytes: bytes.length };
}

async function writeSynced(file, value, flag = 'wx') {
  const handle = await open(file, flag, 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

// Windows refuses to replace a file that another handle (progress reader, antivirus, indexer) briefly holds open.
export async function renameReplacing(from, to, { renameImpl = rename, platform = process.platform, timeoutMs = 2000, pause = delay } = {}) {
  const deadline = performance.now() + timeoutMs;
  for (let wait = 10; ; wait = Math.min(wait * 2, 200)) {
    try { return await renameImpl(from, to); }
    catch (error) {
      const contended = platform === 'win32' && ['EPERM', 'EBUSY', 'EACCES'].includes(error.code);
      if (!contended || performance.now() >= deadline) throw error;
      await pause(wait);
    }
  }
}

class DurableProductOnlyJournal {
  constructor(directory, plan) {
    this.directory = directory;
    this.plan = clone(plan);
    this.events = [];
    this.executionPath = path.join(directory, 'execution.jsonl');
    this.eventPath = path.join(directory, 'journal.jsonl');
    this.checkpointPath = path.join(directory, 'checkpoint.json');
  }

  async reserve() {
    await writeSynced(path.join(this.directory, 'launcher-state.json'), { lifecycle: 'product-only-launcher', status: 'review-prepared', planDigest: this.plan.approvalBinding.planDigest, scopeDigest: this.plan.approvalBinding.scopeDigest, createdAt: Date.now() });
  }

  async _append(value, file = this.eventPath) {
    const event = { at: Date.now(), ...clone(value) };
    const handle = await open(file, 'a', 0o600);
    try { await handle.writeFile(JSON.stringify(event) + '\n', 'utf8'); await handle.sync(); } finally { await handle.close(); }
    this.events.push(event);
    return event;
  }

  async _checkpoint(value) {
    const temporary = `${this.checkpointPath}.${randomUUID()}.tmp`;
    await writeSynced(temporary, { at: Date.now(), last: clone(value), events: this.events.length });
    try { await renameReplacing(temporary, this.checkpointPath); } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async approval(value) { const event = await this._append({ kind: 'human-approval', approval: value }); await this._checkpoint(event); }
  async cancelled(value) { const event = await this._append({ kind: 'approval-cancelled', approval: value }); await this._checkpoint(event); }
  async claim(value) { const event = await this._append({ kind: 'approval-claim', claim: value }); await this._checkpoint(event); }
  async reconcile(value) { const event = await this._append({ kind: 'needs-reconciliation', result: value }); await this._checkpoint(event); }
  async complete(value) { const event = await this._append({ kind: 'completed', result: value }); await this._checkpoint(event); }

  async start(value) {
    await writeSynced(this.executionPath, { at: Date.now(), kind: 'execution-start', value: clone(value) });
    return { mode: 'wx', path: this.executionPath };
  }

  async append(value) { await this._append({ kind: 'coordinator-evidence', value }); }
  async checkpoint(value) { await this._checkpoint({ kind: 'coordinator-checkpoint', value }); }

  async authorize(event, context) {
    const evidence = { kind: 'write-authorized', event: clone(event), context: { phase: context?.phase, targets: clone(context?.targets) } };
    const saved = await this._append(evidence); await this._checkpoint(saved);
    return { durable: true, status: 'approved', bindingDigest: event?.bindingDigest ?? event?.binding?.digest, approvalId: `product-only:${this.plan.approvalBinding.planDigest}` };
  }

  async record(event, context) {
    const evidence = { kind: 'adapter-evidence', event: clone(event), context: { phase: context?.phase, targets: clone(context?.targets) } };
    const saved = await this._append(evidence); await this._checkpoint(saved);
    return { durable: true, bindingDigest: event?.bindingDigest ?? event?.binding?.digest, evidenceId: `${this.plan.approvalBinding.planDigest}:${this.events.length}` };
  }
}

/** Reads the full visible master list. Anything paged, filtered, or incomplete is rejected rather than guessed. */
export async function readAllProductOnlyMasterRows(page) {
  await page.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => globalThis.jQuery?.fn?.dataTable?.isDataTable('#DataTables_Table_0') && globalThis.jQuery('#DataTables_Table_0').DataTable().settings()[0]?._bInitComplete === true, undefined, { timeout: 20_000 });
  await page.evaluate(length => new Promise((resolve, reject) => {
    const table = globalThis.jQuery('#DataTables_Table_0').DataTable();
    const done = () => { clearTimeout(timer); table.off('draw', done); resolve(); };
    const timer = setTimeout(() => { table.off('draw', done); reject(new Error('Master list did not complete its full read')); }, 20_000);
    table.one('draw', done); table.page.len(length).draw(false);
  }), MASTER_PAGE_LENGTH);
  const value = await page.evaluate(() => {
    const table = globalThis.jQuery('#DataTables_Table_0').DataTable(), info = table.page.info(), rows = table.rows().data().toArray();
    return { recordsTotal: info.recordsTotal, recordsDisplay: info.recordsDisplay, rows: rows.map(row => ({ ...row, id: String(row?.id ?? '') })) };
  });
  if (!Number.isSafeInteger(value.recordsTotal) || value.recordsTotal < 0 || value.recordsDisplay !== value.recordsTotal || value.rows.length !== value.recordsTotal || value.recordsTotal > MASTER_PAGE_LENGTH || value.rows.some(row => !/^[1-9]\d{0,9}$/.test(row.id)) || new Set(value.rows.map(row => row.id)).size !== value.rows.length) fail('Master list is filtered, paged, incomplete, or has ambiguous IDs');
  return { recordsTotal: value.recordsTotal, rows: value.rows };
}

function assertNoDuplicate(baseline, plan) {
  if (!plain(baseline) || !Number.isSafeInteger(baseline.recordsTotal) || !Array.isArray(baseline.rows) || baseline.rows.length !== baseline.recordsTotal) fail('Pre-claim master baseline is incomplete');
  const code = typeof plan.product.externalCode === 'string' && plan.product.externalCode.trim() ? plan.product.externalCode : null;
  const matches = baseline.rows.filter(row => {
    const value = JSON.stringify(row);
    return value.includes(plan.product.title) || (code && value.includes(code));
  });
  if (matches.length) fail('ERP duplicate candidate exists for the exact source code or supplier title; reconcile before creating a NEW product');
}

function masterBaselineSignature(baseline) {
  if (!plain(baseline) || !Number.isSafeInteger(baseline.recordsTotal) || !Array.isArray(baseline.rows) || baseline.rows.length !== baseline.recordsTotal) fail('Pre-claim master baseline is incomplete');
  const ids = baseline.rows.map(row => String(row?.id ?? '')).sort();
  if (ids.some(id => !/^[1-9]\d{0,9}$/.test(id)) || new Set(ids).size !== ids.length) fail('Pre-claim master baseline has ambiguous product IDs');
  return { recordsTotal: baseline.recordsTotal, ids };
}

function assertSameMasterBaseline(current, expected) {
  if (!same(masterBaselineSignature(current), expected)) fail('ERP master list count or product IDs changed while human approval was pending; reconcile before creating NEW');
}

async function recheckPlanFile(planPath, plan) {
  if (!planPath) return;
  let parsed;
  try { parsed = JSON.parse(await readFile(planPath, 'utf8')); } catch (error) { fail(`Approved source plan cannot be reread as JSON: ${error.message}`); }
  if (!same(validateProductOnlyLaunchPlan(parsed), plan)) fail('Approved source plan changed after review preparation');
}

function assertIdentityMatches(observed, plan) {
  if (!same(observed, plan.identity)) fail('Observed ERP account or session identity differs from the approved plan');
  return clone(observed);
}

export async function readProductOnlyIdentity(page) {
    let url = new URL(page.url());
    if (url.origin !== ALLOWED_ORIGIN || url.username || url.password) fail('ERP page origin is not the approved Basecamp origin');
    if (await page.locator('input[type="password"]:visible').count()) fail('Login is required; the user must log in directly before review');
    // Successful login now lands on the v2 dashboard, which has no legacy
    // account marker. Only leave that read-only landing page; never navigate
    // away from a product form or any other potentially edited page.
    if (/^\/v2\/dashboard\/?$/.test(url.pathname) && await page.locator('#eoding-name').count() === 0) {
      await page.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      url = new URL(page.url());
      if (url.origin !== ALLOWED_ORIGIN || url.username || url.password) fail('ERP page origin is not the approved Basecamp origin');
      if (await page.locator('input[type="password"]:visible').count()) fail('Login is required; the user must log in directly before review');
    }
    const label = (await page.locator('#eoding-name').innerText()).trim();
    if (!label) fail('Observed ERP account name is missing');
    const cookies = (await page.context().cookies(ALLOWED_ORIGIN)).filter(cookie => cookie.httpOnly).map(cookie => ({ name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path })).sort((left, right) => (left.name + left.domain + left.path).localeCompare(right.name + right.domain + right.path));
    if (!cookies.length) fail('Approved ERP session has no HttpOnly identity cookie');
    const companyIds = await page.locator('img').evaluateAll(nodes => [...new Set(nodes.map(node => {
      try {
        const source = new URL(node.src);
        if (source.origin !== 'https://media.eoding.com') return null;
        return /^\/media\/travelagent\/(\d+)\/(?:erp_logo|logo)\//.exec(source.pathname)?.[1];
      } catch { return null; }
    }).filter(Boolean))]);
    if (companyIds.length !== 1) fail('Observed ERP company tenant is missing or ambiguous');
    const companyId = companyIds[0];
    return { companyId, identity: { accountName: label, accountKey: digest({ origin: ALLOWED_ORIGIN, label, declaredTenant: companyId }), sessionKey: digest(cookies) } };
}

function createDefaultIdentityReader(plan) {
  return async page => {
    const observed = await readProductOnlyIdentity(page);
    if (observed.companyId !== String(plan.companyId)) fail('Observed ERP company tenant differs from the approved companyId');
    return assertIdentityMatches(observed.identity, plan);
  };
}

export class ExistingProfileBrowser {
  constructor({ browserDir, launcher = chromium } = {}) { this.browserDir = browserDir; this.launcher = launcher; this.context = null; }
  async open() {
    if (this.context) fail('Product-only execution requires one owned browser instance');
    if (path.basename(this.browserDir) !== 'browser-profile') fail('browserDir must be the existing browser-profile directory, not the account parent');
    const session = new ScheduleSessionBrowser({ dataDir: path.dirname(this.browserDir), launcher: this.launcher });
    this.context = session;
    const close = async () => { if (this.context === session) this.context = null; await session.close(); };
    try {
      const page = await session.ensurePage();
      page.context().setDefaultTimeout(10_000);
      await page.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { page, close };
    } catch (error) { await close(); throw error; }
  }
}

async function localPreflight(plan) {
  const images = [];
  for (const source of plan.source.images) images.push({ id: source.id, path: source.path, sha256: sha256(await loadApprovedProductOnlyImage(source)), mimeType: source.mimeType });
  return { status: 'local-inputs-verified', identity: clone(plan.identity), images, eventCreation: plan.departure?.create ? 'one-selected-departure' : 'prohibited', hotelAssignment: 'prohibited' };
}

async function liveReadOnlyPreflight({ plan, browser, identity }) {
  const owned = await browser.open();
  const page = owned?.page;
  if (!page || typeof owned.close !== 'function') fail('Preflight browser did not supply one owned page');
  const context = page.context(), guard = route => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort();
  let erpBusinessWrites = 0, blockedThirdPartyWrites = 0;
  const countingGuard = route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) {
      let origin = '';
      try { origin = new URL(request.url()).origin; } catch {}
      if (origin === ALLOWED_ORIGIN) erpBusinessWrites += 1;
      else blockedThirdPartyWrites += 1;
    }
    return guard(route);
  };
  await context.route('**/*', countingGuard);
  try {
    await page.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const observed = await identity(page);
    const baseline = await readAllProductOnlyMasterRows(page);
    assertNoDuplicate(baseline, plan);
    const basic = createProductLowLevelAdapters({ identity: async () => identity(page) }).basic;
    const prepared = await basic.prepare(page, plan.product, plan.basic, { assertIdentity: async () => identity(page) });
    const reread = await basic.read(page);
    if (!same(prepared, reread) || reread.status !== '2' || erpBusinessWrites) fail('Read-only basic form preparation changed or attempted an ERP write');
    await page.goto(ERP_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return { identity: observed, baseline, basic: { status: 'read-only-basic-ready', businessWrites: erpBusinessWrites, preparedDigest: digest(prepared), privateStatus: true }, schedule: { status: 'unverified-no-blank-schedule-before-new-product-save' }, network: { erpBusinessWrites, blockedThirdPartyWrites } };
  } finally {
    await context.unroute('**/*', countingGuard).catch(() => {});
    await owned.close();
  }
}

function checkedPreflight(value, plan) {
  if (!plain(value)) fail('Preflight did not return evidence');
  assertIdentityMatches(value.identity, plan);
  assertNoDuplicate(value.baseline, plan);
  if (value.basic?.businessWrites !== 0) fail('Preflight must prove zero ERP writes');
  if (value.network?.erpBusinessWrites !== undefined && value.network.erpBusinessWrites !== 0) fail('Preflight must reject same-origin ERP business writes');
  return clone(value);
}

async function guardedMasterBaselineRecheck({ page, plan, identity }) {
  const context = page.context();
  let erpBusinessWrites = 0, blockedThirdPartyWrites = 0;
  const guard = route => {
    const request = route.request();
    if (['GET', 'HEAD'].includes(request.method())) return route.fallback();
    let origin = '';
    try { origin = new URL(request.url()).origin; } catch {}
    if (origin === ALLOWED_ORIGIN) erpBusinessWrites += 1;
    else blockedThirdPartyWrites += 1;
    return route.abort();
  };
  await context.route('**/*', guard);
  try {
    await identity(page);
    const baseline = await readAllProductOnlyMasterRows(page);
    if (erpBusinessWrites) fail('Post-approval duplicate baseline attempted an ERP write');
    return { baseline, network: { erpBusinessWrites, blockedThirdPartyWrites } };
  } finally {
    await context.unroute('**/*', guard).catch(() => {});
  }
}

/**
 * Starts the one-human-approval product-only launcher. It opens a localhost review
 * page; execution is impossible until that page posts a CSRF/cookie/origin-checked approval.
 */
export async function startProductOnlyLauncher({ plan: rawPlan, planPath, dataDir, browserDir, preflightOnly = false, ttlMs = DEFAULT_TTL_MS, browser, identityReader, controls, timeoutMs, preflight, verifyUploadedImage, fetchImpl, recheckBaseline, budgetMode = 'stop', resume, assertResume } = {}) {
  const wrapperStartedAt = Date.now();
  if (typeof preflightOnly !== 'boolean') fail('preflightOnly must be a boolean');
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > DEFAULT_TTL_MS) fail('ttlMs must be within the local review limit');
  const plan = validateProductOnlyLaunchPlan(rawPlan);
  let approvedPlanPath;
  if (planPath !== undefined) {
    approvedPlanPath = path.resolve(text(planPath, 'planPath'));
    const stat = await lstat(approvedPlanPath).catch(error => { if (error.code === 'ENOENT') fail('planPath does not exist'); throw error; });
    if (!stat.isFile() || stat.isSymbolicLink()) fail('planPath must be a regular non-symlink file');
    await recheckPlanFile(approvedPlanPath, plan);
  }
  const local = await localPreflight(plan);
  let browserForRun = browser;
  if (!browserForRun && browserDir !== undefined) {
    const profile = await privateDirectory(browserDir, 'browserDir', { create: false });
    browserForRun = new ExistingProfileBrowser({ browserDir: profile });
  }
  const identity = identityReader ?? (browserForRun ? createDefaultIdentityReader(plan) : null);
  let checked;
  if (resume) {
    if (!plan.resumeFrom || typeof assertResume !== 'function') fail('Resume requires pinned original evidence');
    await assertResume();
    checked = { ...local, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'resume-readback-required', businessWrites: 0 }, schedule: { status: 'resume-readback-required' } };
  }
  else if (typeof preflight === 'function') checked = checkedPreflight(await preflight({ plan: clone(plan), local: clone(local) }), plan);
  else if (browserForRun) checked = checkedPreflight(await liveReadOnlyPreflight({ plan, browser: browserForRun, identity }), plan);
  else checked = { ...local, baseline: { recordsTotal: 0, rows: [] }, basic: { status: 'local-only-no-browser', businessWrites: 0 }, schedule: { status: 'unverified-no-browser' } };
  const wrapperPreparationMs = Date.now() - wrapperStartedAt;
  if (preflightOnly) return Object.freeze({ status: 'preflight-complete', planDigest: plan.approvalBinding.planDigest, scopeDigest: plan.approvalBinding.scopeDigest, preflight: clone(checked), liveBrowserPreparation: Boolean(browserForRun && typeof preflight !== 'function'), timing: { wrapperPreparationMs, totalActiveProcessingMs: wrapperPreparationMs, humanApprovalWaitMs: 0 } });
  if (!browserForRun || typeof browserForRun.open !== 'function') fail('browserDir or an owned browser implementation is required for review execution');
  const journalDir = await privateDirectory(dataDir, 'dataDir', { create: true, fresh: true });
  const journal = new DurableProductOnlyJournal(journalDir, plan);
  await journal.reserve();
  let settled = false, resolveCompletion, rejectCompletion;
  const completed = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  const settleResolve = value => { if (!settled) { settled = true; resolveCompletion(value); } };
  const settleReject = error => { if (!settled) { settled = true; rejectCompletion(error); } };
  const store = new ProductOnlyReviewStore({
    plan,
    sourceLabel: plan.product.externalCode ?? plan.product.title,
    sourceDigest: plan.approvalBinding.planDigest,
    onApprove: approval => journal.approval(approval),
    onCancel: async approval => { await journal.cancelled(approval); settleReject(new Error('Local review was cancelled or expired before approval claim')); },
    onClaim: claim => journal.claim(claim),
    onReconcile: result => journal.reconcile(result),
    beforeClaim: async () => { await recheckPlanFile(approvedPlanPath, plan); if (resume) await assertResume(); }
  });
  const expectedBaseline = masterBaselineSignature(checked.baseline);
  const beforeBasicPrepare = async page => {
    await recheckPlanFile(approvedPlanPath, plan);
    for (const source of plan.source.images) await loadApprovedProductOnlyImage(source);
    const reread = typeof recheckBaseline === 'function'
      ? await recheckBaseline({ page, plan: clone(plan), expected: clone(expectedBaseline), identity })
      : await guardedMasterBaselineRecheck({ page, plan, identity });
    const current = reread?.baseline ?? reread;
    assertSameMasterBaseline(current, expectedBaseline);
    assertNoDuplicate(current, plan);
  };
  const adapters = createProductOnlyAdapters({
    plan,
    identity,
    authorizeWrite: (event, context) => journal.authorize(event, context),
    record: (event, context) => journal.record(event, context),
    loadImage: loadApprovedProductOnlyImage,
    verifyUploadedImage: verifyUploadedImage ?? (value => verifyApprovedProductOnlyCdnImage({ ...value, companyId: plan.companyId, fetchImpl })),
    controls,
    timeoutMs,
    beforeBasicPrepare
    ,seedBasicReceipt: resume?.checkpoint.basic
    ,seedSeasonReceipt: resume?.checkpoint.season?.receipt
  });
  const verifyResume = async page => {
    await assertResume();
    const transport = await installStageTransport(page, `resume-reconcile:${plan.approvalBinding.planDigest}`, async () => {
      const owner = page.context(), guard = route => ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort();
      await owner.route('**/*', guard);
      return async () => owner.unroute('**/*', guard);
    });
    const proof = await adapters.reconcileSavedStages(page, clone(resume.checkpoint));
    const { readback } = await import('./product-season-adapter.mjs');
    const seasons = await readback(page, { target: { productId: String(resume.targets.productId) }, assertIdentity: async () => ({ identityDigest: digest(await identity(page)) }) });
    // Season resume must find no season; departure resume must find exactly the verified season.
    const savedSeason = resume.checkpoint.season?.seasonId;
    if (savedSeason ? !same(seasons.seasons, [savedSeason]) : seasons.seasons.length !== 0) fail(savedSeason ? 'Saved season membership changed; departure resume blocked' : 'Existing season detected; resume cannot replay a season write');
    await assertResume(); transport.verify(); return proof;
  };
  const coordinator = new ProductOnlyExecutionCoordinator({ browser: browserForRun, approval: { claim: request => store.claim(request) }, journal, adapters, budgetMode, ...(resume ? { resume: { targets: resume.targets, results: resume.results, verify: verifyResume } } : {}) });
  const coordinatorPreflight = preflightProductOnlyExecution(plan, coordinator);
  if (!coordinatorPreflight.canExecute) fail(`Product-only launcher is blocked before review: ${coordinatorPreflight.blockers.join('; ')}`);
  let executing = false;
  const launcher = {
    url: null,
    planDigest: plan.approvalBinding.planDigest,
    scopeDigest: plan.approvalBinding.scopeDigest,
    timing: Object.freeze({ wrapperPreparationMs, humanApprovalWaitMs: null, totalActiveProcessingMs: null }),
    preflight: Object.freeze(clone(checked)),
    writes: journal.events,
    completed,
    async executeApproved() {
      if (executing || settled) fail('Product-only approval is already consumed or execution has finished');
      executing = true;
      try {
        const coordinatorResult = await coordinator.execute(plan);
        const result = clone(coordinatorResult);
        result.timing = { ...result.timing, wrapperPreparationMs, humanApprovalWaitMs: result.timing.approvalWaitMs, totalActiveProcessingMs: wrapperPreparationMs + result.timing.activeProcessingMs };
        result.budget = { ...result.budget, totalActiveProcessingMs: result.timing.totalActiveProcessingMs, humanApprovalWaitMs: result.timing.approvalWaitMs };
        await store.completed(result);
        await journal.complete(result);
        settleResolve(result);
        return result;
      } catch (error) {
        await store.reconcile(error).catch(() => {});
        settleReject(new Error(`Product-only save outcome requires reconciliation; do not retry: ${error.message}`, { cause: error }));
        throw error;
      }
    },
    async close() { await ui?.close(); }
  };
  const ui = await startProductOnlyReviewUI({ store, ttlMs, onApproved: () => launcher.executeApproved() });
  launcher.url = ui.url;
  return Object.freeze(launcher);
}
