// Temporary, read-only JSONL report. No message content or script URLs are printed.
// Usage: node analyze-session-opening.mjs [log-file] [--all | --trace ID] [--json]
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
let file = fileURLToPath(new URL('./debug-agent.log', import.meta.url));
let traceId;
let all = false;
let json = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--all') all = true;
  else if (args[i] === '--json') json = true;
  else if (args[i] === '--trace') {
    traceId = args[++i];
    if (!traceId) throw new Error('--trace requires an ID');
  } else if (args[i].startsWith('--')) throw new Error(`Unknown option: ${args[i]}`);
  else file = resolve(args[i]);
}
const groups = new Map();
let malformed = 0;
let ignored = 0;
for (const line of readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
  if (!line.trim()) continue;
  let row;
  try { row = JSON.parse(line); } catch { malformed++; continue; }
  if (!row?.traceId || !Number.isFinite(row.clientNow)) { ignored++; continue; }
  const key = `${row.pageId ?? ''}:${row.traceId}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key).push(row);
}
const round = value => Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
const stats = values => ({ count: values.length,
  totalMs: round(values.reduce((sum, value) => sum + value, 0)),
  maxMs: round(Math.max(0, ...values)) });
const start = rows => Math.min(...rows.map(r => (r.timeOrigin ?? 0) + r.clientNow - (r.sinceOpenMs ?? 0)));
let traces = [...groups.values()].sort((a, b) => start(a) - start(b));
if (traceId) traces = traces.filter(rows => rows[0].traceId === traceId);
else if (!all) traces = traces.slice(-1);
if (!traces.length) throw new Error('No matching opening trace found');

function summarize(input) {
  const rows = [...input].sort((a, b) => a.clientNow - b.clientNow || a.sequence - b.sequence);
  const summary = rows.findLast(r => r.loc === 'openingSpans' && r.msg === 'summary');
  const monitor = rows.findLast(r => r.msg === 'monitor finished');
  const mutations = rows.filter(r => r.loc === 'layoutMutations');
  const context = row => {
    const batch = row.data?.mutationsBefore?.batch;
    const mutation = mutations.findLast(r => batch === undefined
      ? r.clientNow <= row.clientNow : r.data.batch === batch);
    return mutation ? { batch: mutation.data.batch,
      groups: mutation.data.groups.map(g => `${g.key}(${g.count},+${g.added}/-${g.removed})`),
      omittedGroups: mutation.data.omittedGroups } : null;
  };
  const styleReads = rows.filter(r => r.msg === 'diagnostic style read');
  const reveal = rows.filter(r => r.loc.startsWith('viewport.reveal.') && r.loc !== 'viewport.reveal.rows').map(r => ({
    atMs: r.sinceOpenMs, phase: r.data.phase ?? 'staged', durationMs: r.data.durationMs,
    styleMs: r.data.styleMs, layoutMs: r.data.layoutMs, inert: r.data.inert,
    stages: r.data.stages, diagnosticOnly: r.data.diagnosticOnly,
    failed: r.data.failed, mutation: context(r),
    clientWidth: r.data.clientWidth, clientHeight: r.data.clientHeight,
    scrollHeight: r.data.scrollHeight, scrollTop: r.data.scrollTop, maxScrollTop: r.data.maxScrollTop,
    requestedContain: r.data.requestedContain, scrollerContain: r.data.scrollerContain,
    queryBypass: r.data.queryBypass, queryContainerName: r.data.queryContainerName,
    queryContainerType: r.data.queryContainerType,
  }));
  const frames = rows.filter(r => r.msg === 'long animation frame');
  return {
    traceId: rows[0].traceId, sessionId: rows[0].openingSessionId, records: rows.length,
    complete: Boolean(summary && monitor),
    engineTrace: rows.findLast(r => r.loc === 'opening.engineTrace')?.data,
    renderPipeline: summary?.data.renderPipeline,
    scrollerContainmentExperiment: rows.find(r => r.msg === 'opening started')?.data.scrollerContainmentExperiment ?? 'unrecorded',
    rowStylePreflightExperiment: rows.find(r => r.msg === 'opening started')?.data.rowStylePreflightExperiment ?? false,
    containerQueryBypassExperiment: rows.find(r => r.msg === 'opening started')?.data.containerQueryBypassExperiment ?? false,
    revealedRowGeometry: rows.find(r => r.loc === 'viewport.reveal.rows')?.data,
    rowStylePreflights: rows.filter(r => r.loc === 'virtualizer.rowStylePreflight').map(r => ({
      atMs: r.sinceOpenMs, ...r.data, mutation: context(r),
    })),
    frameCallbacks: rows.filter(r => r.msg === 'opening frame callback')
      .map(r => ({ frame: r.data.frameCount, atMs: r.sinceOpenMs })),
    monitor: monitor?.data,
    reveal,
    spans: [...(summary?.data.spans ?? [])].sort((a, b) => b.totalMs - a.totalMs).slice(0, 12),
    measurements: summary?.data.measurements ?? [],
    geometryReads: summary?.data.geometryReads,
    slowGeometryReads: rows.filter(r => r.loc === 'opening.geometryRead')
      .map(r => ({ atMs: r.sinceOpenMs, ...r.data })),
    layoutContext: summary?.data.layoutContext,
    layoutSamples: rows.filter(r => r.loc === 'opening.layoutContext').map(r => {
      const span = rows.find(s => s.loc === 'virtualizer.measure.sync'
        && s.data.startedAt <= r.data.readStartedAt
        && s.data.startedAt + s.data.durationMs + 0.2 >= r.data.readStartedAt + r.data.readDurationMs);
      const batch = mutations.find(m => m.data.batch === r.data.mutationBatch);
      return { atMs: r.sinceOpenMs, ...r.data,
        mutationBeforeRead: span ? context(span) : null,
        mutationAtCompletion: batch?.data ?? null };
    }),
    omittedMeasurementCalls: summary?.data.omittedMeasurementCalls ?? 0,
    positionEventCounts: summary?.data.positionEventCounts ?? {},
    openingPositions: rows.filter(r => r.loc === 'virtualizer.commitState' || r.msg === 'opening position event')
      .map(r => ({ atMs: r.sinceOpenMs, loc: r.loc, ...r.data })),
    windowCauses: rows.filter(r => ['virtualizer.rangeDecision', 'virtualizer.offsetInput', 'virtualizer.sizeChange', 'virtualizer.rectInput'].includes(r.loc))
      .map(r => ({ atMs: r.sinceOpenMs, loc: r.loc, ...r.data })),
    styleReads: stats(styleReads.map(r => r.data.durationMs)),
    slowStyleReads: [...styleReads].sort((a, b) => b.data.durationMs - a.data.durationMs).slice(0, 4)
      .map(r => ({ atMs: r.sinceOpenMs, durationMs: r.data.durationMs,
        sample: r.data.sample, settled: r.data.settled, mutation: context(r) })),
    reactRender: stats(rows.filter(r => r.msg === 'react commit').map(r => r.data.actualDuration)),
    longTasks: stats(rows.filter(r => r.msg === 'long task').map(r => r.data.durationMs)),
    longFrames: frames.length,
    forcedStyleScripts: frames.flatMap(r => (r.data.scripts ?? []).map(s => ({
      atMs: round(r.sinceOpenMs - r.clientNow + s.startTime),
      function: s.function || s.invokerType,
      durationMs: s.durationMs,
      forcedMs: s.forcedStyleAndLayoutMs,
    }))).sort((a, b) => b.forcedMs - a.forcedMs).slice(0, 5),
  };
}
const reports = traces.map(summarize);
if (json) {
  console.log(JSON.stringify({ malformed, ignored, reports }, (_key, value) =>
    typeof value === 'number' ? round(value) : value, 2));
} else {
  console.log(`Opening report | malformed=${malformed} ignored=${ignored} | times in ms`);
  console.log('Spans may nest; do not add across rows. rAF/reveal timestamps are not paint timings.');
  for (const r of reports) {
    console.log(`\n${r.traceId} | session=${r.sessionId} | records=${r.records} complete=${r.complete}`);
    console.log(`Scroller containment experiment: ${r.scrollerContainmentExperiment}`);
    if (r.renderPipeline) {
      console.log(`Render pipeline boundaries: ${JSON.stringify(r.renderPipeline.events)}`);
      if (r.renderPipeline.workBeforeFirstRow) {
        const work = r.renderPipeline.workBeforeFirstRow;
        console.log(`  first-row gap work: ${JSON.stringify([...work].sort((a,b) => b.durationMs-a.durationMs).slice(0, 12))}`);
        console.log(`  captured=${work.length} omitted=${r.renderPipeline.omittedWork}`);
      }
      r.renderPipeline.commits.slice(0, 8).forEach(commit => console.log(`  render commit ${JSON.stringify(commit)}`));
      console.log(`  ${r.renderPipeline.note}`);
    }
    if (r.engineTrace) {
      const e = r.engineTrace;
      console.log(`Engine trace: complete=${e.complete} coverage=${e.coverage ?? 'opening-15s'} reveal=${e.revealMs} dropped=${e.dropped} dataLoss=${e.dataLoss}`);
      console.log(`  before reveal: ${JSON.stringify(e.beforeReveal)}`);
      if (e.cpuProfile) console.log(`  CPU gap attribution: ${JSON.stringify(e.cpuProfile)}`);
      console.log(`  invalidations: ${JSON.stringify(e.invalidationCounts)}`);
      if (e.highlightRules) console.log(`  highlight rules: ${JSON.stringify(e.highlightRules)}`);
      if (e.styleDetails) {
        for (const phase of ['beforeReveal', 'afterReveal']) console.log(`  style ${phase}: ${JSON.stringify(e.styleDetails[phase])}`);
        e.styleDetails.slowUpdates.forEach(update => console.log(`  style update ${JSON.stringify(update)}`));
        console.log(`  style node regions: ${JSON.stringify(e.styleDetails.nodes)}`);
        console.log('  Detailed style tracking changes timing; use it for attribution, not speed comparison.');
      }
      e.slowEvents.slice(0, 10).forEach(event => console.log(`  engine ${JSON.stringify(event)}`));
      console.log('  Engine phase totals may nest; do not sum across categories.');
    }
    if (r.rowStylePreflightExperiment) console.log('Row style preflight: enabled (API stages may also include layout)');
    console.log(`Container query bypass: ${r.containerQueryBypassExperiment}`);
    console.log(`rAF: ${r.frameCallbacks.map(f => `${f.frame}=${f.atMs}`).join(' ')} | maxGap=${r.monitor?.maxGapMs ?? '?'} slowFrames=${r.monitor?.slowFrames ?? '?'}`);
    for (const q of r.reveal) {
      console.log(`Reveal ${q.phase} @${q.atMs}: total=${q.durationMs} style=${q.styleMs ?? '-'} layout=${q.layoutMs ?? '-'} inert=${q.inert ?? '-'}`);
      if (q.scrollerContain !== undefined) console.log(`  viewport=${q.clientWidth}x${q.clientHeight} scrollHeight=${q.scrollHeight} scrollTop=${q.scrollTop}/${q.maxScrollTop} contain=${q.scrollerContain} requested=${q.requestedContain}`);
      if (q.queryContainerName !== undefined) console.log(`  query container: name=${q.queryContainerName} type=${q.queryContainerType} bypass=${q.queryBypass}`);
      if (q.stages) console.log(`  stages (style/layout): ${q.stages.map(s => `${s.stage}=${s.styleMs}/${s.layoutMs}`).join(', ')}; diagnosticOnly=${q.diagnosticOnly ?? false} failed=${q.failed ?? false}`);
      console.log(`  mutations: ${q.mutation?.groups.join(', ') ?? 'unavailable'}`);
    }
    console.log('Spans: location | count | total | max');
    if (r.revealedRowGeometry) console.log(`Revealed row geometry: ${JSON.stringify(r.revealedRowGeometry)}`);
    r.spans.forEach(s => console.log(`  ${s.loc} | ${s.count} | ${s.totalMs} | ${s.maxMs}`));
    if (r.measurements.length) {
      console.log('Measurement calls: key | count');
      r.measurements.slice(0, 12).forEach(m => console.log(`  ${m.key} | ${m.count}`));
      console.log(`  showing ${Math.min(12, r.measurements.length)}/${r.measurements.length} groups; omitted calls=${r.omittedMeasurementCalls}; use --json for all captured groups`);
    }
    if (r.openingPositions.length) {
      console.log(`Opening positions: captured=${r.openingPositions.length}; request totals=${JSON.stringify(r.positionEventCounts)}`);
      const positions = r.openingPositions.filter(p => !r.windowCauses.some(c => c.loc === p.loc));
      positions.slice(0, 24).forEach(p => console.log(`  ${JSON.stringify(p)}`));
      if (positions.length > 24) console.log('  remaining captured events available with --json');
    }
    if (r.windowCauses.length) {
      console.log(`Window inputs: ${r.windowCauses.length} captured events; first 20 below, full capture with --json`);
      r.windowCauses.slice(0, 20).forEach(p => console.log(`  ${JSON.stringify(p)}`));
    }
    console.log(`Style probes: ${JSON.stringify(r.styleReads)} | React render: ${JSON.stringify(r.reactRender)}`);
    for (const p of r.rowStylePreflights) {
      console.log(`  preflight row=${p.index} documentStyle=${p.documentStyleMs} rowStyle=${p.rowStyleMs} measureCall=${p.measureCallMs} total=${p.totalMs} size=${p.sizePx ?? '-'} succeeded=${p.succeeded} failures=${JSON.stringify(p.failures)}`);
      console.log(`    mutations: ${p.mutation?.groups.join(', ') ?? 'unavailable'}`);
    }
    if (r.geometryReads) {
      console.log(`Native geometry reads: slow=${r.geometryReads.slowReads} captured=${r.geometryReads.emitted}`);
      [...r.slowGeometryReads].sort((a, b) => b.durationMs - a.durationMs).slice(0, 5).forEach(g => {
        console.log(`  @${g.atMs} ${g.api}=${g.durationMs} region=${g.region} row=${g.index ?? '-'} batch=${g.mutationsAtCompletion?.batch ?? '-'}`);
        (g.stack ?? []).slice(0, 5).forEach(frame => console.log(`    ${frame}`));
      });
    }
    if (r.layoutSamples.length) {
      console.log(`Layout context: ${JSON.stringify(r.layoutContext)}; DOM counts are not actual reflow scope`);
      for (const s of r.layoutSamples) {
        console.log(`  row=${s.measuredRow} ${s.api}=${s.readDurationMs} scope=${s.scope} visited=${s.visited} truncated=${s.truncated} probe=${s.probeMs}`);
        console.log(`    totals=${JSON.stringify(s.totals)}`);
        console.log(`    rows=${s.rows.map(row => `${row.index}:nodes=${row.elements},chars=${row.textChars},depth=${row.maxDepth},pre=${row.pre},table=${row.table},svgParts=${row.svgParts}`).join(' | ')}`);
        console.log(`    before read: ${s.mutationBeforeRead?.groups.join(', ') ?? 'unavailable'}`);
        console.log(`    ancestors: ${s.ancestors.map(a => `${a.level}:${a.tag}/${a.role} display=${a.display} contain=${a.contain} cv=${a['content-visibility']} overflow=${a['overflow-x']}/${a['overflow-y']}`).join(' | ')}`);
      }
    }
    r.slowStyleReads.forEach(s => console.log(`  style #${s.sample} @${s.atMs}=${s.durationMs} settled=${s.settled}; ${s.mutation?.groups.join(', ') ?? ''}`));
    console.log(`Long tasks: ${JSON.stringify(r.longTasks)} | sampled long frames=${r.longFrames}`);
    r.forcedStyleScripts.forEach(s => console.log(`  forced @${s.atMs} ${s.function}: ${s.forcedMs} (script=${s.durationMs})`));
  }
}
