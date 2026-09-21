export interface OverflowMeasurement {
  distance: number;
  isOverflowing: boolean;
}

interface MeasurementJob {
  active: boolean;
  read: () => () => void;
}

const queues = new WeakMap<Window, {
  jobs: Set<MeasurementJob>;
  frame: number | null;
}>();

function enqueue(view: Window, read: MeasurementJob["read"]) {
  let queue = queues.get(view);
  if (!queue) {
    queue = { jobs: new Set(), frame: null };
    queues.set(view, queue);
  }
  const currentQueue = queue;
  const job = { active: true, read };
  currentQueue.jobs.add(job);
  if (currentQueue.frame === null) {
    currentQueue.frame = view.requestAnimationFrame(() => {
      currentQueue.frame = null;
      const jobs = Array.from(currentQueue.jobs);
      currentQueue.jobs.clear();
      // Read every label before publishing any React state. Mount layout effects
      // previously flushed pending page layout in each opening commit: native
      // scrollWidth probes measured 115.2, 197.8 and 144.6 ms in one desktop run.
      // Batching avoids that read/write interleaving; runtime savings need retesting.
      const publications = jobs.map(entry => entry.active ? entry.read() : null);
      jobs.forEach((entry, index) => {
        if (entry.active) publications[index]?.();
        entry.active = false;
      });
    });
  }
  return () => {
    job.active = false;
    currentQueue.jobs.delete(job);
    if (currentQueue.jobs.size === 0 && currentQueue.frame !== null) {
      view.cancelAnimationFrame(currentQueue.frame);
      currentQueue.frame = null;
    }
  };
}

/** Observe one label; all labels in its window share a deferred read phase. */
export function observeOverflowText(
  element: HTMLElement,
  content: HTMLElement,
  options: { lines?: number; observeMutations: boolean },
  publish: (measurement: OverflowMeasurement) => void,
): () => void {
  const view = element.ownerDocument.defaultView;
  if (!view) return () => {};
  let cancelPending: (() => void) | null = null;
  let disposed = false;
  const schedule = () => {
    if (disposed || cancelPending) return;
    cancelPending = enqueue(view, () => {
      const width = element.clientWidth;
      const distance = Math.max(0, content.scrollWidth - width);
      // Only multiline clamps use vertical overflow; single-line font boxes
      // can exceed the line height without indicating truncated text.
      const height = options.lines !== undefined ? element.clientHeight : 0;
      const verticalOverflow = height > 0 && element.scrollHeight > height;
      const isOverflowing = width > 0 && (distance > 0 || verticalOverflow);
      return () => {
        cancelPending = null;
        publish({ distance, isOverflowing });
      };
    });
  };
  const resizeObserver = typeof view.ResizeObserver === "undefined"
    ? null
    : new view.ResizeObserver(schedule);
  resizeObserver?.observe(element);
  if (content !== element) resizeObserver?.observe(content);
  const mutationObserver = !options.observeMutations || typeof view.MutationObserver === "undefined"
    ? null
    : new view.MutationObserver(schedule);
  mutationObserver?.observe(element, { childList: true, characterData: true, subtree: true });
  const fontSet = element.ownerDocument.fonts;
  fontSet?.addEventListener("loadingdone", schedule);
  if (!resizeObserver) view.addEventListener("resize", schedule);
  schedule();

  return () => {
    disposed = true;
    resizeObserver?.disconnect();
    mutationObserver?.disconnect();
    fontSet?.removeEventListener("loadingdone", schedule);
    if (!resizeObserver) view.removeEventListener("resize", schedule);
    cancelPending?.();
  };
}
