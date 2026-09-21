// #region agent log
// Temporary opening-only instrumentation. Delegate each native read exactly
// once, preserve its result/exception, and restore descriptors after the trace.
export function installOpeningGeometryProbe(
  report: (element: Element, data: Record<string, unknown>) => void,
) {
  const restores: Array<() => void> = [];
  const totals = new Map<string, { count: number; totalMs: number; maxMs: number }>();
  let slowReads = 0;
  let emitted = 0;
  let stopped = false;
  const instrument = (prototype: object, name: string, getter: boolean) => {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    const original = getter ? descriptor?.get : descriptor?.value;
    if (!descriptor?.configurable || typeof original !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (stopped) return Reflect.apply(original, this, args);
      const startedAt = performance.now();
      try {
        return Reflect.apply(original, this, args);
      } finally {
        const durationMs = performance.now() - startedAt;
        const stats = totals.get(name) ?? { count: 0, totalMs: 0, maxMs: 0 };
        stats.count++;
        stats.totalMs += durationMs;
        stats.maxMs = Math.max(stats.maxMs, durationMs);
        totals.set(name, stats);
        if (durationMs >= 8) {
          slowReads++;
          if (emitted < 12 && this instanceof Element) {
            emitted++;
            // Diagnostics must not change a native read's result or exception.
            try {
              const stack = (new Error().stack ?? '').split('\n').slice(1)
                .filter(line => !line.includes('sessionOpeningGeometryProbe'))
                .slice(0, 7).map(line => line.trim()
                  .replace(/\?[^)\s]*?(?=:\d+:\d+(?:\)|$))/g, ''));
              report(this, { api: name, startedAt, durationMs, stack });
            } catch { /* Keep instrumentation observational. */ }
          }
        }
      }
    };
    Object.defineProperty(prototype, name, getter
      ? { ...descriptor, get: wrapped }
      : { ...descriptor, value: wrapped });
    restores.push(() => {
      const current = Object.getOwnPropertyDescriptor(prototype, name);
      if ((getter ? current?.get : current?.value) === wrapped) {
        Object.defineProperty(prototype, name, descriptor);
      }
    });
  };
  for (const name of ['getBoundingClientRect', 'getClientRects']) instrument(Element.prototype, name, false);
  for (const name of ['scrollHeight', 'scrollWidth', 'scrollTop', 'clientHeight', 'clientWidth']) {
    instrument(Element.prototype, name, true);
  }
  for (const name of ['offsetHeight', 'offsetWidth', 'offsetTop', 'offsetLeft']) {
    instrument(HTMLElement.prototype, name, true);
  }
  return () => {
    stopped = true;
    for (const restore of restores) restore();
    return {
      slowReads, emitted,
      reads: [...totals].map(([api, stats]) => ({ api, ...stats })),
    };
  };
}
// #endregion
