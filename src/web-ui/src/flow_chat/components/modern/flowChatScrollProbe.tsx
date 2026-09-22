// #region agent log - temporary scroll performance investigation
import React, { Profiler, useEffect, useRef } from 'react';
import { elapsedMs, nowMs, roundDurationMs } from '@/shared/utils/timing';

// Development only. Set localStorage['flowchat.scrollProbe'] = 'off' and reload
// for an uninstrumented comparison. Reload also starts a fresh five-minute run.
export const scrollProbeEnabled = (() => {
  if (!import.meta.env.DEV || typeof window === 'undefined') return false;
  try { return localStorage.getItem('flowchat.scrollProbe') !== 'off'; }
  catch { return false; }
})();
const run = `${Date.now()}`;
const probeRevision = 29;
const experiment = 'retained-prepend-overflow-hardened-containment-off';
let startedAt: number | undefined;
let queue: unknown[] = [];
let dropped = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight = false;

// Temporary, development-only native-call timing. Measure existing calls, never
// add a geometry read. Only slow calls inside an active transcript get stacks.
// Multiple active panes share wrappers; the last subscriber restores them.
const geometryRoots = new Map<HTMLElement, number>();
let restoreGeometryWrappers: (() => void) | undefined;
let slowGeometryCount = 0;

// Structure only: no text, attribute values, HTML, node ids or CSS values.
// Mutation batches identify candidates, not the browser's invalidation reason.
function observeMutationEvidence(doc: Document) {
  type ChangedNode = { index: string | null; type: string | null; tag: string };
  type Group = {
    target: number; tag: string; component: string | null; part: string | null;
    scope: string; kind: string; attribute: string | null;
    rowIndex: string | null; ownerComponent: string | null;
    count: number; added: number; removed: number; styleProperties?: string[];
    addedItems?: ChangedNode[]; removedItems?: ChangedNode[];
  };
  const nodes = new WeakMap<Node, number>();
  let nextNode = 0;
  let countedBatches = 0;
  const countWindowChanges = (records: MutationRecord[]) => {
    const changes = records.filter(record => record.type === 'childList'
      && record.target instanceof Element
      && record.target.getAttribute('data-openbitfun-component') === 'virtual-message-list'
      && record.target.getAttribute('data-openbitfun-part') === 'items');
    if (!changes.length) return null;
    if (countedBatches >= 60) return { skipped: 'batch-limit' };
    const start = nowMs();
    const batchId = ++countedBatches;
    let remaining = 20000;
    const added = new Set<Element>();
    const removed = new Set<Element>();
    const containers = new Set<Element>();
    for (const change of changes) {
      containers.add(change.target as Element);
      for (const node of change.addedNodes) if (node instanceof Element) added.add(node);
      for (const node of change.removedNodes) if (node instanceof Element) removed.add(node);
    }
    const count = (element: Element) => {
      let elements = 0;
      const walker = doc.createTreeWalker(element, NodeFilter.SHOW_ELEMENT);
      let current: Node | null = element;
      while (current && remaining > 0) {
        elements += 1;
        remaining -= 1;
        current = walker.nextNode();
      }
      return { index: element.getAttribute('data-virtual-index'),
        type: element.getAttribute('data-item-type'), elements,
        truncated: current !== null };
    };
    // Count detached removals too. Counts describe observation-time structure,
    // not the exact state when each individual DOM mutation occurred.
    const addedRows = [...added].slice(0, 100).map(count);
    const removedRows = [...removed].slice(0, 100).map(count);
    const retained: Element[] = [];
    for (const container of containers) {
      for (const child of container.children) {
        if (child.hasAttribute('data-virtual-index') && !added.has(child)) retained.push(child);
      }
    }
    const retainedRows = retained.slice(0, 100).map(count);
    const countMs = elapsedMs(start);
    const marker = `FlowChat DOM counts #${batchId}`;
    try {
      performance.measure(marker, { start, end: nowMs() });
      performance.clearMeasures(marker);
    } catch { /* Optional trace correlation. */ }
    return { batchId, observedAt: start, countMs, elementBudget: 20000,
      visitedElements: 20000 - remaining,
      addedRows, removedRows, retainedRows,
      addedRoots: added.size, removedRoots: removed.size, retainedRoots: retained.length,
      rootLimitExceeded: added.size > 100 || removed.size > 100 || retained.length > 100 };
  };
  const describe = (records: MutationRecord[]) => {
    const begin = nowMs();
    const windowDomCounts = countWindowChanges(records);
    const groups = new Map<string, Group>();
    let omitted = Math.max(0, records.length - 400);
    for (const mutation of records.slice(0, 400)) {
      const element = mutation.target instanceof Element
        ? mutation.target : mutation.target.parentElement;
      if (!element) continue;
      let target = nodes.get(element);
      if (target === undefined) { target = ++nextNode; nodes.set(element, target); }
      const roots = [...geometryRoots.keys()];
      const scope = doc.head.contains(element) ? 'head'
        : roots.some(root => root === element || root.contains(element)) ? 'transcript'
        : roots.some(root => element.contains(root)) ? 'ancestor' : 'outside';
      const key = `${target}:${mutation.type}:${mutation.attributeName ?? ''}`;
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= 20) { omitted += 1; continue; }
        group = { target, tag: element.tagName,
          component: element.getAttribute('data-openbitfun-component'),
          part: element.getAttribute('data-openbitfun-part'), scope,
          kind: mutation.type, attribute: mutation.attributeName,
          rowIndex: element.closest('[data-virtual-index]')?.getAttribute('data-virtual-index') ?? null,
          ownerComponent: element.closest('[data-openbitfun-component]')
            ?.getAttribute('data-openbitfun-component') ?? null,
          count: 0, added: 0, removed: 0,
        };
        if (mutation.attributeName === 'style' && element instanceof HTMLElement) {
          group.styleProperties = Array.from(element.style).slice(0, 16);
        }
        groups.set(key, group);
      }
      if (mutation.type === 'childList') {
        const append = (list: NodeList, items: ChangedNode[]) => {
          const limit = Math.min(list.length, 20 - items.length);
          for (let i = 0; i < limit; i += 1) {
            const node = list[i];
            items.push(node instanceof Element
              ? { index: node.getAttribute('data-virtual-index'),
                type: node.getAttribute('data-item-type'), tag: node.tagName }
              : { index: null, type: null, tag: '#non-element' });
          }
        };
        append(mutation.addedNodes, group.addedItems ??= []);
        append(mutation.removedNodes, group.removedItems ??= []);
      }
      group.count += 1;
      group.added += mutation.addedNodes.length;
      group.removed += mutation.removedNodes.length;
    }
    if (windowDomCounts) scrollProbe('G', 'dom.windowCounts', windowDomCounts);
    return { observedAt: begin, records: records.length, omitted, windowDomCounts,
      groups: [...groups.values()], summarizeMs: elapsedMs(begin) };
  };
  const recent: ReturnType<typeof describe>[] = [];
  let summarizingMs = 0;
  let deliveredRecords = 0;
  let evictedBatches = 0;
  const observer = new MutationObserver(records => {
    const batch = describe(records);
    summarizingMs += batch.summarizeMs;
    deliveredRecords += records.length;
    recent.push(batch);
    if (recent.length > 4) { recent.shift(); evictedBatches += 1; }
  });
  observer.observe(doc.documentElement, {
    subtree: true, childList: true, attributes: true, characterData: true,
  });
  return {
    sample: (readStarted: number) => {
      // Read synchronously queued mutations too: layout effects often force style
      // before the observer's microtask has delivered the DOM commit records.
      const pending = observer.takeRecords();
      const evidence = {
        pendingAtReadEnd: pending.length ? describe(pending) : null,
        recentDelivered: recent.filter(batch => readStarted - batch.observedAt <= 150),
        deliveredRecordsSinceSample: deliveredRecords,
        evictedBatchesSinceSample: evictedBatches,
        callbackSummarizingMsSinceSample: roundDurationMs(summarizingMs),
      };
      recent.length = 0;
      summarizingMs = 0;
      deliveredRecords = 0;
      evictedBatches = 0;
      return evidence;
    },
    disconnect: () => { observer.disconnect(); recent.length = 0; },
  };
}

function observeSlowGeometry(scroller: HTMLElement): () => void {
  geometryRoots.set(scroller, (geometryRoots.get(scroller) ?? 0) + 1);
  if (!restoreGeometryWrappers) {
    const restorers: Array<() => void> = [];
    const mutations = observeMutationEvidence(scroller.ownerDocument);
    restorers.push(mutations.disconnect);
    const record = (element: Element, operation: string, startTime: number) => {
      const durationMs = elapsedMs(startTime);
      if (durationMs < 4 || slowGeometryCount >= 600) return;
      if (![...geometryRoots.keys()].some(root => root === element || root.contains(element))) return;
      slowGeometryCount += 1;
      const row = element.closest('[data-virtual-index]');
      // Surface the existing measurement interval in DevTools User Timing.
      // Clear the buffer immediately; an active Performance recording retains
      // the trace event without growing the page's performance entry buffer.
      const traceName = `FlowChat geometry: ${operation} #${slowGeometryCount}`;
      try {
        performance.measure(traceName, { start: startTime, end: nowMs() });
        performance.clearMeasures(traceName);
      } catch { /* User Timing is optional on older hosts. */ }
      scrollProbe('E', 'dom.slowGeometry', {
        operation, startTime, durationMs,
        tag: element.tagName, component: element.getAttribute('data-openbitfun-component'),
        part: element.getAttribute('data-openbitfun-part'),
        rowIndex: row?.getAttribute('data-virtual-index'),
        rowType: row?.getAttribute('data-item-type'),
        // Code locations only; never include node text, HTML, tool inputs or URLs.
        stack: new Error().stack?.split('\n').slice(2, 12).join('\n'),
        sample: slowGeometryCount,
        mutationEvidence: durationMs >= 20 ? mutations.sample(startTime) : undefined,
      });
    };
    const wrap = (prototype: object, name: string, getter: boolean) => {
      const original = Object.getOwnPropertyDescriptor(prototype, name);
      if (!original?.configurable) return;
      const call = getter ? original.get : original.value;
      if (typeof call !== 'function') return;
      const timed = function (this: Element, ...args: unknown[]) {
        const startTime = nowMs();
        try { return Reflect.apply(call, this, args); }
        finally { record(this, name, startTime); }
      };
      Object.defineProperty(prototype, name, getter
        ? { ...original, get: timed } : { ...original, value: timed });
      restorers.push(() => {
        const current = Object.getOwnPropertyDescriptor(prototype, name);
        if ((getter ? current?.get : current?.value) === timed) {
          Object.defineProperty(prototype, name, original);
        }
      });
    };
    for (const name of ['getBoundingClientRect', 'getClientRects']) wrap(Element.prototype, name, false);
    for (const name of ['scrollTop', 'scrollLeft', 'scrollHeight', 'scrollWidth', 'clientHeight', 'clientWidth']) {
      wrap(Element.prototype, name, true);
    }
    for (const name of ['offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft']) {
      wrap(HTMLElement.prototype, name, true);
    }
    restoreGeometryWrappers = () => restorers.reverse().forEach(restore => restore());
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const count = geometryRoots.get(scroller) ?? 0;
    if (count > 1) geometryRoots.set(scroller, count - 1);
    else geometryRoots.delete(scroller);
    if (geometryRoots.size === 0) {
      restoreGeometryWrappers?.();
      restoreGeometryWrappers = undefined;
    }
  };
}

export function scrollProbe(id: string, loc: string, data: Record<string, unknown>) {
  if (!scrollProbeEnabled) return;
  const atMs = nowMs();
  startedAt ??= atMs;
  if (atMs - startedAt > 300_000) return;
  if (queue.length < 500) queue.push({ id, loc, atMs, data });
  else dropped += 1;
  if (timer !== undefined || inFlight) return;
  timer = setTimeout(flush, 500);
}

function flush() {
  timer = undefined;
  if (!queue.length || inFlight) return;
  const events = queue;
  queue = [];
  const droppedEvents = dropped;
  dropped = 0;
  inFlight = true;
  void fetch('http://127.0.0.1:7469/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ location: 'flowchat.scrollProbe', message: 'Scroll performance batch',
      run, probeRevision, experiment, timeOrigin: performance.timeOrigin, events, droppedEvents }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {}).finally(() => {
    inFlight = false;
    if (queue.length) timer = setTimeout(flush, 500);
  });
}

/** React subtree time, not layout/paint time. Nested profiler times overlap. */
export function ScrollProbeProfiler({ probeId, metadata, children }: {
  probeId: string;
  metadata: Record<string, unknown>;
  children: React.ReactNode;
}) {
  const onRender: React.ProfilerOnRenderCallback = (
    _id, phase, actualDuration, baseDuration, startTime, commitTime,
  ) => scrollProbe('A', 'card.reactCommit', {
    ...metadata, probeId, phase, durationMs: roundDurationMs(actualDuration),
    baseDurationMs: roundDurationMs(baseDuration), startTime, commitTime,
    commitToCallbackMs: elapsedMs(commitTime),
  });
  return scrollProbeEnabled
    ? <Profiler id={probeId} onRender={onRender}>{children}</Profiler>
    : <>{children}</>;
}

/** Read-only geometry sampling: uncovered area is not proof of an unpainted frame. */
interface ScrollProbeLongFrame extends PerformanceEntry {
  blockingDuration: number;
  renderStart: number;
  styleAndLayoutStart: number;
  scripts: Array<{
    duration: number;
    executionStart: number;
    forcedStyleAndLayoutDuration: number;
    pauseDuration: number;
    invokerType: string;
    sourceURL: string;
    sourceFunctionName: string;
    sourceCharPosition: number;
  }>;
}

export function useScrollPerformanceProbe(scroller: HTMLElement | null, active: boolean,
  state: Record<string, unknown>) {
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    if (!scrollProbeEnabled || !scroller || !active) return;
    const mountedAt = nowMs();
    const releaseGeometryProbe = observeSlowGeometry(scroller);
    // Also restore in a background tab where rAF is suspended.
    const geometryTimeout = setTimeout(releaseGeometryProbe, 300000);
    let frame = 0;
    let previousFrame = mountedAt;
    let lastSample = 0;
    let lastScroll = mountedAt;
    let scrollEvents = 0;
    let previousTop = scroller.scrollTop;
    let observer: PerformanceObserver | undefined;
    let frameObserver: PerformanceObserver | undefined;
    const onScroll = () => { lastScroll = nowMs(); scrollEvents += 1; };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    const supportsLongTask = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('longtask');
    const supportsLongFrame = typeof PerformanceObserver !== 'undefined'
      && PerformanceObserver.supportedEntryTypes.includes('long-animation-frame');
    scrollProbe('B', 'viewport.start', { ...stateRef.current, supportsLongTask, supportsLongFrame,
      geometryThresholdMs: 4, geometryStackLimit: 600,
      profilingBuild: 'development', maxCaptureMs: 300000, geometrySampleIntervalMs: 120 });
    if (supportsLongTask) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          scrollProbe('B', 'mainThread.longTask', { startTime: entry.startTime,
            durationMs: roundDurationMs(entry.duration) });
        }
      });
      observer.observe({ type: 'longtask' });
    }
    if (supportsLongFrame) {
      frameObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          const longFrame = entry as ScrollProbeLongFrame;
          scrollProbe('D', 'mainThread.longAnimationFrame', {
            startTime: entry.startTime, durationMs: roundDurationMs(entry.duration),
            blockingDurationMs: longFrame.blockingDuration,
            renderStart: longFrame.renderStart, styleAndLayoutStart: longFrame.styleAndLayoutStart,
            // This interval also includes work after layout; it is not pure layout time.
            styleLayoutToFrameEndMs: longFrame.styleAndLayoutStart > 0
              ? roundDurationMs(entry.startTime + entry.duration - longFrame.styleAndLayoutStart) : null,
            scripts: longFrame.scripts.slice(0, 30).map(script => {
              let sourcePath: string | undefined;
              try { sourcePath = new URL(script.sourceURL).pathname; } catch { /* No source URL. */ }
              return {
                durationMs: roundDurationMs(script.duration), executionStart: script.executionStart,
                forcedStyleAndLayoutDurationMs: script.forcedStyleAndLayoutDuration,
                pauseDurationMs: script.pauseDuration, invokerType: script.invokerType,
                sourcePath, sourceFunctionName: script.sourceFunctionName,
                sourceCharPosition: script.sourceCharPosition,
              };
            }),
            omittedScripts: Math.max(0, longFrame.scripts.length - 30),
          });
        }
      });
      frameObserver.observe({ type: 'long-animation-frame' });
    }
    const tick = (frameTimestamp: number) => {
      // rAF's supplied timestamp can precede a long callback earlier in this frame.
      const at = nowMs();
      if (at - mountedAt > 300000) {
        releaseGeometryProbe();
        clearTimeout(geometryTimeout);
        observer?.disconnect();
        frameObserver?.disconnect();
        scroller.removeEventListener('scroll', onScroll);
        return;
      }
      if (document.visibilityState === 'visible' && at - lastScroll < 800) {
        if (at - previousFrame > 50) scrollProbe('B', 'viewport.frameGap', {
          ...stateRef.current, durationMs: roundDurationMs(at - previousFrame),
          frameTimestamp,
        });
        if (at - lastSample >= 120) {
          const sampleStarted = nowMs();
          const box = scroller.getBoundingClientRect();
          const top = box.top + scroller.clientTop;
          const bottom = top + scroller.clientHeight;
          const rows = Array.from(scroller.querySelectorAll<HTMLElement>('[data-virtual-index]'));
          let coveredPx = 0;
          let coveredEnd = top;
          const geometry = rows.map(row => {
            const rect = row.getBoundingClientRect();
            const from = Math.max(top, rect.top, coveredEnd);
            const to = Math.min(bottom, rect.bottom);
            coveredPx += Math.max(0, to - from);
            coveredEnd = Math.max(coveredEnd, to);
            return { index: row.dataset.virtualIndex, topPx: Math.round(rect.top - top),
              heightPx: Math.round(rect.height) };
          });
          const first = geometry[0];
          const last = geometry.at(-1);
          scrollProbe('C', 'viewport.coverage', { ...stateRef.current,
            scrollTop: scroller.scrollTop, deltaPx: scroller.scrollTop - previousTop,
            scrollHeight: scroller.scrollHeight, viewportHeight: scroller.clientHeight,
            uncoveredPx: Math.max(0, scroller.clientHeight - coveredPx),
            // Exclude the intentional header/tail reservation from missing-window evidence.
            missingWindowBeforePx: first && Number(first.index) > 0
              ? Math.min(scroller.clientHeight, Math.max(0, first.topPx)) : 0,
            missingWindowAfterPx: last && Number(last.index) < Number(stateRef.current.itemCount) - 1
              ? Math.min(scroller.clientHeight, Math.max(0,
                scroller.clientHeight - last.topPx - last.heightPx)) : 0,
            scrollEvents, rows: geometry, durationMs: elapsedMs(sampleStarted),
          });
          previousTop = scroller.scrollTop;
          scrollEvents = 0;
          lastSample = at;
        }
      }
      previousFrame = at;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      releaseGeometryProbe();
      clearTimeout(geometryTimeout);
      cancelAnimationFrame(frame);
      observer?.disconnect();
      frameObserver?.disconnect();
      scroller.removeEventListener('scroll', onScroll);
      scrollProbe('C', 'viewport.stop', stateRef.current);
    };
  }, [scroller, active]);
}
// #endregion
