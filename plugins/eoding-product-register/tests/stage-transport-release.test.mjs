import assert from 'node:assert/strict';
import test from 'node:test';
import { installStageTransport, releaseStageTransport } from '../src/stage-transport.mjs';

function fakePage() {
  const context = { closed: false, async close() { this.closed = true; } };
  return { context: () => context };
}
function guardFor(log, name) {
  return async () => { log.push(`install:${name}`); return async () => { log.push(`dispose:${name}`); }; };
}

test('a finished run releases the last verified stage guard exactly once', async () => {
  const page = fakePage(), log = [];
  const first = await installStageTransport(page, 'shell:1', guardFor(log, 'shell'));
  first.verify();
  const last = await installStageTransport(page, 'final-read:1', guardFor(log, 'final'));
  last.verify();
  assert.deepEqual(log, ['install:shell', 'install:final', 'dispose:shell']);
  assert.equal(await releaseStageTransport(page), true);
  assert.deepEqual(log.slice(3), ['dispose:final']);
  assert.equal(await releaseStageTransport(page), true);
  assert.deepEqual(log.slice(3), ['dispose:final'], 'a second release must not dispose again');
});

test('after release a new stage installs cleanly but a finished stage key cannot be replayed', async () => {
  const page = fakePage(), log = [];
  (await installStageTransport(page, 'final-read:1', guardFor(log, 'final'))).verify();
  await releaseStageTransport(page);
  const next = await installStageTransport(page, 'day-contents:2', guardFor(log, 'next'));
  next.verify();
  assert.deepEqual(log, ['install:final', 'dispose:final', 'install:next']);
  await assert.rejects(installStageTransport(page, 'final-read:1', guardFor(log, 'replay')), /already used/);
});

test('an unverified last stage stays guarded', async () => {
  const page = fakePage(), log = [];
  await installStageTransport(page, 'final-read:1', guardFor(log, 'final'));
  await assert.rejects(releaseStageTransport(page), /not verified/);
  assert.deepEqual(log, ['install:final']);
});

test('release is a no-op for pages without a stage chain', async () => {
  assert.equal(await releaseStageTransport(fakePage()), false);
  assert.equal(await releaseStageTransport({}), false);
});
