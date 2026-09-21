// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectOpeningLayoutContext } from './sessionOpeningLayoutContext';

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

describe('temporary opening layout inventory', () => {
  it('counts row content without recording text, identifiers or reading geometry', () => {
    document.body.innerHTML = `<div class="openbitfun-chat-pane__content"><div class="virtual-message-list__scroller">
      <div class="virtual-item-wrapper" data-virtual-index="27" data-turn-id="private-turn">
        <pre><code>private-code</code></pre><svg><path /></svg><table></table>
        <span data-overflow-behavior="marquee">private-label</span><div data-tool-card-id="private-tool"></div>
      </div><div class="virtual-item-wrapper" data-virtual-index="28"><img src="private-url" /></div>
    </div></div>`;
    const row = document.querySelector('.virtual-item-wrapper')!;
    const nativeRect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(() => { throw new Error('geometry read'); });
    const nativeHeight = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(() => { throw new Error('geometry read'); });
    const result = collectOpeningLayoutContext(row);
    expect(result).toMatchObject({ measuredRow: 27, scope: 'pane-or-chat', truncated: false, omittedRows: 0 });
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({ index: 27, pre: 1, code: 1, table: 1, svg: 1, svgParts: 1, toolCards: 1, overflowLabels: 1 });
    expect(result.rows[0].textChars).toBeGreaterThan(20);
    expect(result.rows[1]).toMatchObject({ index: 28, img: 1 });
    expect(result.ancestors.map(a => a.role)).toEqual(['row', 'scroller', 'inventory-root', 'body', 'ancestor']);
    expect(JSON.stringify(result)).not.toContain('private-');
    expect(nativeRect).not.toHaveBeenCalled();
    expect(nativeHeight).not.toHaveBeenCalled();
  });

  it('bounds traversal and reports partial counts', () => {
    const row = document.createElement('div');
    row.className = 'virtual-item-wrapper';
    for (let i = 0; i < 20; i++) row.appendChild(document.createElement('span'));
    document.body.appendChild(row);
    expect(collectOpeningLayoutContext(row, 5)).toMatchObject({
      visited: 5, truncated: true, totals: { elements: 5 }, rows: [{ index: null, elements: 5 }],
    });
  });

  it('bounds row records while retaining the pane totals', () => {
    const root = document.createElement('div');
    root.className = 'virtual-message-list__scroller';
    for (let i = 0; i < 30; i++) {
      const row = document.createElement('div');
      row.className = 'virtual-item-wrapper';
      row.dataset.virtualIndex = String(i);
      root.appendChild(row);
    }
    document.body.appendChild(root);
    const result = collectOpeningLayoutContext(root.firstElementChild!);
    expect(result).toMatchObject({ visited: 31, truncated: false, omittedRows: 6, totals: { elements: 31 } });
    expect(result.rows).toHaveLength(24);
  });
});
