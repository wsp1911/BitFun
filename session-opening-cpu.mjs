// Temporary CPU attribution. Raw profiles stay in memory; never persist URLs,
// source text or arbitrary function names. Times share CDP's monotonic clock.
const functions = new Set(`commitRoot commitRootImpl commitMutationEffects commitMutationEffectsOnFiber
commitLayoutEffects commitLayoutEffectOnFiber commitLayoutMountEffects_complete commitLayoutEffects_begin
commitPassiveMountEffects commitPassiveMountOnFiber commitPassiveUnmountEffects commitPassiveUnmountOnFiber
commitHookEffectListMount commitHookEffectListUnmount flushPassiveEffects flushPassiveEffectsImpl
flushSyncCallbacks flushSync performSyncWorkOnRoot performConcurrentWorkOnRoot performWorkUntilDeadline
renderRootSync renderRootConcurrent workLoopSync workLoopConcurrent workLoop performUnitOfWork
beginWork beginWork$1 completeWork completeUnitOfWork renderWithHooks updateFunctionComponent
updateForwardRef updateMemoComponent updateSimpleMemoComponent reconcileChildren reconcileChildrenArray
dispatchSetState dispatchReducerAction scheduleUpdateOnFiber scheduleCallback
SessionScene ChatPaneInner ChatInput AppLayout ModernFlowChatContainer VirtualMessageList
useFlowChatVirtualizer useRollingTextMotion getSnapshot subscribe getState setState
(root) (program) (idle)`.split(/\s+/));
// Multiword V8 pseudo frames are explicit too.
for (const name of ['(garbage collector)']) functions.add(name);
function label(frame = {}) {
  if (functions.has(frame.functionName)) return frame.functionName;
  // Only fixed app source basenames and numeric locations; no raw source URLs.
  const appFiles = /\/(AppLayout|SessionScene|ChatPane|ChatInput|ModernFlowChatContainer|VirtualMessageList|useFlowChatVirtualizer|useRollingTextMotion)\.tsx?(?:\?|$)/;
  if (/^http:\/\/(localhost|127\.0\.0\.1):1422\//.test(frame.url ?? '')) {
    const file = appFiles.exec(frame.url)?.[1];
    if (file && Number.isInteger(frame.lineNumber)) return `${file}:${frame.lineNumber + 1}`;
  }
  return 'other';
}

export function openingCpuWindows(pipeline, rows = []) {
  const events = pipeline?.events ?? [];
  const notified = events.find(e => e.stage === 'virtualizer.rect.afterNotify');
  const rendered = events.find(e => e.stage === 'list.renderAttempt' && e.atMs > notified?.atMs);
  if (!notified || !rendered) return [];
  const work = (pipeline.workBeforeFirstRow ?? []).filter(w =>
    w.startMs >= notified.atMs && w.startMs + w.durationMs <= rendered.atMs);
  const lastEffect = Math.max(notified.atMs, ...work.map(w => w.startMs + w.durationMs));
  const windows = [
    { name: 'notify-to-list-render', fromMs: notified.atMs, toMs: rendered.atMs },
    { name: 'after-covered-effects', fromMs: lastEffect, toMs: rendered.atMs },
  ];
  const ranges = rows.filter(r => r.loc === 'virtualizer.rangeDecision');
  const firstCommit = rows.find(r => r.loc === 'virtualizer.commitState' && r.data?.renderedRowCount > 0);
  const secondRange = firstCommit && ranges.find(r => r.sinceOpenMs > firstCommit.sinceOpenMs);
  const reveal = rows.find(r => r.loc === 'viewport.reveal.commit' && r.data?.phase === 'after');
  const add = (name, fromMs, toMs) => {
    if (Number.isFinite(fromMs) && Number.isFinite(toMs) && toMs > fromMs) windows.push({ name, fromMs, toMs });
  };
  add('first-rows-render-through-measure', rendered.atMs, firstCommit?.sinceOpenMs);
  add('first-measured-commit-to-next-range', firstCommit?.sinceOpenMs, secondRange?.sinceOpenMs);
  add('next-range-to-reveal', secondRange?.sinceOpenMs, reveal?.sinceOpenMs);
  const requested = events.find(e => e.stage === 'opening.reveal.requested');
  add('reveal-request-to-commit', requested?.atMs, reveal?.sinceOpenMs);
  return windows;
}

export function summarizeOpeningCpu(profile, openingTs, windows) {
  const nodes = new Map(profile.nodes.map(n => [n.id, n]));
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const round = n => Math.round(n * 10) / 10;
  // V8 samples can arrive out of timestamp order. Preserve signed deltas when
  // reconstructing absolute times, then sort; never stop at a negative delta.
  const timed = [];
  let timestamp = profile.startTime, negativeDeltas = 0, invalidDeltaIndex = null;
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const delta = profile.timeDeltas?.[i];
    if (!Number.isFinite(delta)) { invalidDeltaIndex = i; break; }
    if (delta < 0) negativeDeltas++;
    timestamp += delta;
    timed.push({ ts: timestamp, id: profile.samples[i] });
  }
  timed.sort((a, b) => a.ts - b.ts);
  const metadata = {
    nodes: nodes.size, rawSamples: profile.samples?.length ?? 0,
    timeDeltas: profile.timeDeltas?.length ?? 0, parsedSamples: timed.length,
    negativeDeltas, invalidDeltaIndex,
    profileStartMs: round((profile.startTime - openingTs) / 1000),
    profileEndMs: round((profile.endTime - openingTs) / 1000),
    firstSampleMs: timed.length ? round((timed[0].ts - openingTs) / 1000) : null,
    lastSampleMs: timed.length ? round((timed.at(-1).ts - openingTs) / 1000) : null,
  };
  return {
    samplingIntervalUs: 1000,
    metadata,
    windowStatus: windows.length ? 'available' : 'missing-pipeline-boundaries',
    note: 'Statistical sample weights, not exact function durations. Inclusive frames overlap; other means an unlisted function. CPU sampling changes timings.',
    windows: windows.map(window => {
      const from = openingTs + window.fromMs * 1000, to = openingTs + window.toMs * 1000;
      const self = new Map(), inclusive = new Map(), stacks = new Map();
      let previous = profile.startTime, count = 0, covered = 0, maxSampleGapMs = 0;
      for (const sample of timed) {
        const ts = sample.ts;
        const delta = Math.max(0, ts - previous);
        const weight = Math.max(0, Math.min(ts, to) - Math.max(previous, from)) / 1000;
        previous = Math.max(previous, ts);
        if (!weight) continue;
        count++; covered += weight;
        maxSampleGapMs = Math.max(maxSampleGapMs, delta / 1000);
        const chain = [], seen = new Set();
        let id = sample.id;
        while (nodes.has(id) && !seen.has(id) && chain.length < 128) {
          seen.add(id); chain.push(label(nodes.get(id).callFrame)); id = parents.get(id);
        }
        const add = (map, key) => map.set(key, (map.get(key) ?? 0) + weight);
        add(self, chain[0] ?? 'other');
        for (const name of new Set(chain)) add(inclusive, name);
        add(stacks, chain.slice(0, 16).reverse().join(' > '));
      }
      const rank = map => [...map].sort((a, b) => b[1] - a[1]).slice(0, 24)
        .map(([name, ms]) => ({ name, sampleMs: round(ms) }));
      return { ...window, samples: count, coveredMs: round(covered), maxSampleGapMs: round(maxSampleGapMs),
        sampleStatus: count === 0 ? 'no-overlapping-samples'
          : invalidDeltaIndex !== null || covered < window.toMs - window.fromMs - 0.1 ? 'partial' : 'available',
        profileCoversWindow: profile.startTime <= from && profile.endTime >= to,
        self: rank(self), inclusive: rank(inclusive), stacks: rank(stacks) };
    }),
  };
}
