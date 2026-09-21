import assert from 'node:assert/strict';
import test from 'node:test';
import { selectEngineEvent, summarizeEngineTrace, readTraceStream, shouldStopDetails, describeStyleNodes, captureResetReason } from './capture-session-opening.mjs';

const event = (name, ts, extra = {}) => ({ name, ts, pid: 1, tid: 2, ph: 'X', ...extra });
const start = event('openbitfun-opening:abc-1:start', 100_000, { ph: 'I' });
const reveal = event('openbitfun-opening:abc-1:reveal', 300_000, { ph: 'I' });
const end = event('openbitfun-opening:abc-1:end', 15_100_000, { ph: 'I' });
const select = values => values.map(selectEngineEvent).filter(Boolean);

test('clean capture rejects reloads, truncation and a replaced log even after export', () => {
  const opening = { traceId: 'current', msg: 'opening started' };
  const baseline = { reloaded: false, previousBytes: 100, bytes: 200, opening, rows: [opening] };
  assert.equal(captureResetReason(baseline), null);
  assert.equal(captureResetReason({ ...baseline, reloaded: true }), 'page reloaded');
  assert.equal(captureResetReason({ ...baseline, bytes: 0, rows: [] }), 'log cleared');
  // A clear followed by a larger new log must not make an older result valid.
  assert.equal(captureResetReason({ ...baseline, rows: [{ traceId: 'new', msg: 'opening started' }] }), 'opening removed from log');
  assert.equal(captureResetReason({ ...baseline, opening: undefined, previousBytes: 0, rows: [] }), null);
});

test('filters private strings and retains only selected engine facts', () => {
  const result = selectEngineEvent(event('Layout', 110_000, { dur: 10_000, args: { beginData: {
    dirtyObjects: 17, totalObjects: 500, nodeId: 3, url: 'private-url', stackTrace: 'private-stack',
    selector: 'private-selector', text: 'private-message',
  } } }));
  assert.deepEqual(result.counts, { dirtyObjects: 17, totalObjects: 500, nodeId: 3 });
  assert.ok(!JSON.stringify(result).includes('private'));
  assert.equal(selectEngineEvent(event('ResourceSendRequest', 100_000)), null);
  assert.equal(selectEngineEvent(event('private-performance-mark', 100_000)), null);
});

test('aligns by opening markers, ignores other renderers and separates pre-reveal work', () => {
  const summary = summarizeEngineTrace(select([start,
    event('UpdateLayoutTree', 110_000, { dur: 123_900 }),
    event('Layout', 234_000, { dur: 1000 }),
    event('Layout', 240_000, { dur: 99_000, tid: 99 }),
    event('LayoutInvalidationTracking', 109_000, { ph: 'I' }),
    reveal, event('Paint', 310_000, { dur: 20_000 }), end,
  ]), 'abc-1');
  assert.equal(summary.complete, true);
  assert.equal(summary.revealMs, 200);
  assert.equal(summary.durationMs, 15_000);
  assert.deepEqual(summary.beforeReveal, [
    { name: 'UpdateLayoutTree', count: 1, totalMs: 123.9, maxMs: 123.9 },
    { name: 'Layout', count: 1, totalMs: 1, maxMs: 1 },
  ]);
  assert.equal(summary.fullWindow.find(phase => phase.name === 'Paint').totalMs, 20);
  assert.equal(summary.invalidationCounts.LayoutInvalidationTracking, 1);
  assert.equal(summary.slowEvents[0].atMs, 10);
});

test('handles nested begin/end phase events without adding different engine phases', () => {
  const summary = summarizeEngineTrace(select([start,
    event('UpdateLayoutTree', 110_000, { ph: 'B' }),
    event('Layout', 120_000, { ph: 'B' }),
    event('Layout', 130_000, { ph: 'E' }),
    event('UpdateLayoutTree', 150_000, { ph: 'E' }), reveal, end,
  ]), 'abc-1');
  assert.equal(summary.complete, true);
  assert.equal(summary.beforeReveal.find(phase => phase.name === 'UpdateLayoutTree').totalMs, 40);
  assert.equal(summary.beforeReveal.find(phase => phase.name === 'Layout').totalMs, 10);
});

test('marks missing end markers, dropped events and buffer loss as incomplete', () => {
  assert.equal(summarizeEngineTrace(select([start, reveal]), 'abc-1').complete, false);
  assert.equal(summarizeEngineTrace(select([start, reveal, end]), 'abc-1', 1).complete, false);
  assert.equal(summarizeEngineTrace(select([start, reveal, end]), 'abc-1', 0, true).complete, false);
  assert.throws(() => summarizeEngineTrace(select([end]), 'abc-1'), /start marker missing/);
});

test('reads a fragmented trace stream and always closes it after filtering', async () => {
  const raw = Buffer.from(JSON.stringify({ traceEvents: [start, event('Layout', 110_000, { dur: 2000 }), end,
    event('Ignored', 150_000, { args: { text: 'private-正文' } })] }));
  const cut = raw.indexOf(Buffer.from('正文')) + 1;
  const chunks = [raw.subarray(0, cut), raw.subarray(cut)];
  const methods = [];
  const cdp = { async call(method) {
    methods.push(method);
    if (method === 'IO.close') return {};
    return { data: chunks.shift().toString('base64'), base64Encoded: true, eof: chunks.length === 0 };
  } };
  const selected = [];
  const transfer = await readTraceStream(cdp, 'stream1', event => selected.push(event));
  assert.equal(transfer.bytes, raw.length);
  assert.equal(transfer.rawEventCount, 4);
  assert.equal(selected.length, 3);
  assert.ok(!JSON.stringify(selected).includes('private'));
  assert.deepEqual(methods, ['IO.read', 'IO.read', 'IO.close']);
});

test('closes a broken stream even when trace JSON cannot be decoded', async () => {
  const methods = [];
  const cdp = { async call(method) {
    methods.push(method);
    return method === 'IO.read' ? { data: '{broken', eof: true } : {};
  } };
  await assert.rejects(readTraceStream(cdp, 'stream1', () => {}));
  assert.deepEqual(methods, ['IO.read', 'IO.close']);
});

test('retains safe invalidation reasons and numeric resolution IDs but excludes private payloads', () => {
  const selected = select([
    event('StyleRecalcInvalidationTracking', 101000, { args: { data: {
      nodeId: 19, reason: 'Animation', subtree: true, nodeName: 'private', extraData: 'private' } } }),
    event('StyleInvalidatorInvalidationTracking', 102000, { args: { data: { reason: 'private' } } }),
    event('StyleResolver::ResolveStyle', 103000, { args: { data: { nodeId: 19, parentNodeId: 18, pseudoId: 0 } } }),
  ]);
  assert.equal(selected[0].reason, 'Animation');
  assert.equal(selected[0].subtree, true);
  assert.equal(selected[1].reason, 'other');
  assert.equal(selected[2].counts.parentNodeId, 18);
  assert.ok(!JSON.stringify(selected).includes('private'));
});

test('short window separates invalidations from in-update resolutions and merges end counts', () => {
  const invalidation = (ts, nodeId) => event('StyleRecalcInvalidationTracking', ts, {
    ph: 'I', args: { data: { nodeId, reason: 'Animation' } } });
  const summary = summarizeEngineTrace(select([start, invalidation(105000, 8),
    event('UpdateLayoutTree', 110000, { ph: 'B' }),
    event('StyleResolver::ResolveStyle', 115000, { ph: 'I', args: { data: { nodeId: 8 } } }),
    event('UpdateLayoutTree', 150000, { ph: 'E', args: { endData: { elementCount: 100 } } }),
    invalidation(155000, 9), event('UpdateLayoutTree', 160000, { dur: 10000 }),
    reveal, invalidation(301000, 10),
  ]), 'abc-1', 0, false, { shortWindow: true });
  assert.equal(summary.complete, true);
  assert.equal(summary.coverage, 'opening-through-reveal');
  assert.equal(summary.durationMs, 201);
  const details = summary.styleDetails;
  assert.equal(details.beforeReveal.invalidations, 2);
  assert.equal(details.afterReveal.invalidations, 1);
  assert.equal(details.slowUpdates[0].elementCount, 100);
  assert.equal(details.slowUpdates[0].during.resolutions, 1);
  assert.equal(details.slowUpdates[0].preceding.topNodes[0].nodeId, 8);
  assert.equal(details.slowUpdates[1].preceding.topNodes[0].nodeId, 9);
  assert.equal(details.slowUpdates[1].preceding.invalidations, 1);
  assert.equal(summarizeEngineTrace(select([start]), 'abc-1', 0, false, { shortWindow: true }).complete, false);
});

test('detail stop ignores other openings and bounds a missing reveal', () => {
  const row = { traceId: 'abc-1', loc: 'viewport.reveal.commit', data: { phase: 'after' } };
  assert.equal(shouldStopDetails([row], 'abc-1', 1000, 1100), 'reveal');
  assert.equal(shouldStopDetails([row], 'other', 1000, 1100), null);
  assert.equal(shouldStopDetails([], 'abc-1', 1000, 4000), 'opening-timeout');
});

test('detail stream filters idle and other renderer events even with out-of-order buffers', async () => {
  const raw = JSON.stringify({ traceEvents: [event('Layout', 120000, { dur: 5000 }),
    event('Layout', 90000, { dur: 5000 }), start, reveal,
    event('Layout', 130000, { dur: 5000, pid: 99 })] });
  const cdp = { async call(method) { return method === 'IO.read' ? { data: raw, eof: true } : {}; } };
  const events = [];
  await readTraceStream(cdp, 'stream', e => events.push(e), { openingTraceId: 'abc-1' });
  assert.equal(events.length, 3);
  assert.equal(summarizeEngineTrace(events, 'abc-1', 0, false, { shortWindow: true }).beforeReveal[0].totalMs, 5);
  await assert.rejects(readTraceStream(cdp, 'stream', () => {}, { openingTraceId: 'missing' }), /start marker missing/);
});

test('node resolution deduplicates hotspots, reports detached nodes and releases handles', async () => {
  const methods = [];
  const cdp = { async call(method, params) {
    methods.push(method);
    if (method === 'DOM.resolveNode') {
      if (params.backendNodeId === 2) throw new Error('Detached');
      return { object: { objectId: 'node1' } };
    }
    if (method === 'Runtime.callFunctionOn') return { result: { value: { available: true, regions: ['row'], rowIndex: 27 } } };
    return {};
  } };
  const group = { topNodes: [{ nodeId: 1 }, { nodeId: 2 }] };
  const nodes = await describeStyleNodes(cdp, { beforeReveal: group, afterReveal: group, slowUpdates: [] });
  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].rowIndex, 27);
  assert.deepEqual(nodes[1], { nodeId: 2, available: false });
  assert.equal(methods.at(-1), 'Runtime.releaseObjectGroup');
});
