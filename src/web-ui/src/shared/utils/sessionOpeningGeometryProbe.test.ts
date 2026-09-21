// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { installOpeningGeometryProbe } from './sessionOpeningGeometryProbe';

describe('temporary native geometry read probe', () => {
  let stop: ReturnType<typeof installOpeningGeometryProbe> | undefined;
  afterEach(() => { stop?.(); vi.restoreAllMocks(); });

  it('delegates reads and setters unchanged and restores original descriptors', () => {
    const element = document.createElement('div');
    const rect = new DOMRect(1, 2, 3, 4);
    const read = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(rect);
    const before = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect');
    const scroll = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop');
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    const report = vi.fn();
    stop = installOpeningGeometryProbe(report);
    element.scrollTop = 42;
    expect(element.scrollTop).toBe(42);
    expect(element.getBoundingClientRect()).toBe(rect);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.contexts[0]).toBe(element);
    expect(report).toHaveBeenCalledWith(element, expect.objectContaining({ api: 'getBoundingClientRect', durationMs: 10 }));
    stop();
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')).toEqual(before);
    expect(Object.getOwnPropertyDescriptor(Element.prototype, 'scrollTop')).toEqual(scroll);
  });

  it('preserves native failures even when diagnostic reporting fails', () => {
    const failure = new Error('native failure');
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => { throw failure; });
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    stop = installOpeningGeometryProbe(() => { throw new Error('report failure'); });
    expect(() => document.createElement('div').getBoundingClientRect()).toThrow(failure);
  });

  it('bounds stack samples while retaining aggregate counts', () => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect());
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 10));
    const report = vi.fn();
    stop = installOpeningGeometryProbe(report);
    const element = document.createElement('div');
    for (let n = 0; n < 20; n++) element.getBoundingClientRect();
    expect(report).toHaveBeenCalledTimes(12);
    expect(stop()).toMatchObject({ slowReads: 20, emitted: 12, reads: [
      { api: 'getBoundingClientRect', count: 20, totalMs: 200, maxMs: 10 },
    ] });
  });
});
