// Internal lifecycle for one-use guarded writes in the same owned context.
// Next stage installs a deny-by-default guard BEFORE releasing its predecessor.
const contexts = new WeakMap();
export async function installStageTransport(page, key, install) {
  if (typeof key !== 'string' || !key || typeof install !== 'function') throw new TypeError('Invalid stage transport');
  const context=page.context(), prior=contexts.get(context);
  if (prior && !prior.verified) throw new Error('Prior stage is not verified; reconcile before continuing');
  const used=new Set(prior?.used ?? []);
  if (used.has(key)) throw new Error('Stage transport already used; no retry');
  used.add(key);
  const current={used,verified:false,dispose:null};
  contexts.set(context,current); // reserve synchronously against concurrent install
  try {
    const dispose=await install();
    if (typeof dispose !== 'function') throw new TypeError('Missing stage transport cleanup');
    current.dispose=dispose;
    await prior?.dispose();
  } catch(error) { await context.close().catch(()=>{}); throw error; }
  return Object.freeze({verify(){
    if(contexts.get(context)!==current || !current.dispose) throw new Error('Stale stage verification');
    current.verified=true;
  }});
}

// The last stage has no successor to release it, so a finished run must end the chain explicitly;
// otherwise its deny-by-default guard keeps blocking later writes (day contents, extra options) in
// the same dedicated browser. Used keys survive so a finished stage still cannot be replayed.
export async function releaseStageTransport(page) {
  const context = typeof page?.context === 'function' ? page.context() : null, current = context && contexts.get(context);
  if (!current) return false;
  if (!current.verified || !current.dispose) throw new Error('Last stage is not verified; keep the context guarded');
  const dispose = current.dispose;
  contexts.set(context, { used: current.used, verified: true, dispose: async () => {} });
  await dispose();
  return true;
}
