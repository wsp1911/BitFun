import assert from 'node:assert/strict';
import test from 'node:test';
import { openingCpuWindows, summarizeOpeningCpu } from './session-opening-cpu.mjs';

test('selects the post-notification render and excludes work outside the gap', () => {
  const windows = openingCpuWindows({ events: [
    { stage: 'list.renderAttempt', atMs: 1 },
    { stage: 'virtualizer.rect.afterNotify', atMs: 10 },
    { stage: 'list.renderAttempt', atMs: 30 },
  ], workBeforeFirstRow: [
    { startMs: 12, durationMs: 3 }, { startMs: 40, durationMs: 10 },
  ] });
  assert.deepEqual(windows, [
    { name: 'notify-to-list-render', fromMs: 10, toMs: 30 },
    { name: 'after-covered-effects', fromMs: 15, toMs: 30 },
  ]);
  assert.deepEqual(openingCpuWindows(), []);
});

test('aligns sample weights, clips at gap boundaries, and redacts private frames', () => {
  const profile = { startTime: 100000, endTime: 110000, nodes: [
    { id: 1, callFrame: { functionName: 'commitRootImpl' }, children: [2] },
    { id: 2, callFrame: { functionName: 'privateFunction', url: 'private-url' }, children: [3] },
    { id: 3, callFrame: { functionName: 'flushPassiveEffects' } },
  ], samples: [3, 2, 3], timeDeltas: [2000, 4000, 4000] };
  const result = summarizeOpeningCpu(profile, 100000, [{ name: 'gap', fromMs: 1, toMs: 7 }]);
  const window = result.windows[0];
  assert.equal(window.coveredMs, 6);
  assert.equal(window.samples, 3);
  assert.equal(window.maxSampleGapMs, 4);
  assert.equal(window.profileCoversWindow, true);
  assert.deepEqual(window.self, [{ name: 'other', sampleMs: 4 }, { name: 'flushPassiveEffects', sampleMs: 2 }]);
  assert.equal(window.inclusive.find(x => x.name === 'commitRootImpl').sampleMs, 6);
  assert.ok(!JSON.stringify(result).includes('private'));
  const uncovered = summarizeOpeningCpu(profile, 120000, [{ name: 'gap', fromMs: 0, toMs: 5 }]).windows[0];
  assert.equal(uncovered.profileCoversWindow, false);
  assert.equal(uncovered.samples, 0);
});

test('only fixed app source filenames survive and stack summaries stay bounded', () => {
  const nodes = Array.from({ length: 40 }, (_, i) => ({ id: i + 1,
    callFrame: { functionName: 'secret', url: i % 2
      ? 'http://localhost:1422/src/ChatInput.tsx?private-token'
      : 'https://private-host/ChatInput.tsx', lineNumber: i },
    children: i < 39 ? [i + 2] : [],
  }));
  const result = summarizeOpeningCpu({ nodes, startTime: 0, endTime: 1000,
    samples: [40], timeDeltas: [1000] }, 0, [{ name: 'gap', fromMs: 0, toMs: 1 }]);
  const serialized = JSON.stringify(result);
  assert.ok(!/secret|private|https?:/.test(serialized));
  assert.ok(serialized.includes('ChatInput:40'));
  assert.equal(result.windows[0].stacks[0].name.split(' > ').length, 16);
});

test('negative deltas do not discard the subsequent opening samples', () => {
  const profile = { startTime: 0, endTime: 10000,
    nodes: [{ id: 1, callFrame: { functionName: 'flushPassiveEffects' } }],
    samples: [1, 1, 1, 1], timeDeltas: [3000, -1000, 4000, 4000] };
  const result = summarizeOpeningCpu(profile, 0, [{ name: 'gap', fromMs: 4, toMs: 8 }]);
  assert.equal(result.metadata.negativeDeltas, 1);
  assert.equal(result.metadata.parsedSamples, 4);
  assert.equal(result.windows[0].coveredMs, 4);
  assert.equal(result.windows[0].sampleStatus, 'available');
});

test('includes the measured first batch, delayed range, and reveal commit windows', () => {
  const windows = openingCpuWindows({ events: [
    { stage: 'virtualizer.rect.afterNotify', atMs: 10 },
    { stage: 'list.renderAttempt', atMs: 30 },
    { stage: 'opening.reveal.requested', atMs: 290 },
  ] }, [
    { loc: 'virtualizer.commitState', sinceOpenMs: 12, data: { renderedRowCount: 0 } },
    { loc: 'virtualizer.rangeDecision', sinceOpenMs: 31 },
    { loc: 'virtualizer.commitState', sinceOpenMs: 100, data: { renderedRowCount: 7 } },
    { loc: 'virtualizer.rangeDecision', sinceOpenMs: 200 },
    { loc: 'viewport.reveal.commit', sinceOpenMs: 320, data: { phase: 'after' } },
  ]);
  assert.deepEqual(windows.slice(2), [
    { name: 'first-rows-render-through-measure', fromMs: 30, toMs: 100 },
    { name: 'first-measured-commit-to-next-range', fromMs: 100, toMs: 200 },
    { name: 'next-range-to-reveal', fromMs: 200, toMs: 320 },
    { name: 'reveal-request-to-commit', fromMs: 290, toMs: 320 },
  ]);
});

test('empty and truncated profiles expose why bounds alone do not prove samples', () => {
  const profile = { startTime: 0, endTime: 10000, nodes: [], samples: [], timeDeltas: [] };
  const empty = summarizeOpeningCpu(profile, 0, [{ name: 'gap', fromMs: 4, toMs: 8 }]);
  assert.equal(empty.windows[0].profileCoversWindow, true);
  assert.equal(empty.windows[0].sampleStatus, 'no-overlapping-samples');
  assert.equal(empty.metadata.rawSamples, 0);
  const broken = summarizeOpeningCpu({ ...profile, samples: [1, 1], timeDeltas: [1000] }, 0, []);
  assert.equal(broken.metadata.invalidDeltaIndex, 1);
  assert.equal(broken.metadata.parsedSamples, 1);
});
