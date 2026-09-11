// #region agent log
// Temporary interactive-debug instrumentation. Counts are proxies, not retained bytes.
import { useEffect, useId } from 'react';
import { flowChatStore } from '../../store/FlowChatStore';
import { getActiveSurfaceId } from '@/infrastructure/peer-device/deviceSurface';
import type { FlowItem, FlowToolItem } from '../../types/flow-chat';

const runId = `${Date.now()}`;
const panels = new Map<string, { sessionId?: string; commits: number; projectedRows: number }>();
let timer: ReturnType<typeof setInterval> | undefined;

function heap() {
  const memory = (performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  }).memory;
  return memory ? {
    usedBytes: memory.usedJSHeapSize, allocatedBytes: memory.totalJSHeapSize,
    limitBytes: memory.jsHeapSizeLimit,
  } : null;
}

function emit(hypothesis: string, location: string, data: unknown) {
  if (!import.meta.env.DEV) return;
  void fetch('http://127.0.0.1:7469/log', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hypothesis, location, message: 'Memory diagnostic observation',
      runId, surfaceId: getActiveSurfaceId(), timestamp: new Date().toISOString(), data }),
    signal: AbortSignal.timeout(2000),
  }).catch(() => {});
}

function sample() {
  const heapBeforeSampling = heap();
  const started = performance.now();
  const sessions = [...flowChatStore.getState().sessions.values()].map(session => {
    let rounds = 0;
    let characters = 0;
    let imageCharacters = 0;
    let opaqueToolResults = 0;
    const items = new Set<FlowItem>();
    for (const turn of session.dialogTurns) {
      characters += turn.userMessage?.content?.length ?? 0;
      for (const image of turn.userMessage?.images ?? []) imageCharacters += image.dataUrl?.length ?? 0;
      for (const round of turn.modelRounds) {
        rounds += 1;
        for (const item of round.items) items.add(item);
        for (const attempt of round.attempts ?? []) for (const item of attempt.items) items.add(item);
      }
    }
    for (const item of items) {
      const content = (item as FlowItem & { content?: unknown }).content;
      if (typeof content === 'string') characters += content.length;
      if (item.type === 'tool') {
        const result = (item as FlowToolItem).toolResult;
        characters += result?.resultForAssistant?.length ?? 0;
        if (typeof result?.result === 'string') characters += result.result.length;
        else if (result?.result && typeof result.result === 'object') opaqueToolResults += 1;
        for (const image of result?.imageAttachments ?? []) imageCharacters += image.data_base64.length;
      }
    }
    return { sessionId: session.sessionId, kind: session.sessionKind, turns: session.dialogTurns.length,
      rounds, items: items.size, characters, imageCharacters, opaqueToolResults };
  });
  const totals = sessions.reduce((sum, session) => ({
    turns: sum.turns + session.turns, items: sum.items + session.items,
    characters: sum.characters + session.characters, imageCharacters: sum.imageCharacters + session.imageCharacters,
  }), { turns: 0, items: 0, characters: 0, imageCharacters: 0 });
  const panelDom = [...document.querySelectorAll<HTMLElement>('.btw-session-panel')].map(panel => ({
    nodes: panel.getElementsByTagName('*').length,
    renderedRows: panel.querySelectorAll('[data-virtual-item-key]').length,
    height: panel.clientHeight,
  }));
  emit('A/B/C/D', 'subagentMemory.sample', {
    heap: heapBeforeSampling, sessionCount: sessions.length, totals,
    largestSessions: sessions.sort((a, b) => b.characters + b.imageCharacters - a.characters - a.imageCharacters).slice(0, 20),
    panels: [...panels.entries()].map(([id, value]) => ({ id, ...value })), panelDom,
    documentNodes: document.getElementsByTagName('*').length,
    sampleDurationMs: performance.now() - started,
    // Object tool payloads, shared strings, browser-native and GPU memory are not measured here.
  });
  for (const panel of panels.values()) panel.commits = 0;
}

export function startSubagentMemoryProbe() {
  if (!import.meta.env.DEV || timer) return;
  emit('A/B/C/D', 'subagentMemory.started', {
    heap: heap(), intervalMs: 10000,
    hypotheses: {
      A: 'Background session data growth',
      B: 'Mounted transcript DOM and rendering allocation',
      C: 'Retention or delayed garbage collection after panel unmount',
      D: 'WebView2 native or GPU memory outside the JavaScript heap',
    },
  });
  sample();
  timer = setInterval(sample, 10000);
}

export function useSubagentMemoryProbe(sessionId: string | undefined, projectedRows: number) {
  const id = useId();
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    panels.set(id, { sessionId, projectedRows: 0, commits: 0 });
    emit('B/C', 'subagentMemory.panelMounted', { id, sessionId, heap: heap() });
    return () => {
      panels.delete(id);
      emit('B/C', 'subagentMemory.panelUnmounted', { id, sessionId, heap: heap() });
    };
  }, [id, sessionId]);
  useEffect(() => {
    const panel = panels.get(id);
    if (panel) { panel.commits += 1; panel.projectedRows = projectedRows; }
  });
}

if (import.meta.hot) import.meta.hot.dispose(() => {
  if (timer) clearInterval(timer);
  timer = undefined;
  panels.clear();
});
// #endregion
