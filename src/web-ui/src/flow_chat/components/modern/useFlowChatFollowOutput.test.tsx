// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';

const diagnosticsMocks = vi.hoisted(() => ({ trace: vi.fn() }));

vi.mock('@/infrastructure/diagnostics/flowChatDiagnostics', () => ({
  flowChatDiagnostics: diagnosticsMocks,
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

type Controller = ReturnType<typeof useFlowChatFollowOutput>;

function setScrollerMetrics(
  scroller: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number; scrollTop: number },
) {
  Object.defineProperties(scroller, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
    scrollTop: { configurable: true, writable: true, value: metrics.scrollTop },
  });
}

function Harness({
  latestTurnId,
  isStreaming = true,
  scroller,
  scrollToTail,
  setFollowingDesired = vi.fn(),
  onController,
}: {
  latestTurnId: string;
  isStreaming?: boolean;
  scroller: HTMLElement;
  scrollToTail: (behavior: ScrollBehavior) => void;
  setFollowingDesired?: (following: boolean, reason: string) => void;
  onController: (controller: Controller) => void;
}) {
  const scrollerRef = React.useRef<HTMLElement | null>(scroller);
  const controller = useFlowChatFollowOutput({
    activeSessionId: 'session-1',
    latestTurnId,
    virtualItemCount: 2,
    isStreaming,
    isViewportActive: true,
    scrollerRef,
    scrollToTail,
    correctToTail: () => {
      scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      return true;
    },
    setFollowingDesired,
  });
  onController(controller);
  return <div data-following={String(controller.isFollowingOutput)} />;
}

describe('useFlowChatFollowOutput', () => {
  let container: HTMLDivElement;
  let root: Root;
  let scroller: HTMLDivElement;
  let controller: Controller | null;

  beforeEach(() => {
    container = document.createElement('div');
    scroller = document.createElement('div');
    document.body.append(container, scroller);
    root = createRoot(container);
    controller = null;
    diagnosticsMocks.trace.mockClear();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    scroller.remove();
    vi.unstubAllGlobals();
  });

  it('enters natural tail follow when a new Turn appears before streaming starts', () => {
    const scrollToTail = vi.fn();
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          isStreaming={false}
          scroller={scroller}
          scrollToTail={scrollToTail}
          onController={next => { controller = next; }}
        />,
      );
    });
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-2"
          isStreaming={false}
          scroller={scroller}
          scrollToTail={scrollToTail}
          onController={next => { controller = next; }}
        />,
      );
    });

    expect(scrollToTail).toHaveBeenCalledWith('auto');
    expect(controller?.isFollowingOutput).toBe(true);

    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-2"
          isStreaming
          scroller={scroller}
          scrollToTail={scrollToTail}
          onController={next => { controller = next; }}
        />,
      );
    });

    expect(controller?.isFollowingOutput).toBe(true);
  });

  it('lets explicit user scroll intent exit follow immediately', () => {
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          scrollToTail={vi.fn()}
          onController={next => { controller = next; }}
        />,
      );
    });
    act(() => controller?.enterFollowOutput('jump-to-latest'));
    expect(controller?.isFollowingOutput).toBe(true);

    act(() => controller?.handleUserScrollIntent());
    expect(controller?.isFollowingOutput).toBe(false);
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(diagnosticsMocks.trace).toHaveBeenCalledWith(expect.objectContaining({
      hypothesis: 'FOLLOW',
      message: 'Follow output ownership exited',
    }));
  });

  it('keeps following when layout growth moves the natural tail', () => {
    const frames: FrameRequestCallback[] = [];
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frames.push(callback);
      return frames.length;
    }));
    setScrollerMetrics(scroller, {
      scrollHeight: 1500,
      clientHeight: 500,
      scrollTop: 1000,
    });

    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          scrollToTail={vi.fn()}
          onController={next => { controller = next; }}
        />,
      );
    });
    expect(controller?.isFollowingOutput).toBe(true);

    setScrollerMetrics(scroller, {
      scrollHeight: 1800,
      clientHeight: 500,
      scrollTop: 1000,
    });
    act(() => controller?.handleScroll());
    expect(controller?.isFollowingOutput).toBe(true);

    const nextFrame = frames.shift();
    expect(nextFrame).toBeDefined();
    act(() => nextFrame?.(16));

    expect(scroller.scrollTop).toBe(1300);
    expect(controller?.isFollowingOutput).toBe(true);
    expect(diagnosticsMocks.trace).toHaveBeenCalledWith(expect.objectContaining({
      hypothesis: 'FOLLOW',
      message: 'Follow output corrected the natural tail',
    }));
  });

  it('uses smooth behavior only for an explicit jump to latest', () => {
    const scrollToTail = vi.fn();
    act(() => {
      root.render(
        <Harness
          latestTurnId="turn-1"
          scroller={scroller}
          scrollToTail={scrollToTail}
          onController={next => { controller = next; }}
        />,
      );
    });
    act(() => controller?.enterFollowOutput('jump-to-latest'));
    expect(scrollToTail).toHaveBeenCalledWith('smooth');
  });

  it('publishes follow intent separately from movement requests', () => {
    const setFollowingDesired = vi.fn();
    act(() => root.render(
      <Harness
        latestTurnId="turn-1"
        scroller={scroller}
        scrollToTail={vi.fn()}
        setFollowingDesired={setFollowingDesired}
        onController={next => { controller = next; }}
      />,
    ));
    expect(setFollowingDesired).toHaveBeenCalledWith(true, 'streaming-resumed');
    act(() => controller?.handleUserScrollIntent());
    expect(setFollowingDesired).toHaveBeenCalledWith(false, 'user-scroll');
  });
});
