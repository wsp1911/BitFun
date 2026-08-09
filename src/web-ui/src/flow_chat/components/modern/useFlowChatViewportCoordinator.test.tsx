// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatViewportCoordinator } from './useFlowChatViewportCoordinator';

const diagnosticsMocks = vi.hoisted(() => ({ trace: vi.fn() }));
vi.mock('@/infrastructure/diagnostics/flowChatDiagnostics', () => ({
  flowChatDiagnostics: diagnosticsMocks,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Coordinator = ReturnType<typeof useFlowChatViewportCoordinator>;

function Harness({
  scroller,
  isTurnPlacementPending = false,
  onReady,
}: {
  scroller: HTMLElement;
  isTurnPlacementPending?: boolean;
  onReady: (value: Coordinator) => void;
}) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  const virtuosoRef = React.useRef<any>({ scrollToIndex: vi.fn() });
  const coordinator = useFlowChatViewportCoordinator({
    activeSessionId: 'session-1',
    scrollerRef,
    virtuosoRef,
    getLastItemIndex: () => 4,
    isTurnPlacementPending,
  });
  onReady(coordinator);
  return null;
}

describe('useFlowChatViewportCoordinator', () => {
  let root: Root;
  let container: HTMLDivElement;
  let scroller: HTMLDivElement;
  let coordinator: Coordinator | null;

  beforeEach(() => {
    container = document.createElement('div');
    scroller = document.createElement('div');
    Object.defineProperties(scroller, {
      scrollHeight: { configurable: true, value: 1500 },
      clientHeight: { configurable: true, value: 500 },
      scrollTop: { configurable: true, writable: true, value: 300 },
    });
    scroller.scrollTo = vi.fn(({ top }: ScrollToOptions) => {
      if (typeof top === 'number') scroller.scrollTop = top;
    });
    root = createRoot(container);
    coordinator = null;
    act(() => root.render(<Harness scroller={scroller} onReady={value => { coordinator = value; }} />));
  });

  afterEach(() => root.unmount());

  it('blocks follow writes throughout placement and stage consumption', () => {
    coordinator?.setFollowingDesired(true, 'streaming');
    expect(coordinator?.getOwner()).toBe('following');
    expect(coordinator?.scrollToTail('following', 'auto')).toBe(true);

    coordinator?.beginTurnPlacement('new-turn');
    expect(coordinator?.scrollToTail('following', 'auto')).toBe(false);
    expect(coordinator?.beginStageConsumption('calibrated')).toBe(true);
    expect(coordinator?.scrollToTail('following', 'auto')).toBe(false);

    coordinator?.finishStageConsumption('exhausted');
    expect(coordinator?.getOwner()).toBe('following');
    expect(coordinator?.scrollToTail('following', 'auto')).toBe(true);
  });

  it('lets explicit navigation preempt placement and rejects stale placement writes', () => {
    coordinator?.beginTurnPlacement('new-turn');
    coordinator?.beginExplicitNavigation('turn-navigation');
    expect(coordinator?.adjustScrollTop('turn-placement', 100)).toBe(false);
    expect(coordinator?.setScrollTop('explicit-navigation', 800)).toBe(true);
    expect(scroller.scrollTop).toBe(800);
  });

  it('blocks follow in the render that first detects pending Turn placement', () => {
    coordinator?.setFollowingDesired(true, 'streaming');
    expect(coordinator?.scrollToTail('following', 'auto')).toBe(true);

    act(() => root.render(
      <Harness
        scroller={scroller}
        isTurnPlacementPending
        onReady={value => { coordinator = value; }}
      />,
    ));

    expect(coordinator?.getOwner()).toBe('following');
    expect(coordinator?.scrollToTail('following', 'auto')).toBe(false);
  });
});
