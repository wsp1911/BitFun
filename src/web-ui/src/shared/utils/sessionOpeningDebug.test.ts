// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('opening reveal commit probe', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv('MODE', 'development');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({}));
    vi.stubGlobal('requestAnimationFrame', vi.fn().mockReturnValue(1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    vi.advanceTimersByTime(15001);
    document.body.replaceChildren();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function openingList() {
    const list = document.createElement('div');
    list.className = 'virtual-message-list';
    list.setAttribute('data-open-viewport-settled', 'false');
    list.setAttribute('aria-hidden', 'true');
    const scroller = document.createElement('div');
    list.append(scroller);
    document.body.append(list);
    return { list, scroller };
  }

  it('measures each phase once per trace without changing reveal state', async () => {
    const debug = await import('./sessionOpeningDebug');
    const { list, scroller } = openingList();
    debug.probeSessionOpeningReveal(scroller);
    expect(fetch).not.toHaveBeenCalled();
    const states: string[] = [];
    const original = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      // Reveal also samples the scroller's effective containment for the A/B run.
      if (element.classList.contains('virtual-message-list')) {
        states.push(`${element.hasAttribute('inert')}:${element.hasAttribute('aria-hidden')}:${element.getAttribute('data-open-viewport-settled')}`);
      }
      return original(element);
    });
    debug.beginSessionOpening('test-session', 'click');
    debug.probeSessionOpeningReveal(scroller);
    expect(states).toEqual(['false:true:false']);
    expect(list.hasAttribute('inert')).toBe(false);
    expect(list.hasAttribute('aria-hidden')).toBe(true);
    expect(list.getAttribute('data-open-viewport-settled')).toBe('false');
    const second = openingList();
    debug.probeSessionOpeningReveal(second.scroller);
    expect(states).toHaveLength(1);
    list.removeAttribute('aria-hidden');
    list.setAttribute('data-open-viewport-settled', 'true');
    debug.probeSessionOpeningReveal(scroller);
    debug.probeSessionOpeningReveal(scroller);
    expect(states).toEqual(['false:true:false', 'false:false:true']);
  });

  it('leaves the hidden state untouched when a diagnostic read fails', async () => {
    const debug = await import('./sessionOpeningDebug');
    const { list, scroller } = openingList();
    vi.spyOn(window, 'getComputedStyle')
      .mockImplementationOnce(() => { throw new Error('diagnostic failure'); });
    debug.beginSessionOpening('test-session', 'click');
    expect(() => debug.probeSessionOpeningReveal(scroller)).not.toThrow();
    expect(list.hasAttribute('inert')).toBe(false);
    expect(list.getAttribute('aria-hidden')).toBe('true');
    expect(list.getAttribute('data-open-viewport-settled')).toBe('false');
  });

  it('times style preflight before one original read and samples once per mutation batch', async () => {
    const debug = await import('./sessionOpeningDebug');
    const { scroller } = openingList();
    const row = document.createElement('div');
    row.dataset.virtualIndex = '27';
    scroller.appendChild(row);
    let time = 100;
    const order: string[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation(target => {
      const isDocument = target === document.documentElement;
      order.push(isDocument ? 'document' : 'row');
      time += isDocument ? 12 : 34;
      return { visibility: 'visible' } as CSSStyleDeclaration;
    });
    const measure = vi.fn(() => { order.push('measure'); time += 56; return 111; });
    expect(debug.probeSessionOpeningRowMeasurement(row, measure)).toBe(111);
    expect(styles).not.toHaveBeenCalled();
    order.length = 0;
    measure.mockClear();
    debug.beginSessionOpening('test-session', 'click');
    const before = document.body.innerHTML;
    expect(debug.probeSessionOpeningRowMeasurement(row, measure)).toBe(111);
    expect(order).toEqual(['document', 'row', 'measure']);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(document.body.innerHTML).toBe(before);
    const logs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(logs.find(log => log.loc === 'virtualizer.rowStylePreflight')?.data).toMatchObject({
      documentStyleMs: 12, rowStyleMs: 34, measureCallMs: 56, totalMs: 102,
      sizePx: 111, succeeded: true, failures: [], diagnosticOnly: true,
    });
    debug.probeSessionOpeningRowMeasurement(row, measure);
    expect(styles).toHaveBeenCalledTimes(2);
    expect(measure).toHaveBeenCalledTimes(2);
    row.style.paddingTop = '1px';
    debug.probeSessionOpeningRowMeasurement(row, measure);
    expect(styles).toHaveBeenCalledTimes(4);
    expect(measure).toHaveBeenCalledTimes(3);
  });

  it('preserves the original error even if both style preflight stages fail', async () => {
    const debug = await import('./sessionOpeningDebug');
    const { scroller } = openingList();
    vi.spyOn(window, 'getComputedStyle').mockImplementation(() => { throw new Error('style failed'); });
    debug.beginSessionOpening('test-session', 'click');
    const failure = new Error('original measurement failed');
    const measure = vi.fn(() => { throw failure; });
    expect(() => debug.probeSessionOpeningRowMeasurement(scroller, measure)).toThrow(failure);
    expect(measure).toHaveBeenCalledTimes(1);
    const logs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(logs.find(log => log.loc === 'virtualizer.rowStylePreflight')?.data).toMatchObject({
      succeeded: false, failures: ['document', 'row'],
    });
  });

  it('samples only after slow reads, once per row and at most three rows per opening', async () => {
    const debug = await import('./sessionOpeningDebug');
    const { scroller } = openingList();
    scroller.className = 'virtual-message-list__scroller';
    const rows = Array.from({ length: 4 }, (_, index) => {
      const row = document.createElement('div');
      row.className = 'virtual-item-wrapper';
      row.dataset.virtualIndex = String(index);
      scroller.appendChild(row);
      return row;
    });
    let time = 100;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    const read = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => {
      time += 20;
      return 42;
    });
    const getStyle = window.getComputedStyle.bind(window);
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      expect(read).toHaveBeenCalled();
      return getStyle(element);
    });
    debug.beginSessionOpening('test-session', 'click');
    expect(window.getComputedStyle).not.toHaveBeenCalled();
    expect(rows[0].offsetHeight).toBe(42);
    for (const row of rows) expect(row.offsetHeight).toBe(42);
    expect(read).toHaveBeenCalledTimes(5);
    const logs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(logs.filter(log => log.loc === 'opening.layoutContext').map(log => log.data.measuredRow)).toEqual([0, 1, 2]);
    expect(logs.filter(log => log.loc === 'opening.geometryRead')).toHaveLength(5);
  });

  it('buffers bounded pipeline facts and groups nested profilers by commit without per-component logs', async () => {
    const debug = await import('./sessionOpeningDebug');
    debug.beginSessionOpening('pipeline-test', 'click');
    const start = debug.sessionOpeningNow();
    const beforeCalls = vi.mocked(fetch).mock.calls.length;
    for (let index = 0; index < 30; index++) debug.recordOpeningPipeline('row.ref.beforeMeasure', { index });
    debug.profileOpeningRenderWork('list', 'mount', 30, 40, start + 1, start + 50);
    debug.profileOpeningRenderWork('markdown.parseAndRender', 'mount', 8, 9, start + 2, start + 50);
    debug.profileOpeningRenderWork('markdown.parseAndRender', 'mount', 4, 5, start + 3, start + 50);
    expect(vi.mocked(fetch).mock.calls.length).toBe(beforeCalls);
    vi.advanceTimersByTime(15001);
    const logs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    const pipeline = logs.find(row => row.loc === 'openingSpans').data.renderPipeline;
    expect(pipeline.events).toHaveLength(16);
    expect(pipeline.counts['row.ref.beforeMeasure']).toBe(30);
    expect(pipeline.commits).toHaveLength(1);
    expect(pipeline.commits[0].groups.list.actualMs).toBe(30);
    expect(pipeline.commits[0].groups['markdown.parseAndRender']).toMatchObject({ count: 2, actualMs: 12, maxMs: 8 });
    debug.beginSessionOpening('second-pipeline', 'click');
    vi.advanceTimersByTime(15001);
    const nextLogs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(nextLogs.filter(row => row.loc === 'openingSpans').at(-1).data.renderPipeline.commits).toEqual([]);
  });

  it('preserves effect dependencies and cleanup while timing only the first-row gap', async () => {
    const debug = await import('./sessionOpeningDebug');
    const { createElement, act } = await import('react');
    const { createRoot } = await import('react-dom/client');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const calls: string[] = [];
    function Fixture({ revision }: { revision: number }) {
      debug.useOpeningPipelineLayoutEffect('test.layout', () => {
        calls.push(`layout:${revision}`);
        return () => { calls.push(`layout-cleanup:${revision}`); };
      }, [revision]);
      debug.useOpeningPipelineEffect('test.passive', () => {
        calls.push(`passive:${revision}`);
        return () => { calls.push(`passive-cleanup:${revision}`); };
      }, [revision]);
      return null;
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    debug.beginSessionOpening('effects-test', 'click');
    act(() => root.render(createElement(Fixture, { revision: 1 })));
    act(() => root.render(createElement(Fixture, { revision: 1 })));
    expect(calls).toEqual(['layout:1', 'passive:1']);
    act(() => root.render(createElement(Fixture, { revision: 2 })));
    expect(calls.filter(x => x.endsWith('cleanup:1'))).toHaveLength(2);
    debug.recordOpeningPipeline('row.ref.beforeMeasure');
    act(() => root.unmount());
    expect(calls.slice(-2)).toEqual(['layout-cleanup:2', 'passive-cleanup:2']);
    vi.advanceTimersByTime(15001);
    const logs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    const work = logs.find(row => row.loc === 'openingSpans').data.renderPipeline.workBeforeFirstRow;
    expect(work).toHaveLength(6);
    expect(work.filter((entry: { stage: string }) => entry.stage.endsWith('.cleanup'))).toHaveLength(2);
  });

  it.each([false, true])('never mutates boundary nodes or attributes (read failure=%s)', async fail => {
    const debug = await import('./sessionOpeningDebug');
    const { list, scroller } = openingList();
    list.setAttribute('data-flowchat-opening', 'true');
    const before = document.createElement('span');
    before.setAttribute('data-flowchat-opening-guard', 'before');
    const after = document.createElement('span');
    after.setAttribute('data-flowchat-opening-guard', 'after');
    list.before(before);
    list.after(after);
    const shield = document.createElement('div');
    shield.className = 'virtual-message-list__opening-shield';
    list.append(shield);
    const originalNodes = [...document.body.childNodes];
    const originalChildren = [...list.childNodes];
    const original = window.getComputedStyle.bind(window);
    const observer = new MutationObserver(() => {});
    observer.observe(document.body, { subtree: true, childList: true, attributes: true });
    vi.spyOn(window, 'getComputedStyle').mockImplementation(element => {
      if (fail) throw new Error('diagnostic read failed');
      return original(element);
    });
    debug.beginSessionOpening('test-session', 'click');
    debug.probeSessionOpeningReveal(scroller);
    const mutations = observer.takeRecords();
    observer.disconnect();
    expect(mutations).toEqual([]);
    expect([...document.body.childNodes]).toEqual(originalNodes);
    expect([...list.childNodes]).toEqual(originalChildren);
    expect(list.getAttribute('data-flowchat-opening')).toBe('true');
    expect(list.getAttribute('aria-hidden')).toBe('true');
    expect(list.getAttribute('data-open-viewport-settled')).toBe('false');
    const logs = vi.mocked(fetch).mock.calls.map(call => JSON.parse(call[1]!.body as string));
    expect(logs.some(row => row.msg === (fail
      ? 'reveal boundary measurement failed'
      : 'reveal boundary measured'))).toBe(true);
  });
});
