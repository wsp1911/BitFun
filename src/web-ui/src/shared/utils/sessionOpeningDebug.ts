import { elapsedMs, nowMs } from './timing';
import { createElement, Profiler, useEffect, useLayoutEffect, type ReactNode, type DependencyList, type EffectCallback, type ProfilerOnRenderCallback } from 'react';
// #region agent log
import { installOpeningGeometryProbe } from './sessionOpeningGeometryProbe';
import { collectOpeningLayoutContext } from './sessionOpeningLayoutContext';
// #endregion

// #region agent log
const DEBUG_ENDPOINT = 'http://127.0.0.1:7469/log';
// Temporary, development-only A/B arm. Leave disabled after the negative run.
// Keep it stable for the scroller lifetime: toggling at reveal would add another
// invalidation. The fixed-size scroller is the boundary, never the measured rows.
// Baseline: two first-row reads flushed 111.6/179.3 ms with only 517/842 DOM
// elements in the pane. With size/layout containment confirmed by computed
// styles, reads were 112.9/196.0 ms and reveal 670.1 -> 688.8 ms; row geometry
// stayed equal. No demonstrated benefit, so retain the probes with treatment off.
const ENABLE_SCROLLER_CONTAINMENT_EXPERIMENT = false;
export const openingScrollerContainment = import.meta.env.DEV && ENABLE_SCROLLER_CONTAINMENT_EXPERIMENT
  ? 'layout size' : undefined;
// The document style preflight absorbed 123.9/194.4 ms before two row reads.
// Test the named container-query dependency while retaining inline-size
// containment and exactly the same reading-column formulas. Not a proven fix.
// Negative A/B: confirmed name=none/type=inline-size, unchanged row heights;
// preflight 318.3 -> 312.0 ms, reveal 696.6 -> 698.5 ms. Keep treatment off.
const ENABLE_CONTAINER_QUERY_BYPASS_EXPERIMENT = false;
export const openingContainerQueryBypass = import.meta.env.DEV && ENABLE_CONTAINER_QUERY_BYPASS_EXPERIMENT;
const pageId = Date.now().toString(36);
let sequence = 0;
let trace: { traceId: string; sessionId: string; startedAt: number; count: number; source: string } | undefined;
let stopMonitoring: (() => void) | undefined;
const spans = new Map<string, { count: number; totalMs: number; maxMs: number; emitted: number }>();
const outcomes = new Map<string, number>();
const measurementCounts = new Map<string, number>();
let measurementNodeIds = new WeakMap<Element, number>();
let omittedMeasurementCalls = 0;
const openingEventCounts = new Map<string, number>();
let nextMeasurementNodeId = 0;
let mutationObserver: MutationObserver | undefined;
let mutationCounts = { childList: 0, attributes: 0, characterData: 0 };
let lastMutationAt: number | undefined;
let mutationBatch = 0;
let mutationProbeMs = 0;
let styleReadSamples = 0;
const rowStylePreflightBatches = new Set<number>();
const revealProbePhases = new Set<string>();
// In-memory only during opening: no per-row/per-Markdown network writes.
// React durations nest and exclude layout effects/ref measurements. Commit time
// is the start of commit, NOT the time DOM measurement/paint has completed.
const pipelineEvents: { stage: string; atMs: number; data: Record<string, number> }[] = [];
const pipelineCounts = new Map<string, number>();
const pipelineWork: { stage: string; startMs: number; durationMs: number }[] = [];
let omittedPipelineWork = 0;
// Restrict detailed effect/callback work to the first-row gap. No extra task,
// microtask, geometry read or state update is introduced by these probes.
export function openingPipelineWork(stage: string): () => void {
  if (!import.meta.env.DEV || !trace || nowMs() - trace.startedAt > 3000
    || pipelineCounts.has('row.ref.beforeMeasure')) return () => {};
  const captured = trace;
  const startedAt = nowMs();
  return () => {
    if (trace !== captured) return;
    if (pipelineWork.length >= 160) { omittedPipelineWork++; return; }
    pipelineWork.push({ stage, startMs: startedAt - captured.startedAt, durationMs: nowMs() - startedAt });
  };
}
function runOpeningEffect(stage: string, effect: EffectCallback): ReturnType<EffectCallback> {
  const finish = openingPipelineWork(stage);
  let cleanup: ReturnType<EffectCallback>;
  try { cleanup = effect(); } finally { finish(); }
  if (typeof cleanup !== 'function') return cleanup;
  return () => {
    const finishCleanup = openingPipelineWork(`${stage}.cleanup`);
    try { cleanup(); } finally { finishCleanup(); }
  };
}
export function useOpeningPipelineEffect(stage: string, effect: EffectCallback, deps?: DependencyList): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => runOpeningEffect(stage, effect), deps);
}
export function useOpeningPipelineLayoutEffect(stage: string, effect: EffectCallback, deps?: DependencyList): void {
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => runOpeningEffect(stage, effect), deps);
}
const renderCommits = new Map<number, { commitMs: number; groups: Record<string, {
  count: number; actualMs: number; maxMs: number; firstStartMs: number; lastStartMs: number;
}> }>();
export function recordOpeningPipeline(stage: string, data: Record<string, number> = {}): void {
  if (!import.meta.env.DEV || !trace || nowMs() - trace.startedAt > 15000 || revealProbePhases.has('after')) return;
  const count = pipelineCounts.get(stage) ?? 0;
  pipelineCounts.set(stage, count + 1);
  const limit = stage.startsWith('opening.') ? 24 : stage === 'row.ref.beforeMeasure' ? 16 : 6;
  if (count < limit && pipelineEvents.length < 192) pipelineEvents.push({ stage, atMs: nowMs() - trace.startedAt, data });
}
export const profileOpeningRenderWork: ProfilerOnRenderCallback = (group, _phase, actualDuration, _base, startTime, commitTime) => {
  if (!import.meta.env.DEV || !trace || startTime < trace.startedAt || commitTime - trace.startedAt > 3000) return;
  if (!renderCommits.has(commitTime) && renderCommits.size >= 20) return;
  const commit = renderCommits.get(commitTime) ?? { commitMs: commitTime - trace.startedAt, groups: {} };
  const stats = commit.groups[group] ?? { count: 0, actualMs: 0, maxMs: 0, firstStartMs: Infinity, lastStartMs: 0 };
  stats.count++;
  stats.actualMs += actualDuration;
  stats.maxMs = Math.max(stats.maxMs, actualDuration);
  stats.firstStartMs = Math.min(stats.firstStartMs, startTime - trace.startedAt);
  stats.lastStartMs = Math.max(stats.lastStartMs, startTime - trace.startedAt);
  commit.groups[group] = stats;
  renderCommits.set(commitTime, commit);
};
export function OpeningRenderProbe({ group, children }: { group: string; children: ReactNode }): ReactNode {
  return import.meta.env.DEV ? createElement(Profiler, { id: group, onRender: profileOpeningRenderWork }, children) : children;
}
function markOpeningEnginePhase(phase: 'start' | 'reveal' | 'end'): number | undefined {
  if (!trace) return;
  // User Timing provides a shared timestamp with Chromium's renderer trace.
  // Trace IDs contain no session/message content. Clear the performance entry
  // immediately; the browser trace retains the emitted marker independently.
  const name = `openbitfun-opening:${trace.traceId}:${phase}`;
  try {
    const mark = performance.mark(name);
    performance.clearMarks(name);
    return mark?.startTime - trace.startedAt;
  } catch { /* Diagnostic only. */ }
}
const layoutReadSpans = new Set([
  'follow.read.scrollHeight', 'follow.watch.scrollTop',
  'viewport.prepend.readScrollHeight', 'virtualizer.measure.sync',
]);
const layoutAttributes = [
  'class', 'style', 'hidden', 'inert', 'aria-hidden', 'open', 'width', 'height',
  'data-open-viewport-settled', 'data-flowchat-opening', 'data-scroll-at-start', 'data-history-paging-sentinel',
  'data-history-state', 'data-is-partial', 'data-active', 'data-visible', 'data-open',
  'data-state', 'data-status', 'data-running', 'data-size', 'data-item-type',
  'data-turn-boundary-after', 'data-ambient-tool-run-continuation-after',
  'data-openbitfun-state', 'data-openbitfun-layout', 'data-openbitfun-presentation',
  'data-openbitfun-expandable', 'data-openbitfun-expanded-shell',
];

function mutationRegion(element: Element | null): string {
  if (!element) return 'detached';
  if (element.closest('.virtual-item-wrapper')) return 'row';
  if (element.closest('.message-list-tail-spacer')) return 'tail-spacer';
  if (element.closest('.message-list-footer')) return 'footer';
  if (element.closest('.virtual-message-list__items')) return 'items';
  if (element.closest('.virtual-message-list__scroller')) return 'scroller';
  if (element.closest('.virtual-message-list')) return 'list';
  if (element.closest('.modern-flowchat-container')) return 'chat';
  if (element.closest('.openbitfun-chat-pane__content')) return 'pane';
  return 'outside-chat';
}

function collectOpeningMutations(records: MutationRecord[]): void {
  if (!records.length) return;
  const startedAt = nowMs();
  lastMutationAt = startedAt;
  mutationBatch++;
  const groups = new Map<string, { count: number; added: number; removed: number }>();
  for (const record of records) {
    mutationCounts[record.type]++;
    // Only the first bounded batches need per-target classification.
    if (mutationBatch > 32) continue;
    const element = record.target instanceof Element ? record.target : record.target.parentElement;
    const row = element?.closest('.virtual-item-wrapper');
    const rawIndex = row?.getAttribute('data-virtual-index');
    const index = rawIndex && /^\d{1,6}$/.test(rawIndex) ? rawIndex : '-';
    const key = `${mutationRegion(element)}:${index}:${record.attributeName ?? record.type}`;
    const group = groups.get(key) ?? { count: 0, added: 0, removed: 0 };
    group.count++;
    group.added += record.addedNodes.length;
    group.removed += record.removedNodes.length;
    groups.set(key, group);
  }
  if (mutationBatch <= 32) {
    const ranked = [...groups].sort((a, b) => b[1].count - a[1].count);
    logSessionOpening('O', 'layoutMutations', 'DOM mutation batch observed', {
      batch: mutationBatch, observedAt: startedAt, records: records.length,
      groups: ranked.slice(0, 8).map(([key, counts]) => ({ key, ...counts })),
      omittedGroups: Math.max(0, ranked.length - 8),
    });
  }
  mutationProbeMs += nowMs() - startedAt;
}

export function sessionOpeningMutationSnapshot(): Record<string, unknown> {
  if (!mutationObserver) return {};
  collectOpeningMutations(mutationObserver.takeRecords());
  return {
    ...mutationCounts, batch: mutationBatch, probeMs: mutationProbeMs,
    sinceMutationObservedMs: lastMutationAt === undefined ? null : nowMs() - lastMutationAt,
  };
}

export function countSessionOpeningOutcome(loc: string, outcome: string): void {
  if (!trace || nowMs() - trace.startedAt > 15000) return;
  const key = `${loc}:${outcome}`;
  outcomes.set(key, (outcomes.get(key) ?? 0) + 1);
}

export function logSessionOpeningPosition(loc: string, data: Record<string, unknown>): void {
  if (!trace || nowMs() - trace.startedAt > 15000) return;
  const count = (openingEventCounts.get(loc) ?? 0) + 1;
  openingEventCounts.set(loc, count);
  if (count <= 24) logSessionOpening('R', loc, 'opening position event', { ...data, call: count });
}

export function countSessionOpeningMeasurement(
  loc: string,
  index: string | null,
  itemCount: number,
  element: Element | null,
  phase: 'mount' | 'cleanup' | 'measure',
): void {
  if (!trace || nowMs() - trace.startedAt > 15000) return;
  let node = 'none';
  if (element) {
    const existing = measurementNodeIds.get(element);
    const id = existing ?? ++nextMeasurementNodeId;
    if (!existing) measurementNodeIds.set(element, id);
    node = `node${id}`;
  }
  const key = `${loc}:${phase}:${index ?? 'unknown'}:${itemCount}:${node}`;
  if (!measurementCounts.has(key) && measurementCounts.size >= 512) {
    omittedMeasurementCalls++;
    return;
  }
  measurementCounts.set(key, (measurementCounts.get(key) ?? 0) + 1);
}

export function probeSessionOpeningStyles(scroller: HTMLElement): void {
  if (!trace || nowMs() - trace.startedAt > 15000 || styleReadSamples >= 18) return;
  const list = scroller.closest('.virtual-message-list');
  if (!list) return;
  styleReadSamples++;
  const mutationsBefore = sessionOpeningMutationSnapshot();
  const settled = list.getAttribute('data-open-viewport-settled') === 'true';
  const startedAt = nowMs();
  // Deliberately flush pending style before the existing geometry read. This
  // separates attribution, not total cost; browsers may also flush layout here.
  const visibility = getComputedStyle(list).visibility;
  const durationMs = nowMs() - startedAt;
  logSessionOpening('P', 'viewport.prepend.readVisibility', 'diagnostic style read', {
    sample: styleReadSamples, settled, startedAt, durationMs, mutationsBefore,
    visibility: ['visible', 'hidden', 'collapse'].includes(visibility) ? visibility : 'other',
  });
}

export function probeSessionOpeningReveal(scroller: HTMLElement | null): void {
  if (!trace || nowMs() - trace.startedAt > 15000 || !scroller) return;
  const list = scroller.closest('.virtual-message-list');
  if (!list) return;
  const phase = list.getAttribute('data-open-viewport-settled') === 'true' ? 'after' : 'before';
  if (revealProbePhases.has(phase)) return;
  revealProbePhases.add(phase);
  const mutationsBefore = sessionOpeningMutationSnapshot();
  const startedAt = nowMs();
  try {
    const styleStartedAt = nowMs();
    const opacity = getComputedStyle(list).opacity;
    const scrollerContain = getComputedStyle(scroller).contain;
    const queryContainer = scroller.closest('.modern-flowchat-container__messages');
    const queryStyle = queryContainer ? getComputedStyle(queryContainer) : undefined;
    const queryContainerName = queryStyle?.containerName;
    const queryContainerType = queryStyle?.containerType;
    const styleMs = nowMs() - styleStartedAt;
    const layoutStartedAt = nowMs();
    const scrollHeight = scroller.scrollHeight;
    const clientWidth = scroller.clientWidth;
    const clientHeight = scroller.clientHeight;
    const scrollTop = scroller.scrollTop;
    logSessionOpening('Q', 'viewport.reveal.commit', 'reveal boundary measured', {
      phase, startedAt, durationMs: nowMs() - startedAt, mutationsBefore,
      styleMs, layoutMs: nowMs() - layoutStartedAt, scrollHeight,
      clientWidth, clientHeight, scrollTop, maxScrollTop: Math.max(0, scrollHeight - clientHeight),
      requestedContain: scroller.style.contain || 'none', scrollerContain,
      queryBypass: queryContainer?.getAttribute('data-opening-query-bypass') === 'true',
      queryContainerName, queryContainerType,
      transparent: opacity === '0', inert: list.hasAttribute('inert'),
    });
    if (phase === 'after') markOpeningEnginePhase('reveal');
    if (phase === 'after') {
      // After the reveal timing, not ahead of the measured opening reads.
      // This additional geometry sample checks the selector A/B's column placement.
      const sampleStartedAt = nowMs();
      const scrollerRect = scroller.getBoundingClientRect();
      const rows = Array.from(scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper'));
      const geometry = rows.slice(0, 24).map(row => {
        const rect = row.getBoundingClientRect();
        return { index: row.getAttribute('data-virtual-index'), widthPx: rect.width,
          heightPx: rect.height, leftInScrollerPx: rect.left - scrollerRect.left };
      });
      logSessionOpening('V', 'viewport.reveal.rows', 'reading column geometry after reveal', {
        rows: geometry, omittedRows: Math.max(0, rows.length - 24), probeMs: nowMs() - sampleStartedAt,
      });
    }
  } catch {
    logSessionOpening('Q', 'viewport.reveal.commit', 'reveal boundary measurement failed', { phase });
  }
}

export function probeSessionOpeningRowMeasurement(element: Element, measure: () => number): number {
  if (!import.meta.env.DEV || !trace || nowMs() - trace.startedAt > 15000
    || rowStylePreflightBatches.size >= 6
    || element.closest('.virtual-message-list')?.getAttribute('data-open-viewport-settled') !== 'false') {
    return measure();
  }
  const mutationsBefore = sessionOpeningMutationSnapshot();
  if (rowStylePreflightBatches.has(mutationBatch)) return measure();
  rowStylePreflightBatches.add(mutationBatch);
  const sample = rowStylePreflightBatches.size;
  const startedAt = nowMs();
  const view = element.ownerDocument.defaultView;
  const failures: string[] = [];
  const readStyle = (target: Element, stage: string) => {
    const start = nowMs();
    try { void view?.getComputedStyle(target).visibility; }
    catch { failures.push(stage); }
    return nowMs() - start;
  };
  // Explicit diagnostic intervention: settle document style, then row style,
  // before the original read. A computed-style query can also force layout
  // (e.g. container queries), so these are API stages, not engine phase totals.
  // Sample only the first row per mutation batch; never modify DOM or measure twice.
  const documentStyleMs = readStyle(element.ownerDocument.documentElement, 'document');
  const rowStyleMs = readStyle(element, 'row');
  const measureStartedAt = nowMs();
  let sizePx: number | undefined;
  let succeeded = false;
  try {
    sizePx = measure();
    succeeded = true;
    return sizePx;
  } finally {
    const finishedAt = nowMs();
    try {
      logSessionOpening('U', 'virtualizer.rowStylePreflight', 'style preflight and original measurement', {
        sample, index: element.getAttribute('data-virtual-index'), mutationsBefore,
        startedAt, documentStyleMs, rowStyleMs, measureStartedAt,
        measureCallMs: finishedAt - measureStartedAt, totalMs: finishedAt - startedAt,
        sizePx, succeeded, failures, diagnosticOnly: true,
      });
    } catch { /* Keep the original measurement result or exception intact. */ }
  }
}

export function sessionOpeningSpan(loc: string): (data?: () => Record<string, unknown>) => void {
  if (!trace || nowMs() - trace.startedAt > 15000) return () => {};
  const captured = trace;
  // Drain queued records before timing the DOM read; observation is not the mutation time.
  const mutationsBefore = layoutReadSpans.has(loc) ? sessionOpeningMutationSnapshot() : undefined;
  const startedAt = nowMs();
  return (data) => {
    if (trace !== captured) return;
    const durationMs = nowMs() - startedAt;
    const stats = spans.get(loc) ?? { count: 0, totalMs: 0, maxMs: 0, emitted: 0 };
    stats.count++;
    stats.totalMs += durationMs;
    stats.maxMs = Math.max(stats.maxMs, durationMs);
    spans.set(loc, stats);
    if (stats.emitted < 6 && durationMs >= 8) {
      stats.emitted++;
      logSessionOpening('M', loc, 'span finished', {
        ...data?.(), ...(mutationsBefore ? { mutationsBefore } : {}), startedAt, durationMs, call: stats.count,
      });
    }
  };
}

export function useSessionOpeningLayoutEffect(loc: string, effect: EffectCallback, deps?: DependencyList): void {
  useLayoutEffect(() => {
    const finish = sessionOpeningSpan(loc);
    try { return runOpeningEffect(loc, effect); } finally { finish(); }
  // This probe forwards the caller's dependency list without changing effect scheduling.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}

export function measureSessionOpening<T>(loc: string, work: () => T): T {
  const finish = sessionOpeningSpan(loc);
  try { return work(); } finally { finish(); }
}

export function beginSessionOpening(sessionId: string, source: string, eventTime?: number): void {
  if (import.meta.env.MODE === 'test' || typeof window === 'undefined') return;
  const existing = trace && nowMs() - trace.startedAt < 15000 && trace.sessionId === sessionId;
  if (existing && (source === 'activation' || (source === 'click' && trace?.source === 'pointerdown'))) {
    trace!.source = source;
    logSessionOpening('I', source, 'entered', { sessionId, eventTime });
    return;
  }
  stopMonitoring?.();
  spans.clear();
  pipelineEvents.length = 0;
  pipelineCounts.clear();
  pipelineWork.length = 0;
  omittedPipelineWork = 0;
  renderCommits.clear();
  outcomes.clear();
  measurementCounts.clear();
  measurementNodeIds = new WeakMap();
  omittedMeasurementCalls = 0;
  openingEventCounts.clear();
  nextMeasurementNodeId = 0;
  rowStylePreflightBatches.clear();
  trace = { traceId: `${pageId}-${++sequence}`, sessionId, startedAt: nowMs(), count: 0, source };
  const engineMarkerOffsetMs = markOpeningEnginePhase('start');
  logSessionOpening('I', source, 'opening started', { sessionId, eventTime,
    engineMarkerOffsetMs,
    scrollerContainmentExperiment: openingScrollerContainment ?? 'off',
    rowStylePreflightExperiment: import.meta.env.DEV,
    containerQueryBypassExperiment: openingContainerQueryBypass,
    eventDelayMs: eventTime !== undefined && eventTime <= nowMs() ? nowMs() - eventTime : undefined });
  const captured = trace;
  let observer: PerformanceObserver | undefined;
  let layoutContextSamples = 0;
  let layoutContextProbeMs = 0;
  const sampledLayoutRows = new WeakSet<Element>();
  const stopGeometryProbe = installOpeningGeometryProbe((element, data) => {
    const index = element.closest('.virtual-item-wrapper')?.getAttribute('data-virtual-index');
    logSessionOpening('S', 'opening.geometryRead', 'slow native geometry read', {
      ...data, region: mutationRegion(element), tag: element.tagName.toLowerCase(),
      index: index && /^\d{1,6}$/.test(index) ? Number(index) : null,
      // Drain only after a slow read; do not add work before every native read.
      mutationsAtCompletion: sessionOpeningMutationSnapshot(),
    });
    const row = element.closest('.virtual-item-wrapper');
    if (row && layoutContextSamples < 3 && !sampledLayoutRows.has(row)) {
      sampledLayoutRows.add(row);
      layoutContextSamples++;
      const context = collectOpeningLayoutContext(element);
      layoutContextProbeMs += context.probeMs;
      logSessionOpening('T', 'opening.layoutContext', 'DOM inventory after slow geometry read', {
        sample: layoutContextSamples, api: data.api, readStartedAt: data.startedAt,
        readDurationMs: data.durationMs, mutationBatch, ...context,
      });
    }
  });
  mutationCounts = { childList: 0, attributes: 0, characterData: 0 };
  lastMutationAt = undefined;
  mutationBatch = 0;
  mutationProbeMs = 0;
  styleReadSamples = 0;
  revealProbePhases.clear();
  if (typeof MutationObserver !== 'undefined' && document.body) {
    mutationObserver = new MutationObserver(collectOpeningMutations);
    mutationObserver.observe(document.body, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeFilter: layoutAttributes,
    });
  }
  let frameObserver: PerformanceObserver | undefined;
  const supportsLongTask = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes.includes('longtask');
  if (supportsLongTask) {
    observer = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) {
        if (trace === captured) logSessionOpening('J', 'mainThread', 'long task', {
          startTime: entry.startTime, durationMs: entry.duration,
        });
      }
    });
    observer.observe({ entryTypes: ['longtask'] });
  }
  const supportsLongAnimationFrame = typeof PerformanceObserver !== 'undefined'
    && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
  if (supportsLongAnimationFrame) {
    let samples = 0;
    frameObserver = new PerformanceObserver(list => {
      for (const raw of list.getEntries()) {
        if (trace !== captured || samples >= 12) continue;
        const entry = raw as PerformanceEntry & {
          blockingDuration?: number; renderStart?: number; styleAndLayoutStart?: number;
          scripts?: Array<{
            startTime: number; duration: number; executionStart: number;
            forcedStyleAndLayoutDuration: number; pauseDuration: number;
            invokerType: string; sourceURL: string; sourceFunctionName: string;
            sourceCharPosition: number;
          }>;
        };
        samples++;
        logSessionOpening('N', 'mainThread', 'long animation frame', {
          startTime: entry.startTime, durationMs: entry.duration,
          blockingMs: entry.blockingDuration, renderStart: entry.renderStart,
          styleAndLayoutStart: entry.styleAndLayoutStart,
          scriptCount: entry.scripts?.length ?? 0,
          scriptTotalMs: entry.scripts?.reduce((sum, script) => sum + script.duration, 0) ?? 0,
          forcedStyleAndLayoutTotalMs: entry.scripts?.reduce((sum, script) => sum + script.forcedStyleAndLayoutDuration, 0) ?? 0,
          // Only code locations and timing; omit invoker strings, DOM targets and URL queries.
          scripts: [...(entry.scripts ?? [])].sort((a, b) => b.duration - a.duration).slice(0, 5).map(script => ({
            startTime: script.startTime, durationMs: script.duration,
            executionStart: script.executionStart,
            forcedStyleAndLayoutMs: script.forcedStyleAndLayoutDuration,
            pauseMs: script.pauseDuration, invokerType: script.invokerType,
            source: script.sourceURL.split(/[?#]/, 1)[0],
            function: script.sourceFunctionName, position: script.sourceCharPosition,
          })),
        });
      }
    });
    frameObserver.observe({ entryTypes: ['long-animation-frame'] });
  }
  logSessionOpening('J', 'mainThread', 'monitor started', { supportsLongTask, supportsLongAnimationFrame });
  let previous = nowMs();
  let frameCount = 0;
  let maxGapMs = 0;
  let slowFrames = 0;
  let frame = 0;
  const tick = () => {
    const current = nowMs();
    const gapMs = current - previous;
    previous = current;
    frameCount++;
    maxGapMs = Math.max(maxGapMs, gapMs);
    if (gapMs > 50) {
      slowFrames++;
      if (slowFrames <= 12) logSessionOpening('J', 'mainThread', 'frame gap', { gapMs, visibility: document.visibilityState });
    }
    if (frameCount <= 2) logSessionOpening('J', 'mainThread', 'opening frame callback', { frameCount });
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    cancelAnimationFrame(frame);
    observer?.disconnect();
    frameObserver?.disconnect();
    const geometryReads = stopGeometryProbe();
    const mutations = sessionOpeningMutationSnapshot();
    mutationObserver?.disconnect();
    mutationObserver = undefined;
    if (trace === captured) {
      markOpeningEnginePhase('end');
      logSessionOpening('M', 'openingSpans', 'summary', {
        spans: Array.from(spans, ([loc, stats]) => ({ loc, count: stats.count, totalMs: stats.totalMs, maxMs: stats.maxMs })),
        outcomes: Object.fromEntries(outcomes),
        measurements: [...measurementCounts].sort((a, b) => b[1] - a[1])
          .map(([key, count]) => ({ key, count })),
        omittedMeasurementCalls,
        positionEventCounts: Object.fromEntries(openingEventCounts),
        geometryReads,
        layoutContext: { samples: layoutContextSamples, probeMs: layoutContextProbeMs },
        renderPipeline: { events: pipelineEvents, counts: Object.fromEntries(pipelineCounts),
          workBeforeFirstRow: pipelineWork, omittedWork: omittedPipelineWork,
          commits: [...renderCommits.values()], note: 'Nested render groups overlap; render attempts can be abandoned; commitMs precedes ref/effect work' },
        mutations,
      }, true);
      logSessionOpening('J', 'mainThread', 'monitor finished', { frameCount, maxGapMs, slowFrames }, true);
    }
  };
  const timer = setTimeout(finish, 15000);
  stopMonitoring = () => { clearTimeout(timer); finish(); };
}

export function sessionOpeningNow(): number { return nowMs(); }

export function logSessionOpening(id: string, loc: string, msg: string, data: Record<string, unknown> = {}, final = false): void {
  // Bounded extra capacity for window-input events without dropping reveal data.
  if (!trace || (!final && (nowMs() - trace.startedAt > 15000 || trace.count >= 256))) return;
  trace.count++;
  const clientNow = nowMs();
  void fetch(DEBUG_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    id, loc, msg, data, pageId, sequence: ++sequence, clientNow, timeOrigin: performance.timeOrigin,
    traceId: trace.traceId, openingSessionId: trace.sessionId, sinceOpenMs: clientNow - trace.startedAt,
  }, (_key, value: unknown) => typeof value === 'number' && Number.isFinite(value)
    ? Math.round(value * 10) / 10 : value) }).catch(() => {});
}

export function logSessionOpeningElapsed(id: string, loc: string, msg: string, startedAt: number, data: Record<string, unknown> = {}): void {
  logSessionOpening(id, loc, msg, { ...data, durationMs: elapsedMs(startedAt) });
}

export const profileSessionOpening: ProfilerOnRenderCallback = (component, phase, actualDuration, baseDuration, startTime, commitTime) => {
  logSessionOpening('K', component, 'react commit', { phase, actualDuration, baseDuration, startTime, commitTime });
};
if (import.meta.hot) import.meta.hot.dispose(() => stopMonitoring?.());
// #endregion
