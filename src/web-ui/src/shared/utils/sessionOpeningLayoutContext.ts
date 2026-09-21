// #region agent log
// Bounded DOM inventory after a slow native read. Counts describe the DOM, not
// the browser's actual layout invalidation set. Never collect text or identifiers.
function rowIndex(element: Element): number | null {
  const value = element.getAttribute('data-virtual-index');
  return value && /^\d{1,6}$/.test(value) ? Number(value) : null;
}

function counters() {
  return { elements: 0, textNodes: 0, textChars: 0, longestTextNode: 0,
    maxDepth: 0, svg: 0, svgParts: 0, pre: 0, code: 0, table: 0, img: 0,
    overflowLabels: 0, toolCards: 0 };
}

const layoutProperties = [
  'display', 'position', 'contain', 'content-visibility', 'container-type',
  'overflow-x', 'overflow-y', 'flex-direction', 'flex-wrap', 'flex-grow',
  'flex-shrink', 'align-items', 'align-self',
] as const;

export function collectOpeningLayoutContext(element: Element, nodeLimit = 8000) {
  const startedAt = performance.now();
  const row = element.closest('.virtual-item-wrapper');
  const scroller = element.closest('.virtual-message-list__scroller');
  const root = element.closest('.openbitfun-chat-pane__content')
    ?? element.closest('.modern-flowchat-container') ?? scroller ?? row ?? element;
  const totals = counters();
  const rows: Array<ReturnType<typeof counters> & { index: number | null }> = [];
  type Owner = { depth: number; row?: (typeof rows)[number] };
  const owners = new WeakMap<Node, Owner>();
  const walker = element.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  let node: Node | null = root;
  let visited = 0;
  let omittedRows = 0;
  while (node && visited < nodeLimit) {
    visited++;
    const parent = node === root ? undefined : owners.get(node.parentNode!);
    const owner: Owner = { depth: parent ? parent.depth + 1 : 0, row: parent?.row };
    if (node instanceof Element && node.classList.contains('virtual-item-wrapper')) {
      owner.row = undefined;
      if (rows.length < 24) {
        const count = { index: rowIndex(node), ...counters() };
        rows.push(count);
        owner.row = count;
      } else omittedRows++;
    }
    owners.set(node, owner);
    for (const count of owner.row ? [totals, owner.row] : [totals]) {
      count.maxDepth = Math.max(count.maxDepth, owner.depth);
      if (node instanceof Element) {
        count.elements++;
        const tag = node.tagName.toLowerCase();
        if (tag === 'svg' || tag === 'pre' || tag === 'code' || tag === 'table' || tag === 'img') count[tag]++;
        else if (node.namespaceURI === 'http://www.w3.org/2000/svg') count.svgParts++;
        if (node.hasAttribute('data-overflow-behavior')) count.overflowLabels++;
        if (node.hasAttribute('data-tool-card-id')) count.toolCards++;
      } else {
        const length = node.nodeValue?.length ?? 0;
        count.textNodes++;
        count.textChars += length;
        count.longestTextNode = Math.max(count.longestTextNode, length);
      }
    }
    node = walker.nextNode();
  }
  const inventoryMs = performance.now() - startedAt;
  const view = element.ownerDocument.defaultView;
  const ancestors = [];
  let ancestor: Element | null = row ?? element;
  const styleStartedAt = performance.now();
  while (ancestor && ancestors.length < 14) {
    // The native geometry read has already completed. Read only layout policy
    // properties, not resolved widths/heights, and account for this probe cost.
    const style = view?.getComputedStyle(ancestor);
    const policy = Object.fromEntries(layoutProperties.map(property => [property, style?.getPropertyValue(property) ?? '']));
    ancestors.push({
      level: ancestors.length, tag: ancestor.tagName.toLowerCase(),
      role: ancestor === row ? 'row' : ancestor === scroller ? 'scroller'
        : ancestor === root ? 'inventory-root' : ancestor === element.ownerDocument.body ? 'body' : 'ancestor',
      children: ancestor.childElementCount, ...policy,
    });
    ancestor = ancestor.parentElement;
  }
  return {
    measuredRow: row ? rowIndex(row) : null,
    scope: root === scroller ? 'scroller' : root === row ? 'row' : root === element ? 'element' : 'pane-or-chat',
    nodeLimit, visited, truncated: node !== null, totals, rows, omittedRows,
    ancestors, ancestorsTruncated: ancestor !== null,
    inventoryMs, styleProbeMs: performance.now() - styleStartedAt,
    probeMs: performance.now() - startedAt,
  };
}
// #endregion
