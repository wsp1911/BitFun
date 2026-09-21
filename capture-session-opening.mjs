// Temporary engine trace collector. Node 22+, no browser automation or application launch.
// Usage: node capture-session-opening.mjs [--style-details] [--port 9473] [--wait-seconds 900]
// Restart the desktop process with WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS containing
// --remote-debugging-port=9473, then wait for READY before manually opening a session.
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { openingCpuWindows, summarizeOpeningCpu } from './session-opening-cpu.mjs';

const logFile = fileURLToPath(new URL('./debug-agent.log', import.meta.url));
const markerPattern = /^openbitfun-opening:([a-z0-9-]+):(start|reveal|end)$/;
const phaseNames = new Set(['UpdateLayoutTree', 'RecalculateStyles', 'Layout', 'PrePaint', 'Paint', 'HitTest', 'ParseAuthorStyleSheet']);
const round = value => Math.round(value * 10) / 10;
const numericFields = ['elementCount', 'dirtyObjects', 'totalObjects', 'nodeId', 'node_id', 'backendNodeId', 'parentNodeId', 'pseudoId'];
// #region agent log: bounded style invalidation diagnostics (hypotheses X/Y/Z).
const styleReasons = new Set(['Animation', 'Style attribute change', 'Class attribute change',
  'Attribute change', 'PseudoClass', 'Stylesheet change', 'Related style rule',
  'Node was inserted into tree', 'Node was removed from tree', 'Sibling element changed',
  'Inherited style change', 'Style invalidator', 'StyleInvalidator', 'Style recalc',
  'Style change', 'Inline CSS style declaration was mutated', 'Container query',
  'Media query', 'Fonts', 'Font change']);
const invalidationNames = new Set(['StyleRecalcInvalidationTracking', 'StyleInvalidatorInvalidationTracking',
  'ScheduleStyleInvalidationTracking', 'LayoutInvalidationTracking']);
const resolverName = 'StyleResolver::ResolveStyle';
export const detailCategories = ['-*', 'devtools.timeline', 'blink.user_timing',
  'disabled-by-default-devtools.timeline.invalidationTracking'];
// #endregion

// Select before retaining: no DOM text, selector text, URLs, stacks, screenshots,
// request data or arbitrary trace args enter the collector's event buffer/log.
export function selectEngineEvent(event) {
  const marker = markerPattern.exec(event.name ?? '');
  const invalidation = invalidationNames.has(event.name);
  if (!marker && !phaseNames.has(event.name) && !invalidation && event.name !== resolverName) return null;
  if (![event.ts, event.pid, event.tid].every(Number.isFinite)) return null;
  const data = { ...event.args?.beginData, ...event.args?.data, ...event.args?.endData };
  const counts = Object.fromEntries(numericFields.filter(key => Number.isFinite(data[key])).map(key => [key, data[key]]));
  return { name: event.name, ph: event.ph, ts: event.ts, pid: event.pid, tid: event.tid,
    ...(Number.isFinite(event.dur) ? { dur: event.dur } : {}),
    counts, invalidation,
    ...(invalidation ? { reason: styleReasons.has(data.reason) ? data.reason : 'other',
      ...(typeof data.subtree === 'boolean' ? { subtree: data.subtree } : {}) } : {}),
    ...(marker ? { traceId: marker[1], phase: marker[2] } : {}) };
}

export function summarizeEngineTrace(events, traceId, dropped = 0, dataLoss = false, { shortWindow = false } = {}) {
  const start = events.find(event => event.traceId === traceId && event.phase === 'start');
  if (!start) throw new Error('Opening start marker missing; start recording before reproducing');
  const sameThread = event => event.pid === start.pid && event.tid === start.tid;
  const end = events.find(event => sameThread(event) && event.traceId === traceId && event.phase === 'end');
  const reveal = events.find(event => sameThread(event) && event.traceId === traceId && event.phase === 'reveal');
  const endTs = shortWindow ? events.filter(sameThread).reduce((latest, event) =>
    Math.max(latest, event.ts + (event.dur ?? 0)), start.ts) : end?.ts ?? start.ts + 15_000_000;
  const selected = events.filter(event => sameThread(event) && event.ts >= start.ts && event.ts <= endTs)
    .sort((a, b) => a.ts - b.ts);
  const durations = [];
  const stack = [];
  let unmatched = 0;
  for (const event of selected) {
    if (!phaseNames.has(event.name)) continue;
    if (event.ph === 'X' && Number.isFinite(event.dur)) durations.push(event);
    else if (event.ph === 'B') stack.push(event);
    else if (event.ph === 'E') {
      const begin = stack.pop();
      if (begin?.name === event.name) durations.push({ ...begin, counts: { ...begin.counts, ...event.counts }, dur: event.ts - begin.ts });
      else unmatched++;
    }
  }
  const aggregate = cutoff => [...phaseNames].map(name => {
    const matching = durations.filter(event => event.name === name && event.ts < cutoff);
    const times = matching.map(event => Math.max(0, Math.min(event.ts + event.dur, cutoff) - event.ts) / 1000);
    return { name, count: times.length, totalMs: round(times.reduce((sum, ms) => sum + ms, 0)), maxMs: round(Math.max(0, ...times)) };
  }).filter(value => value.count);
  const invalidations = selected.filter(event => event.invalidation);
  const invalidationCounts = {};
  for (const event of invalidations) invalidationCounts[event.name] = (invalidationCounts[event.name] ?? 0) + 1;
  return {
    traceId, rendererPid: start.pid, rendererTid: start.tid,
    complete: Boolean(shortWindow ? reveal : end) && dropped === 0 && !dataLoss && unmatched === 0 && stack.length === 0,
    coverage: shortWindow ? 'opening-through-reveal' : 'opening-15s',
    dropped, dataLoss, unmatched: unmatched + stack.length,
    revealMs: reveal ? round((reveal.ts - start.ts) / 1000) : null,
    durationMs: round((endTs - start.ts) / 1000),
    beforeReveal: reveal ? aggregate(reveal.ts) : null, fullWindow: aggregate(endTs),
    invalidationCounts,
    ...(shortWindow ? { styleDetails: summarizeStyleDetails(selected, durations, start.ts, reveal?.ts) } : {}),
    slowEvents: durations.filter(event => event.dur >= 1000).sort((a, b) => b.dur - a.dur).slice(0, 24)
      .map(event => ({ name: event.name, atMs: round((event.ts - start.ts) / 1000), durationMs: round(event.dur / 1000),
        ...event.counts,
        precedingInvalidations: invalidations.filter(i => i.ts <= event.ts && i.ts >= event.ts - 50_000).length })),
    // Counts help distinguish a large dirty subtree from a small expensive one.
    // Engine events can nest: do not add totals across categories.
    note: 'Engine phase totals may overlap; invalidation counts are sampled trace evidence, not proof of causality',
  };
}

// #region agent log: X broad subtree invalidation, Y repeated animation updates,
// Z expensive resolution of a small subtree. Proximity is evidence, not causality.
function styleFacts(events) {
  const reasons = {};
  const nodes = new Map();
  let invalidations = 0;
  let resolutions = 0;
  let subtreeInvalidations = 0;
  for (const event of events) {
    if (!event.invalidation && event.name !== resolverName) continue;
    if (event.invalidation) {
      invalidations++;
      reasons[event.reason] = (reasons[event.reason] ?? 0) + 1;
      if (event.subtree) subtreeInvalidations++;
    } else resolutions++;
    const nodeId = event.counts.nodeId ?? event.counts.backendNodeId ?? event.counts.node_id;
    if (!Number.isFinite(nodeId)) continue;
    const node = nodes.get(nodeId) ?? { nodeId, invalidations: 0, resolutions: 0, reasons: {} };
    if (event.invalidation) {
      node.invalidations++;
      node.reasons[event.reason] = (node.reasons[event.reason] ?? 0) + 1;
    } else node.resolutions++;
    nodes.set(nodeId, node);
  }
  return { invalidations, resolutions, subtreeInvalidations, uniqueNodes: nodes.size, reasons,
    topNodes: [...nodes.values()].sort((a, b) =>
      (b.resolutions + b.invalidations) - (a.resolutions + a.invalidations)).slice(0, 8) };
}

export function summarizeStyleDetails(events, durations, startTs, revealTs) {
  const styleEvents = events.filter(event => event.invalidation || event.name === resolverName);
  const updates = durations.filter(event => ['UpdateLayoutTree', 'RecalculateStyles'].includes(event.name))
    .sort((a, b) => a.ts - b.ts);
  const slowUpdates = updates.filter(event => event.dur >= 8000).sort((a, b) => b.dur - a.dur).slice(0, 6)
    .map(event => {
      const previous = updates.findLast(update => update.ts + update.dur <= event.ts && update !== event);
      const from = Math.max(startTs, previous ? previous.ts + previous.dur : startTs);
      return { atMs: round((event.ts - startTs) / 1000), durationMs: round(event.dur / 1000), ...event.counts,
        // Each preceding interval begins at the previous completed update, so
        // one invalidation is not attributed to several nearby slow updates.
        preceding: styleFacts(styleEvents.filter(item => item.ts >= from && item.ts < event.ts)),
        during: styleFacts(styleEvents.filter(item => item.ts >= event.ts && item.ts < event.ts + event.dur)) };
    });
  return { hypotheses: { X: 'Broad subtree invalidation', Y: 'Repeated animation invalidation',
    Z: 'Concentrated style resolution' },
    beforeReveal: revealTs === undefined ? null : styleFacts(styleEvents.filter(e => e.ts < revealTs)),
    afterReveal: revealTs === undefined ? null : styleFacts(styleEvents.filter(e => e.ts >= revealTs)),
    slowUpdates, note: 'Resolution counts are not selector timings; other reasons are outside the fixed allowlist' };
}

// Resolve only a bounded selection AFTER tracing ends. Return structural roles,
// never text, attributes, arbitrary classes, IDs, selector strings or outerHTML.
export async function describeStyleNodes(cdp, details) {
  const groups = [details.beforeReveal, details.afterReveal,
    ...details.slowUpdates.flatMap(update => [update.preceding, update.during])].filter(Boolean);
  const ids = [...new Set(groups.flatMap(group => group.topNodes.slice(0, 4).map(node => node.nodeId)))].slice(0, 24);
  const result = [];
  for (const nodeId of ids) {
    let objectId;
    try {
      const resolved = await cdp.call('DOM.resolveNode', { backendNodeId: nodeId, objectGroup: 'opening-style-probe' });
      objectId = resolved.object?.objectId;
      if (!objectId) throw new Error('No node object');
      const response = await cdp.call('Runtime.callFunctionOn', { objectId, returnByValue: true,
        functionDeclaration: `function () {
          const element = this.nodeType === 1 ? this : this.parentElement;
          if (!element) return { available: false };
          const roles = { root: 'html', body: 'body', transcript: '.modern-flowchat-container__messages',
            list: '.virtual-message-list', row: '.virtual-item-wrapper', overflowText: '[data-overflow-content]',
            nav: '.openbitfun-nav-panel', chatPane: '.openbitfun-chat-pane__content',
            openingSpinner: '.modern-flowchat-container__history-open-intent-spinner',
            pagingSpinner: '.virtual-message-list__history-paging-spinner' };
          const regions = Object.entries(roles).filter(([, selector]) => element.closest(selector)).map(([role]) => role);
          const selfRoles = Object.entries(roles).filter(([, selector]) => element.matches(selector)).map(([role]) => role);
          const row = element.closest('.virtual-item-wrapper');
          const index = row?.getAttribute('data-virtual-index');
          const rowIndex = index !== null && index !== undefined && /^\\d+$/.test(index) ? Number(index) : null;
          const knownTags = new Set(['DIV', 'SPAN', 'SVG', 'PATH', 'CIRCLE', 'BUTTON', 'P', 'HTML', 'BODY']);
          const tag = node => knownTags.has(node.tagName?.toUpperCase()) ? node.tagName.toLowerCase() : 'other';
          const ancestry = [];
          for (let node = element; node && ancestry.length < 6; node = node.parentElement) {
            let siblingIndex = 0;
            for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) siblingIndex++;
            ancestry.push({ tag: tag(node), siblingIndex });
          }
          const propertyNames = new Set(['opacity', 'transform', 'translate', 'rotate', 'scale', 'filter',
            'backdropFilter', 'backgroundPosition', 'backgroundColor', 'color', 'boxShadow',
            'width', 'height', 'left', 'top', 'clipPath', 'strokeDashoffset', 'strokeDasharray']);
          const ownAnimations = element.getAnimations();
          const animations = ownAnimations.slice(0, 4).map(animation => {
            const timing = animation.effect?.getTiming();
            const properties = [...new Set((animation.effect?.getKeyframes?.() ?? []).flatMap(frame =>
              Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))
                .map(key => propertyNames.has(key) ? key : 'other')))];
            return { properties, running: animation.playState === 'running', infinite: timing?.iterations === Infinity,
              durationMs: Number.isFinite(timing?.duration) ? Math.round(timing.duration * 10) / 10 : null };
          });
          return { available: true, connected: element.isConnected, regions, selfRoles, rowIndex,
            ancestry, animationCount: ownAnimations.length, animations,
            isRoot: element === document.documentElement, isBody: element === document.body };
        }` });
      if (response.exceptionDetails || !response.result?.value) throw new Error('Node inspection failed');
      result.push({ nodeId, ...response.result.value });
    } catch { result.push({ nodeId, available: false }); }
  }
  try { await cdp.call('Runtime.releaseObjectGroup', { objectGroup: 'opening-style-probe' }); } catch { /* Detached target. */ }
  return result;
}

export function shouldStopDetails(rows, traceId, openingSeenAt, now) {
  const revealed = rows.some(row => row.traceId === traceId && row.loc === 'viewport.reveal.commit' && row.data?.phase === 'after');
  if (revealed) return 'reveal';
  if (now - openingSeenAt >= 3000) return 'opening-timeout';
  return null;
}

// Read actual loaded rules before tracing, so HMR/stale CSS cannot silently
// mix the A/B arms. Inspect selectors only in-page; return bounded counts only.
async function readHighlightRuleInventory(cdp) {
  const response = await cdp.call('Runtime.evaluate', { returnByValue: true, expression: `(() => {
    const names = new Set(), scopedStreamingNames = new Set(), globalStreamingNames = new Set();
    let inaccessibleSheets = 0;
    function visit(rules) {
      for (const rule of rules) {
        for (const match of (rule.selectorText || '').matchAll(/::highlight\\(([^)]+)\\)/g)) {
          names.add(match[1]);
          if (match[1].startsWith('openbitfun-stream-reveal-')) {
            (rule.selectorText.includes('[data-stream-reveal-active]') ? scopedStreamingNames : globalStreamingNames).add(match[1]);
          }
        }
        if (rule.cssRules) visit(rule.cssRules);
      }
    }
    for (const sheet of document.styleSheets) {
      try { visit(sheet.cssRules); } catch { inaccessibleSheets++; }
    }
    let streaming = 0, search = 0, excerpt = 0, other = 0;
    for (const name of names) {
      if (name.startsWith('openbitfun-stream-reveal-')) streaming++;
      else if (name.startsWith('openbitfun-flowchat-search-')) search++;
      else if (['openbitfun-flowchat-excerpt', 'openbitfun-flowchat-annotations'].includes(name)) excerpt++;
      else other++;
    }
    return { streaming, search, excerpt, other, total: names.size, inaccessibleSheets,
      scopedStreaming: scopedStreamingNames.size, globalStreaming: globalStreamingNames.size,
      activeTextParents: document.querySelectorAll('[data-stream-reveal-active]').length };
  })()` });
  if (response.exceptionDetails || !response.result?.value) throw new Error('Highlight rule inventory failed');
  return response.result.value;
}
// #endregion

export async function connect(url, onEvent) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  await new Promise((resolveOpen, reject) => {
    const timeout = setTimeout(() => { socket.close(); reject(new Error('CDP connection timed out')); }, 10_000);
    socket.addEventListener('open', () => { clearTimeout(timeout); resolveOpen(); }, { once: true });
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('CDP connection failed')); }, { once: true });
  });
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.id) {
      const request = pending.get(data.id);
      if (!request) return;
      clearTimeout(request.timer); pending.delete(data.id);
      if (data.error) request.reject(new Error(`CDP command failed: ${data.error.message}`));
      else request.resolve(data.result);
    } else onEvent(data);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(new Error('CDP connection closed')); }
    pending.clear();
  });
  return {
    call(method, params = {}) {
      return new Promise((resolveCall, reject) => {
        const id = ++nextId;
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 15_000);
        pending.set(id, { resolve: resolveCall, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close: () => socket.close(),
  };
}

export const engineCategories = ['-*', 'devtools.timeline', 'blink.user_timing'];

export async function readTraceStream(cdp, handle, onEvent, { openingTraceId } = {}) {
  if (!handle) throw new Error('Browser did not return a trace stream');
  const chunks = [];
  let bytes = 0;
  const deadline = Date.now() + 120_000;
  try {
    while (true) {
      if (Date.now() >= deadline) throw new Error('Trace stream read exceeded 120 seconds');
      const chunk = await cdp.call('IO.read', { handle, size: 1024 * 1024 });
      const buffer = chunk.base64Encoded ? Buffer.from(chunk.data, 'base64') : Buffer.from(chunk.data);
      bytes += buffer.length;
      if (bytes > 128 * 1024 * 1024) throw new Error('Trace exceeds the 128 MiB collection limit');
      chunks.push(buffer);
      if (chunk.eof) break;
    }
    // Raw protocol payload exists only in memory; retain only the whitelist.
    // Join bytes before UTF-8 decoding so a multibyte character split across
    // IO.read chunks cannot corrupt the JSON or its marker names.
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    // Trace chunks may serialize different buffers out of timestamp order.
    // Locate the start first; filtering by arrival order can lose opening data.
    const opening = openingTraceId ? parsed.traceEvents?.find(raw =>
      raw.name === `openbitfun-opening:${openingTraceId}:start`) : null;
    if (openingTraceId && !opening) throw new Error('Opening start marker missing from detail ring; reproduce promptly');
    for (const raw of parsed.traceEvents ?? []) {
      if (opening && (raw.pid !== opening.pid || raw.tid !== opening.tid || raw.ts < opening.ts)) continue;
      const selected = selectEngineEvent(raw);
      if (selected) onEvent(selected);
    }
    return { bytes, rawEventCount: parsed.traceEvents?.length ?? 0 };
  } finally {
    await cdp.call('IO.close', { handle });
  }
}

export async function waitForTrace(completed, timeoutMs = 120_000) {
  let timer;
  return Promise.race([completed, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Trace finalization timed out after 120 seconds')), timeoutMs);
  })]).finally(() => clearTimeout(timer));
}

function logRows() {
  try { return readFileSync(logFile, 'utf8').split(/\r?\n/).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  }); } catch { return []; }
}

export function captureResetReason({ reloaded, previousBytes, bytes, opening, rows }) {
  if (reloaded) return 'page reloaded';
  if (bytes < previousBytes) return 'log cleared';
  if (opening && !rows.some(row => row.traceId === opening.traceId && row.msg === 'opening started')) return 'opening removed from log';
  return null;
}

function logBytes() {
  try { return readFileSync(logFile).length; } catch { return 0; }
}

function resetError(reason) {
  const error = new Error(`Capture discarded: ${reason}`);
  error.code = 'CAPTURE_RESET';
  return error;
}

export async function capture({ port = 9473, waitSeconds = 900, styleDetails = false, clean = false, cpuProfile = false } = {}) {
  if (cpuProfile && styleDetails) throw new Error('Use CPU and detailed style capture in separate runs');
  const deadline = Date.now() + waitSeconds * 1000;
  if (clean) {
    console.log('WAITING_FOR_CLEAR: finish Ctrl+F5 first, clear debug-agent.log, then wait for READY before opening a session');
    while (logBytes() > 0) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for an empty debug-agent.log');
      await delay(100);
    }
  }
  let target;
  console.log(`Waiting for desktop CDP on 127.0.0.1:${port}; no application will be launched`);
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) })).json();
      const matches = targets.filter(entry => {
        try { const url = new URL(entry.url); return entry.type === 'page' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.port === '1422'; }
        catch { return false; }
      });
      if (matches.length > 1) throw new Error('Multiple localhost:1422 targets; close duplicate desktop instances');
      if (matches.length === 1) { target = matches[0]; break; }
    } catch (error) { if (error.message.startsWith('Multiple')) throw error; }
    await delay(1000);
  }
  if (!target?.webSocketDebuggerUrl) throw new Error('Desktop CDP endpoint not available before timeout');
  const wsUrl = new URL(target.webSocketDebuggerUrl);
  if (!['localhost', '127.0.0.1'].includes(wsUrl.hostname)) throw new Error('CDP target must be loopback');
  const events = [];
  let dropped = 0;
  let dataLoss = false;
  let bufferPeak = 0;
  let complete;
  let pageGeneration = 0;
  const completed = new Promise(resolveComplete => { complete = resolveComplete; });
  const cdp = await connect(wsUrl, message => {
    if (message.method === 'Runtime.executionContextsCleared') pageGeneration++;
    else if (message.method === 'Tracing.dataCollected') {
      for (const raw of message.params.value) {
        const event = selectEngineEvent(raw);
        if (event) { if (events.length < 150_000) events.push(event); else dropped++; }
      }
    } else if (message.method === 'Tracing.bufferUsage') bufferPeak = Math.max(bufferPeak, message.params.percentFull ?? 0);
    else if (message.method === 'Tracing.tracingComplete') { dataLoss = Boolean(message.params?.dataLossOccurred); complete(message.params); }
  });
  let recording = false;
  let cpuRecording = false;
  let cpuResult;
  let interrupted = false;
  const interrupt = () => { interrupted = true; };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    if (clean) await cdp.call('Runtime.enable');
    const initialPageGeneration = pageGeneration;
    // Keep startup/HMR logs out: only a newly recorded opening is eligible.
    const previous = new Set(logRows().filter(row => row.msg === 'opening started').map(row => row.traceId));
    const highlightRulesBefore = await readHighlightRuleInventory(cdp);
    console.log(`Loaded highlight rules: ${JSON.stringify(highlightRulesBefore)}`);
    // The detail capture uses a bounded ring while waiting for the user's click.
    // Stop at reveal (3s fallback), not at the 15s frontend monitor boundary.
    // Idle per-node events are neither retained by Node nor written to the log.
    const categories = styleDetails ? detailCategories : engineCategories;
    const configuration = styleDetails ? { traceConfig: { recordMode: 'recordContinuously',
      traceBufferSizeInKb: 32768, includedCategories: categories.filter(c => c !== '-*'), excludedCategories: ['*'] } }
      : { categories: categories.join(','), options: 'recordUntilFull' };
    await cdp.call('Tracing.start', { ...configuration,
      transferMode: 'ReturnAsStream', streamFormat: 'json', bufferUsageReportingInterval: 1000 });
    recording = true;
    if (cpuProfile) {
      await cdp.call('Profiler.enable');
      await cdp.call('Profiler.setSamplingInterval', { interval: 1000 });
      await cdp.call('Profiler.start');
      cpuRecording = true;
      console.log('CPU sampling enabled: open within 60 seconds after READY; timings are diagnostic');
    }
    const armedAt = Date.now();
    console.log(clean ? 'READY: open the same session once; do not clear or reload again; leave it for 15 seconds'
      : 'READY: clear debug-agent.log, open the same session once, and leave it for 15 seconds');
    let previousBytes = logBytes();
    let opening;
    let finished = false;
    let openingSeenAt;
    let stopReason;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error('Capture interrupted');
      const rows = logRows();
      if (clean) {
        const bytes = logBytes();
        const reason = captureResetReason({ reloaded: pageGeneration !== initialPageGeneration,
          previousBytes, bytes, opening, rows });
        if (reason) throw resetError(reason);
        previousBytes = bytes;
      }
      opening ??= rows.find(row => row.msg === 'opening started' && !previous.has(row.traceId));
      if (cpuRecording && !opening && Date.now() - armedAt > 60_000) {
        throw new Error('CPU capture arm exceeded 60 seconds; retry the clean capture');
      }
      if (opening) {
        openingSeenAt ??= Date.now();
        if (cpuRecording && (rows.some(row => row.traceId === opening.traceId
          && row.loc === 'viewport.reveal.commit' && row.data?.phase === 'after')
          || Date.now() - openingSeenAt > 3000)) {
          cpuResult = (await cdp.call('Profiler.stop')).profile;
          cpuRecording = false;
        }
        if (styleDetails) {
          stopReason = shouldStopDetails(rows, opening.traceId, openingSeenAt, Date.now());
          if (stopReason) break;
        }
        if (rows.some(row => row.traceId === opening.traceId && row.msg === 'monitor finished')) { finished = true; break; }
        if (Date.now() - openingSeenAt > 25_000) break;
      }
      if (!styleDetails && bufferPeak > 0.9) throw new Error('Trace buffer nearly full; retry and reproduce promptly');
      await delay(styleDetails || clean ? 100 : 400);
    }
    console.log('Opening captured; stopping trace and waiting for browser finalization (up to 120 seconds)');
    await cdp.call('Tracing.end'); recording = false;
    const completion = await waitForTrace(completed);
    console.log('Reading finalized trace in 1 MiB chunks');
    const transfer = await readTraceStream(cdp, completion.stream, event => {
      if (events.length < 150_000) events.push(event); else dropped++;
    }, { openingTraceId: styleDetails ? opening?.traceId : undefined });
    if (!opening) throw new Error('No new opening received before timeout');
    const summary = summarizeEngineTrace(events, opening.traceId, dropped, dataLoss, { shortWindow: styleDetails });
    if (cpuRecording) {
      cpuResult = (await cdp.call('Profiler.stop')).profile;
      cpuRecording = false;
    }
    if (cpuProfile) {
      const openingRows = logRows().filter(row => row.traceId === opening.traceId);
      const pipeline = openingRows.findLast(row => row.traceId === opening.traceId
        && row.loc === 'openingSpans')?.data?.renderPipeline;
      const marker = events.find(event => event.traceId === opening.traceId && event.phase === 'start');
      // The engine marker follows the frontend clock origin by a small amount.
      // Correct it using an explicit frontend marker timestamp when available.
      const origin = marker.ts - (opening.data?.engineMarkerOffsetMs ?? 0) * 1000;
      summary.cpuProfile = cpuResult ? summarizeOpeningCpu(cpuResult, origin, openingCpuWindows(pipeline, openingRows))
        : { error: 'CPU profile unavailable' };
    }
    summary.monitorFinished = finished;
    summary.complete &&= styleDetails ? stopReason === 'reveal' : finished;
    if (styleDetails) {
      summary.stopReason = stopReason;
      summary.styleDetails.nodes = await describeStyleNodes(cdp, summary.styleDetails);
    }
    summary.bufferPeak = round(bufferPeak * 100);
    summary.categories = categories;
    summary.transfer = transfer;
    summary.invalidationTrackingEnabled = styleDetails;
    summary.highlightRules = { before: highlightRulesBefore, after: await readHighlightRuleInventory(cdp) };
    const end = logRows().findLast(row => row.traceId === opening.traceId) ?? opening;
    // Finalization/IO can outlive a refresh or log clear. Never append an old
    // engine summary to a new manual run, even if the capture itself completed.
    if (clean) {
      const reason = captureResetReason({ reloaded: pageGeneration !== initialPageGeneration,
        previousBytes, bytes: logBytes(), opening, rows: logRows() });
      if (reason) throw resetError(reason);
    }
    const record = { id: 'W', loc: 'opening.engineTrace', msg: 'renderer engine trace summary', data: summary,
      pageId: opening.pageId, traceId: opening.traceId, openingSessionId: opening.openingSessionId,
      clientNow: end.clientNow, sinceOpenMs: end.sinceOpenMs, timeOrigin: opening.timeOrigin,
      sequence: (end.sequence ?? 0) + 1, _receivedAt: new Date().toISOString() };
    appendFileSync(logFile, `${JSON.stringify(record)}\n`);
    console.log(JSON.stringify({ traceId: summary.traceId, complete: summary.complete, coverage: summary.coverage,
      revealMs: summary.revealMs, durationMs: summary.durationMs, dropped, dataLoss,
      invalidationCounts: summary.invalidationCounts, transfer }));
    console.log(`Saved engine summary to ${logFile}`);
  } finally {
    if (cpuRecording) {
      try { await cdp.call('Profiler.stop'); } catch { /* Discard interrupted samples. */ }
    }
    if (cpuProfile) {
      try { await cdp.call('Profiler.disable'); } catch { /* Connection may have closed. */ }
    }
    if (recording) {
      try {
        await cdp.call('Tracing.end');
        const completion = await waitForTrace(completed);
        if (completion.stream) await cdp.call('IO.close', { handle: completion.stream });
      } catch { /* Connection may have closed. */ }
    }
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    cdp.close();
  }
}

export async function captureClean(options) {
  const deadline = Date.now() + (options.waitSeconds ?? 900) * 1000;
  while (Date.now() < deadline) {
    try {
      return await capture({ ...options, clean: true, waitSeconds: Math.max(1, Math.ceil((deadline - Date.now()) / 1000)) });
    } catch (error) {
      if (error.code !== 'CAPTURE_RESET') throw error;
      console.log(`${error.message}; waiting to arm a clean capture again`);
    }
  }
  throw new Error('Clean capture timed out');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.includes('--help')) console.log('node capture-session-opening.mjs [--clean] [--style-details] [--cpu-profile] [--port 9473] [--wait-seconds 900]\nRequires a desktop restarted with --remote-debugging-port=9473 in WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS.\n--clean: refresh first, clear the log, wait for READY, then open once. Reload/clear discards an active capture and re-arms; successful capture still exits.\nWithout --clean: wait for READY, then clear the log and manually reproduce once. Results append to debug-agent.log.\n--style-details records invalidations and per-node style resolutions until reveal (3s fallback); a 32 MiB ring bounds idle tracing. Detailed timings are diagnostic, not a performance baseline.\n--cpu-profile adds 1ms CPU sampling until reveal (3s fallback). Open within 60 seconds after READY. Only allowlisted function labels and bounded gap summaries are saved.');
  else {
    const options = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--style-details') { options.styleDetails = true; continue; }
      if (args[i] === '--cpu-profile') { options.cpuProfile = true; continue; }
      if (args[i] === '--clean') { options.clean = true; continue; }
      const key = args[i] === '--port' ? 'port' : args[i] === '--wait-seconds' ? 'waitSeconds' : null;
      if (!key) throw new Error(`Unknown argument: ${args[i]}`);
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > (key === 'port' ? 65535 : 3600)) throw new Error(`Invalid ${key}`);
      options[key] = value;
    }
    (options.clean ? captureClean(options) : capture(options)).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}
