import { createHash } from 'node:crypto';
import { releaseStageTransport } from './stage-transport.mjs';

const PHASES = Object.freeze(['basic', 'display', 'content', 'shell', 'day', 'season', 'departure']);
const WRITE_PHASES = Object.freeze(['basic', 'display', 'content', 'shell', 'season']);
const DEFAULT_PROCESSING_BUDGET_MS = 20 * 60 * 1000;

const clone = value => structuredClone(value);
const fail = message => { throw new TypeError(message); };
const record = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
};
const nonemptyText = (value, name) => {
  if (typeof value !== 'string' || !value.trim()) fail(`${name} must be a nonempty string`);
  return value;
};
const positiveSafeInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) fail(`${name} must be a positive safe integer`);
  return value;
};
const freeze = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freeze(child);
  }
  return value;
};
const stableJson = value => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!value || typeof value !== 'object') fail('approval binding contains an unsupported value');
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
};
const digest = value => createHash('sha256').update(stableJson(value)).digest('hex');
const isNewTarget = input => input?.target?.mode === 'NEW';
const declaredTarget = input => isNewTarget(input) ? { mode: 'NEW' } : { mode: 'EXISTING', productId: input.productId };
const phasesFor = (input, phases = PHASES) => phases.filter(phase => (phase !== 'season' || input?.seasonMode !== 'excluded') && (phase !== 'departure' || input?.departure?.create === true));
const scopeFor = input => ({
  mode: 'product-only',
  target: declaredTarget(input),
  phases: phasesFor(input),
  eventCreation: input?.departure?.create === true ? 'one-selected-departure' : 'prohibited',
  sourceProduct: input.product ?? null,
  sourceRows: input.source?.rows?.map(row => row?.id),
  sourceImages: input.source?.images?.map(image => image?.id),
  displayedSourceImages: input.display?.images?.map(image => image?.sourceImageId),
  itinerary: input.itinerary?.map(day => ({ day: day?.day, sourceRowId: day?.sourceRowId })),
  hasSeason: Boolean(input.season)
  ,...(input.resumeFrom ? { resumeFrom: input.resumeFrom, remainingWrites: input.resumeFrom.remaining?.[0] === 'departure' ? ['departure'] : ['season', ...(input.departure?.create ? ['departure'] : [])] } : {})
});
const planForDigest = input => {
  const result = clone(input);
  delete result.approvalBinding;
  return result;
};
const same = (left, right) => stableJson(left) === stableJson(right);

/** Build the explicit digest pair a NEW target plan must carry into human approval. */
export function createProductOnlyApprovalBinding(input) {
  record(input, 'product-only plan');
  return Object.freeze({ planDigest: digest(planForDigest(input)), scopeDigest: digest(scopeFor(input)) });
}

export class ProcessingBudgetExceededError extends Error {
  constructor({ elapsedMs, budgetMs, reconciledPhase = null, finalCheck = null }) {
    super(`Product-only processing budget exceeded before the next write (${elapsedMs}ms > ${budgetMs}ms)`);
    this.name = 'ProcessingBudgetExceededError';
    this.code = 'PROCESSING_BUDGET_EXCEEDED';
    this.elapsedMs = elapsedMs;
    this.budgetMs = budgetMs;
    this.reconciledPhase = reconciledPhase;
    this.finalCheck = finalCheck;
  }
}

export class UnknownSaveOutcomeError extends Error {
  constructor(phase, cause) {
    super(`${phase} save outcome is unknown; reconcile before any retry`);
    this.name = 'UnknownSaveOutcomeError';
    this.code = 'UNKNOWN_SAVE_OUTCOME';
    this.phase = phase;
    this.cause = cause;
  }
}

function phaseName(phase, day) { return phase === 'day' ? `day:${day.day}` : phase; }
function phaseAdapter(adapters, phase) { return adapters[phase]; }
function executionPhases(adapters, input) { return phasesFor(input, adapters?.media ? ['basic','media','shell','day','season','departure'] : PHASES); }
function validateNewBinding(input, blockers) {
  if (!isNewTarget(input)) return;
  if (!input.target || Object.keys(input.target).length !== 1) blockers.push('NEW target must be exactly { mode: \'NEW\' }');
  if (Object.hasOwn(input, 'productId')) blockers.push('NEW target must not predeclare productId; the verified basic receipt establishes it');
  const binding = input.approvalBinding;
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) {
    blockers.push('NEW target requires approvalBinding with planDigest and scopeDigest');
    return;
  }
  const expected = createProductOnlyApprovalBinding(input);
  if (binding.planDigest !== expected.planDigest) blockers.push('NEW target approvalBinding.planDigest does not bind the approved plan');
  if (binding.scopeDigest !== expected.scopeDigest) blockers.push('NEW target approvalBinding.scopeDigest does not bind the approved scope');
}

/**
 * Validates only the reusable coordinator contract. It intentionally does not create
 * browser/auth/ERP adapters: callers must supply production adapters for content,
 * image display, and season persistence.
 */
export function preflightProductOnlyExecution(input, { adapters, browser, approval, journal, preparation } = {}) {
  const blockers = [];
  if (!browser || typeof browser.open !== 'function') blockers.push('browser.open is required for one owned browser lifecycle');
  if (!approval || typeof approval.claim !== 'function') blockers.push('approval.claim is required for the single explicit human approval claim');
  for (const method of ['start', 'append', 'checkpoint']) if (!journal || typeof journal[method] !== 'function') blockers.push(`journal.${method} is required for durable evidence`);
  if (preparation != null && typeof preparation.prepare !== 'function') blockers.push('preparation.prepare must be an async pre-approval processor when supplied');
  if (!adapters || typeof adapters !== 'object') blockers.push('adapters are required');
  else {
    if (adapters.events || adapters.event || typeof adapters.createEvent === 'function') blockers.push('event creation is explicitly prohibited for product-only execution');
    if (adapters.media && (!same(adapters.media.covers, ['display','content']) || adapters.display || adapters.content)) blockers.push('media must exclusively cover display and content without duplicate adapters');
    for (const phase of executionPhases(adapters, input)) {
      const adapter = phaseAdapter(adapters, phase);
      if (!adapter || typeof adapter.save !== 'function') blockers.push(`${phase}.save is required`);
      if (!adapter || typeof adapter.verifyReceipt !== 'function') blockers.push(`${phase}.verifyReceipt is required`);
      if (typeof adapter?.preflight === 'function') {
        try {
          const checked = adapter.preflight(clone(input));
          if (!checked || typeof checked.then === 'function' || checked.canExecute !== true || !Array.isArray(checked.blockers) || checked.blockers.length) blockers.push(`${phase}: ${Array.isArray(checked?.blockers) && checked.blockers.length ? checked.blockers.join('; ') : 'invalid or unsuccessful adapter preflight'}`);
        } catch (error) { blockers.push(`${phase}: ${error.message}`); }
      }
    }
    if (!adapters.finalCheck || typeof adapters.finalCheck.get !== 'function') blockers.push('finalCheck.get is required for the final independent GET check');
    if (!adapters.finalCheck || typeof adapters.finalCheck.verify !== 'function') blockers.push('finalCheck.verify is required for the final independent GET check');
  }

  if (!input || typeof input !== 'object' || Array.isArray(input)) blockers.push('product-only plan must be an object');
  else {
    if (Object.hasOwn(input, 'event') || Object.hasOwn(input, 'events')) blockers.push('event creation is explicitly prohibited for product-only execution');
    if (input.target !== undefined && !isNewTarget(input)) blockers.push("target mode must be explicit 'NEW' when target is supplied");
    if (!isNewTarget(input)) {
      try { nonemptyText(input.productId, 'productId'); } catch (error) { blockers.push(error.message); }
    } else {
      try { record(input.product, 'product'); } catch (error) { blockers.push('NEW target requires product: a normalized source-product object separate from basic'); }
      validateNewBinding(input, blockers);
    }
    for (const name of phasesFor(input, WRITE_PHASES)) {
      try { record(input[name], name); } catch (error) { blockers.push(error.message); }
    }
    const source = input.source;
    if (!source || typeof source !== 'object' || Array.isArray(source)) blockers.push('source rows and images are required');
    else {
      const rows = source.rows, images = source.images;
      if (!Array.isArray(rows) || rows.length === 0) blockers.push('source rows are incomplete');
      if (!Array.isArray(images) || images.length === 0) blockers.push('source images are incomplete');
      const rowIds = new Set();
      if (Array.isArray(rows)) for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id || rowIds.has(row.id)) blockers.push('source rows must have unique nonempty ids');
        else rowIds.add(row.id);
      }
      const imageIds = new Set();
      if (Array.isArray(images)) for (const image of images) {
        if (!image || typeof image !== 'object' || Array.isArray(image) || typeof image.id !== 'string' || !image.id || imageIds.has(image.id)) blockers.push('source images must have unique nonempty ids');
        else imageIds.add(image.id);
      }
      const displayImages = input.display?.images;
      if (!Array.isArray(displayImages) || displayImages.length === 0) blockers.push('display.images must include every required source image');
      else {
        const used = new Set();
        for (const image of displayImages) {
          const id = image?.sourceImageId;
          if (typeof id !== 'string' || !imageIds.has(id) || used.has(id)) blockers.push('display image source is missing or duplicated');
          else used.add(id);
        }
        if (input.display?.sourceMode!==undefined&&input.display.sourceMode!=='reference-subset') blockers.push('invalid display source mode');
        if (used.size !== imageIds.size&&input.display?.sourceMode!=='reference-subset') blockers.push('every supplied source image must be displayed; images cannot be silently skipped');
      }
      const days = input.itinerary;
      if (!Array.isArray(days) || days.length === 0) blockers.push('every itinerary day is required');
      else {
        const seenDays = new Set();
        for (let index = 0; index < days.length; index += 1) {
          const day = days[index];
          if (!day || typeof day !== 'object' || !Number.isInteger(day.day) || day.day !== index + 1 || seenDays.has(day.day)) blockers.push('itinerary days must be contiguous and ordered');
          else seenDays.add(day.day);
          if (typeof day?.sourceRowId !== 'string' || !rowIds.has(day.sourceRowId)) blockers.push('each itinerary day requires a complete source row');
        }
      }
    }
    if (input.seasonMode === 'excluded') {
      if (Object.hasOwn(input, 'season')) blockers.push('Excluded season mode requires plan.season to be absent');
    } else {
      try { record(input.season, 'season'); } catch (error) { blockers.push(error.message); }
    }
  }
  return { canExecute: blockers.length === 0, blockers };
}

/**
 * Reusable product-only, same-browser write coordinator. It supplies no ERP,
 * auth, content, image, or season implementation; callers inject guarded adapters.
 */
export class ProductOnlyExecutionCoordinator {
  constructor({ browser, approval, journal, adapters, preparation, clock = () => Date.now(), processingBudgetMs = DEFAULT_PROCESSING_BUDGET_MS, budgetMode = 'stop', resume } = {}) {
    if (typeof clock !== 'function') fail('clock must be a function');
    if (!Number.isSafeInteger(processingBudgetMs) || processingBudgetMs <= 0) fail('processingBudgetMs must be a positive integer');
    this.browser = browser;
    this.approval = approval;
    this.journal = journal;
    this.adapters = adapters;
    this.preparation = preparation;
    this.clock = clock;
    this.processingBudgetMs = processingBudgetMs;
    if (!['stop', 'report'].includes(budgetMode)) fail('budgetMode must be stop or report');
    this.budgetMode = budgetMode;
    this.resume = resume;
  }

  preflight(input) { return preflightProductOnlyExecution(input, this); }

  async execute(input) {
    const checked = this.preflight(input);
    if (!checked.canExecute) throw new TypeError(`Product-only execution blocked before approval claim: ${checked.blockers.join('; ')}`);
    const plan = freeze(clone(input));
    const newTarget = isNewTarget(plan);
    const binding = newTarget ? clone(plan.approvalBinding) : null;
    const pipelineStartedAt = this._now();
    const start = await this.journal.start({
      mode: 'wx',
      lifecycle: 'product-only-execution',
      target: clone(declaredTarget(plan)),
      approvalBinding: binding,
      phases: phasesFor(plan)
    });
    if (!start || start.mode !== 'wx' || typeof start.path !== 'string' || !start.path) fail('journal.start must durably create wx evidence and return its path');

    const preparationStartedAt = this._now();
    let preparationEvidence = null;
    if (this.preparation) {
      const proof = await this.preparation.prepare(freeze(clone(plan)), { stage: 'pre-approval', target: clone(declaredTarget(plan)), approvalBinding: clone(binding) });
      preparationEvidence = { status: 'pre-approval-prepared', proof: clone(proof ?? null) };
      await this._evidence(preparationEvidence);
    }
    const preApprovalActiveMs = this._elapsed(preparationStartedAt);
    const approvalStartedAt = this._now();
    const claimRequest = {
      kind: 'human-product-only-approval',
      target: clone(declaredTarget(plan)),
      ...(newTarget ? clone(binding) : { productId: plan.productId }),
      phases: phasesFor(plan),
      eventCreation: plan.departure?.create === true ? 'one-selected-departure' : 'prohibited'
    };
    const claim = await this.approval.claim(claimRequest);
    if (!claim || typeof claim !== 'object' || Array.isArray(claim)) fail('approval.claim must return an approval claim object');
    if (newTarget) this._assertClaimBinding(claim, claimRequest);
    const approvalFinishedAt = this._now();
    const postApprovalStartedAt = approvalFinishedAt;
    const activeElapsed = () => preApprovalActiveMs + this._elapsed(postApprovalStartedAt);
    let owned;
    try {
      owned = await this.browser.open();
      if (!owned || !owned.page || typeof owned.close !== 'function') fail('browser.open must return one owned page and close function');
      const page = owned.page;
      const targets = clone(this.resume?.targets ?? declaredTarget(plan));
      const results = clone(this.resume?.results ?? []);
      if (this.resume) {
        if (!plan.resumeFrom || typeof this.resume.verify !== 'function') fail('Resume requires a bound source and read-only verifier');
        const proof = await this.resume.verify(page);
        if (proof?.status !== 'saved-stages-reconciled') fail('Resume saved stages were not independently verified');
        await this._evidence({ status: 'resume-readback-verified', targets, proof });
      }
      const steps = [
        ...(this.adapters.media ? ['basic','media','shell'] : ['basic', 'display', 'content', 'shell']).map(phase => ({ phase })),
        ...plan.itinerary.map(day => ({ phase: 'day', day })),
        ...(plan.seasonMode === 'excluded' ? [] : [{ phase: 'season' }]),
        ...(plan.departure?.create === true ? [{ phase: 'departure' }] : [])
      ];
      if (this.resume && (!same(results.map(result => result.name), steps.slice(0, results.length).map(step => phaseName(step.phase, step.day))) || results.length >= steps.length || results.some(result => !result.verification))) fail('Resume phases are not an exact verified prefix');
      const startIndex = results.length;
      for (let index = startIndex; index < steps.length; index += 1) {
        const step = steps[index];
        const result = await this._writeAndVerify({ page, plan, phase: step.phase, day: step.day, targets, results, claim, binding, activeElapsed, pipelineStartedAt });
        results.push(result);
        this._bindReceiptTarget({ newTarget, phase: step.phase, receipt: result.receipt, targets });
        if (this.budgetMode === 'stop' && activeElapsed() > this.processingBudgetMs && index + 1 < steps.length) {
          const finalCheck = { status: 'not-run', reason: 'incomplete-after-budget-overrun' };
          await this._evidence({ status: 'budget-overrun', reconciledPhase: result.name, elapsedMs: activeElapsed(), budgetMs: this.processingBudgetMs, finalCheck });
          throw new ProcessingBudgetExceededError({ elapsedMs: activeElapsed(), budgetMs: this.processingBudgetMs, reconciledPhase: result.name, finalCheck });
        }
      }

      const finalContext = this._context({ phase: 'final-get', targets, results, claim, binding, activeElapsed, pipelineStartedAt });
      const finalPlan = this._adapterPlan(plan, targets);
      const finalRead = await this.adapters.finalCheck.get(page, finalPlan, clone(finalContext));
      const finalVerified = await this.adapters.finalCheck.verify(page, clone(finalRead), { plan: finalPlan, ...clone(finalContext) });
      if (!finalVerified) throw new Error('final independent GET check did not verify the product-only result');
      const finalCheck = { status: 'verified', result: clone(finalRead), verification: clone(finalVerified) };
      await this._evidence({ status: 'final-get-verified', finalCheck, targets: clone(targets) });
      await releaseStageTransport(page);
      const elapsedMs = activeElapsed();
      const overBudget = elapsedMs > this.processingBudgetMs;
      if (overBudget) await this._evidence({ status: 'budget-overrun-final-verified', elapsedMs, budgetMs: this.processingBudgetMs, finalCheck });
      return {
        status: overBudget ? 'completed-over-budget' : 'completed',
        approval: { claimId: claim.id ?? null, waitMs: approvalFinishedAt - approvalStartedAt },
        targets: clone(targets),
        processingMs: this._elapsed(postApprovalStartedAt),
        timing: {
          preApprovalActiveMs,
          approvalWaitMs: approvalFinishedAt - approvalStartedAt,
          postApprovalActiveMs: this._elapsed(postApprovalStartedAt),
          activeProcessingMs: activeElapsed(),
          pipelineMs: this._elapsed(pipelineStartedAt)
        },
        budget: { budgetMs: this.processingBudgetMs, elapsedMs, exceeded: overBudget, mode: this.budgetMode },
        phases: results,
        finalCheck
      };
    } finally {
      if (owned) await owned.close();
    }
  }

  _assertClaimBinding(claim, request) {
    if (claim.planDigest !== request.planDigest) fail('approval claim planDigest does not bind the approved plan');
    if (claim.scopeDigest !== request.scopeDigest) fail('approval claim scopeDigest does not bind the approved scope');
    if (!same(claim.target, request.target)) fail('approval claim target does not bind the approved NEW target');
  }

  _bindReceiptTarget({ newTarget, phase, receipt, targets }) {
    if (!newTarget) return;
    if (phase === 'basic') {
      positiveSafeInteger(receipt.productId, 'NEW basic receipt productId');
      nonemptyText(receipt.masterCode, 'NEW basic receipt masterCode');
      targets.productId = receipt.productId;
      targets.masterCode = receipt.masterCode;
    }
    if (phase === 'shell') {
      positiveSafeInteger(receipt.scheduleId, 'NEW shell receipt scheduleId');
      targets.scheduleId = receipt.scheduleId;
    }
  }

  _now() {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) fail('clock must return a nonnegative safe integer');
    return value;
  }

  _elapsed(startedAt) { return this._now() - startedAt; }

  _assertBudgetBeforeWrite(activeElapsed) {
    const elapsedMs = activeElapsed();
    if (this.budgetMode === 'stop' && elapsedMs > this.processingBudgetMs) throw new ProcessingBudgetExceededError({ elapsedMs, budgetMs: this.processingBudgetMs });
  }

  async _evidence(value) {
    const evidence = clone(value);
    await this.journal.append(evidence);
    await this.journal.checkpoint(evidence);
  }

  _adapterPlan(plan, targets) {
    const executionPlan = clone(plan);
    executionPlan.target = clone(targets);
    return freeze(executionPlan);
  }

  _context({ phase, day = null, targets, results, claim, binding, activeElapsed, pipelineStartedAt }) {
    return {
      phase,
      day: day ? clone(day) : null,
      targets: clone(targets),
      verifiedPreviousPhases: clone(results),
      approvalClaim: clone(claim),
      approvalBinding: clone(binding),
      processingBudgetMs: this.processingBudgetMs,
      activeProcessingMs: activeElapsed(),
      pipelineElapsedMs: this._elapsed(pipelineStartedAt)
    };
  }

  async _writeAndVerify({ page, plan, phase, day, targets, results, claim, binding, activeElapsed, pipelineStartedAt }) {
    const startedAt = this._now();
    this._assertBudgetBeforeWrite(activeElapsed);
    const adapter = this.adapters[phase];
    const name = phaseName(phase, day);
    const context = this._context({ phase: name, day, targets, results, claim, binding, activeElapsed, pipelineStartedAt });
    await this._evidence({ status: 'before-write', phase: name, targets: clone(targets), verifiedPreviousPhases: clone(results), activeProcessingMs: activeElapsed() });
    let attempted = false;
    try {
      attempted = true;
      const receipt = await adapter.save(page, this._adapterPlan(plan, targets), clone(context));
      if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) throw new Error('adapter returned no save receipt');
      const verification = await adapter.verifyReceipt(page, clone(receipt), clone(context));
      if (!verification) throw new Error('adapter receipt verifier did not verify the save');
      const result = { name, durationMs: this._elapsed(startedAt), ...(phase === 'media' ? {covers:['display','content']} : {}), receipt: clone(receipt), verification: clone(verification) };
      await this._evidence({ status: 'receipt-verified', phase: name, result, targets: clone(targets) });
      return result;
    } catch (cause) {
      if (!attempted) throw cause;
      const outcome = { status: 'unknown-save-outcome', phase: name, message: String(cause?.message ?? cause).slice(0, 4096) };
      try { await this._evidence(outcome); } catch (journalCause) { cause.journalCause = journalCause; }
      throw new UnknownSaveOutcomeError(name, cause);
    }
  }
}
