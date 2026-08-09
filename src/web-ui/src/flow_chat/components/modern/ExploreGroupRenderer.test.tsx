// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ExploreGroupData } from '../../store/modernFlowChatStore';
import type { FlowItem, ModelRound } from '../../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../FlowTextBlock', () => ({
  FlowTextBlock: () => <div className="stub-text-block" />,
}));

vi.mock('../FlowToolCard', () => ({
  FlowToolCard: () => <div className="stub-tool-card" />,
}));

vi.mock('../../tool-cards/ModelThinkingDisplay', () => ({
  ModelThinkingDisplay: () => <div className="stub-thinking" />,
}));

vi.mock('./SmoothHeightCollapse', () => ({
  SmoothHeightCollapse: ({ isOpen, children }: { isOpen: boolean; children: React.ReactNode }) => (
    <div data-open={String(isOpen)}>{children}</div>
  ),
}));

import { ExploreGroupRenderer } from './ExploreGroupRenderer';
import { FlowChatContext, FlowChatVolatileContext } from './FlowChatContext';
import { FlowChatAutoCollapseContext } from './useFlowChatAutoCollapse';

// The coordinator accepts the request but never runs it, which is what happens
// while the group is still inside the viewport.
const deferredAutoCollapse = { isManaged: true, request: () => () => undefined };
// The card is already outside the viewport, so the request runs on arrival.
const immediateAutoCollapse = {
  isManaged: true,
  request: (_element: HTMLElement, collapse: () => void) => {
    collapse();
    return () => undefined;
  },
};

const textItem: FlowItem = {
  id: 'text-1',
  type: 'text',
  content: 'Read three files',
  isStreaming: false,
  isMarkdown: true,
  timestamp: 1,
  status: 'completed',
} as FlowItem;

function groupData(wasCutByCritical: boolean): ExploreGroupData {
  return {
    groupId: 'group-1',
    rounds: [] as unknown as ModelRound[],
    allItems: [textItem],
    stats: { readCount: 3, searchCount: 0, commandCount: 0 },
    isGroupStreaming: false,
    isLastGroupInTurn: !wasCutByCritical,
    wasCutByCritical,
  };
}

/**
 * Mirrors how the container owns explicit expand/collapse state: the renderer
 * reports user intent through the callbacks and reads it back from the map.
 */
function Harness({
  wasCutByCritical,
  autoCollapse,
}: {
  wasCutByCritical: boolean;
  autoCollapse: { isManaged: boolean; request: (el: HTMLElement, collapse: () => void) => () => void };
}) {
  const [states, setStates] = React.useState<Map<string, boolean>>(new Map());
  const callbacks = React.useMemo(() => ({
    onExploreGroupToggle: (groupId: string) => setStates(prev => (
      new Map(prev).set(groupId, !(prev.get(groupId) ?? false))
    )),
    onCollapseGroup: (groupId: string) => setStates(prev => new Map(prev).set(groupId, false)),
  }), []);

  return (
    <FlowChatAutoCollapseContext.Provider value={autoCollapse}>
      <FlowChatContext.Provider value={callbacks}>
        <FlowChatVolatileContext.Provider value={{ exploreGroupStates: states }}>
          <ExploreGroupRenderer data={groupData(wasCutByCritical)} turnId="turn-1" />
        </FlowChatVolatileContext.Provider>
      </FlowChatContext.Provider>
    </FlowChatAutoCollapseContext.Provider>
  );
}

describe('ExploreGroupRenderer', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const region = () => container.querySelector('[data-testid="chat-explore-group"]');
  const isExpanded = () => region()?.getAttribute('data-expanded') === 'true';
  const clickToggle = () => act(() => {
    container
      .querySelector<HTMLElement>('[data-testid="chat-explore-group-toggle"]')!
      .dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });

  it('stays open while the coordinator holds the collapse', () => {
    act(() => root.render(<Harness wasCutByCritical={false} autoCollapse={deferredAutoCollapse} />));
    expect(isExpanded()).toBe(true);

    act(() => root.render(<Harness wasCutByCritical autoCollapse={deferredAutoCollapse} />));
    expect(isExpanded()).toBe(true);
  });

  // The group has no inner scroll box, so nothing bounds its open height and
  // nothing has to be unbounded later. Its only two sizes are open and the
  // header row.
  it('renders the open group at its natural height', () => {
    act(() => root.render(<Harness wasCutByCritical={false} autoCollapse={deferredAutoCollapse} />));

    const content = container.querySelector('[data-testid="chat-explore-group-content"]');
    expect(content).not.toBeNull();
    expect(region()?.className).not.toMatch(/explore-region--(bounded|has-scroll|at-top|at-bottom)/);
  });

  it('collapses a cut group once the coordinator allows it', () => {
    act(() => root.render(<Harness wasCutByCritical={false} autoCollapse={immediateAutoCollapse} />));
    act(() => root.render(<Harness wasCutByCritical autoCollapse={immediateAutoCollapse} />));

    expect(isExpanded()).toBe(false);
  });

  it('mounts compact when the group is already cut', () => {
    act(() => root.render(<Harness wasCutByCritical autoCollapse={deferredAutoCollapse} />));

    expect(isExpanded()).toBe(false);
  });

  it('reopens on a user expand after the coordinator collapsed it', () => {
    act(() => root.render(<Harness wasCutByCritical={false} autoCollapse={immediateAutoCollapse} />));
    act(() => root.render(<Harness wasCutByCritical autoCollapse={immediateAutoCollapse} />));
    expect(isExpanded()).toBe(false);

    clickToggle();

    expect(isExpanded()).toBe(true);
  });

  it('lets the user collapse and reopen a group that is still growing', () => {
    act(() => root.render(<Harness wasCutByCritical={false} autoCollapse={deferredAutoCollapse} />));

    clickToggle();
    expect(isExpanded()).toBe(false);
    clickToggle();

    expect(isExpanded()).toBe(true);
  });
});
