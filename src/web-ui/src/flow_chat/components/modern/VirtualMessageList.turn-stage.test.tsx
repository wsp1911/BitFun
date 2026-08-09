// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VirtualMessageList, type VirtualMessageListRef } from './VirtualMessageList';
import { useFlowChatAutoCollapse } from './useFlowChatAutoCollapse';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const BOTTOM_LAYOUT_INSET_PX = 168;
const CLIENT_HEIGHT_PX = 800;
const DEFAULT_NATURAL_CONTENT_PX = 1_200;

const mocks = vi.hoisted(() => ({
  items: [] as Array<Record<string, unknown>>,
  activeSession: null as Record<string, unknown> | null,
  isProcessing: false,
  scrollTopPx: 0,
  viewportOwner: 'idle' as string,
  enterFollowOutput: vi.fn(),
  exitFollowOutput: vi.fn(),
  collapse: vi.fn(),
  setVisibleTurnInfo: vi.fn(),
  scrollerElement: null as HTMLElement | null,
  coordinatorOptions: null as Record<string, unknown> | null,
}));

vi.mock('react-virtuoso', async () => {
  const ReactModule = await import('react');
  return {
    Virtuoso: ReactModule.forwardRef((props: Record<string, any>, ref) => {
      ReactModule.useImperativeHandle(ref, () => ({
        scrollToIndex: vi.fn(),
        scrollTo: vi.fn(),
      }));
      const scrollerRef = ReactModule.useRef<HTMLDivElement>(null);
      ReactModule.useLayoutEffect(() => {
        props.scrollerRef?.(scrollerRef.current);
        return () => props.scrollerRef?.(null);
      }, [props.scrollerRef]);
      const Footer = props.components?.Footer;
      const firstItemIndex = props.firstItemIndex ?? 0;
      return (
        <div ref={scrollerRef} data-virtuoso-scroller="true">
          {props.data.map((item: unknown, index: number) => (
            <ReactModule.Fragment key={index}>
              {props.itemContent(firstItemIndex + index, item)}
            </ReactModule.Fragment>
          ))}
          {Footer ? <Footer context={props.context} /> : null}
        </div>
      );
    }),
  };
});

vi.mock('../../store/modernFlowChatStore', () => {
  const useModernFlowChatStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) => selector({ visibleTurnInfo: null }),
    { getState: () => ({ setVisibleTurnInfo: mocks.setVisibleTurnInfo }) },
  );
  return {
    useVirtualItems: () => mocks.items,
    useActiveSession: () => mocks.activeSession,
    useModernFlowChatStore,
  };
});

vi.mock('../../hooks/useActiveSessionState', () => ({
  useActiveSessionState: () => ({ isProcessing: mocks.isProcessing }),
}));

vi.mock('../../store/chatInputStateStore', () => ({
  useChatInputState: (selector: (state: Record<string, unknown>) => unknown) => selector({
    isActive: false,
    isExpanded: false,
    inputHeight: 140,
  }),
}));

vi.mock('./useFlowChatFollowOutput', () => ({
  useFlowChatFollowOutput: () => ({
    isFollowingOutput: false,
    enterFollowOutput: mocks.enterFollowOutput,
    exitFollowOutput: mocks.exitFollowOutput,
    scheduleFollowToLatest: vi.fn(),
    handleUserScrollIntent: vi.fn(),
    handleScroll: vi.fn(),
  }),
}));

// Ownership drives the placement transaction's own step guard, so the double has
// to keep the real state machine's shape rather than answering a constant. Its
// identity has to be stable too: the real hook memoizes, and a fresh object per
// render would restart the placement effect on the commit it just made.
vi.mock('./useFlowChatViewportCoordinator', () => {
  const coordinator = {
    getOwner: () => mocks.viewportOwner,
    setFollowingDesired: vi.fn(),
    beginTurnPlacement: () => { mocks.viewportOwner = 'turn-placement'; },
    beginStageConsumption: () => { mocks.viewportOwner = 'stage-consuming'; return true; },
    finishStageConsumption: () => { mocks.viewportOwner = 'idle'; },
    beginExplicitNavigation: vi.fn(),
    handleUserIntent: vi.fn(),
    scrollToTail: vi.fn(() => true),
    scrollToIndex: vi.fn(() => true),
    setScrollTop: vi.fn(() => true),
    adjustScrollTop: vi.fn(() => true),
  };
  return {
    useFlowChatViewportCoordinator: (options: Record<string, unknown>) => {
      mocks.coordinatorOptions = options;
      return coordinator;
    },
  };
});

/**
 * Registers a collapse request and keeps its card rect intersecting the viewport,
 * so the coordinator's own evaluation can never grant it. Only an explicit flush
 * can collapse this card.
 */
function CollapseProbe() {
  const autoCollapse = useFlowChatAutoCollapse();
  const elementRef = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => {
    const element = elementRef.current;
    if (!element) return;
    element.getBoundingClientRect = () => ({
      top: 100, bottom: 200, left: 0, right: 0, width: 0, height: 100, x: 0, y: 100,
      toJSON: () => ({}),
    }) as DOMRect;
    return autoCollapse.request(element, mocks.collapse);
  }, [autoCollapse]);
  return <div ref={elementRef} data-testid="collapse-probe" />;
}

vi.mock('./VirtualItemRenderer', () => ({
  VirtualItemRenderer: ({ item, index }: { item: any; index: number }) => (
    <div
      className="virtual-item-wrapper"
      data-item-type={item.type}
      data-turn-id={item.turnId}
      data-virtual-index={index}
    >
      {item.data?.registersCollapse ? <CollapseProbe /> : item.turnId}
    </div>
  ),
}));

vi.mock('../../hooks/useScrollToTurnHeader', () => ({
  useScrollToTurnHeader: () => ({ shouldShowButton: false, handleClick: vi.fn() }),
}));

vi.mock('../../hooks/useVisibleTaskInfo', () => ({
  useVisibleTaskInfo: () => ({ visibleTaskInfo: null, scrollToTask: vi.fn() }),
}));

vi.mock('./RuntimeStatusSlot', () => ({ RuntimeStatusSlot: () => <div data-runtime-status /> }));
vi.mock('../ScrollToLatestBar', () => ({ ScrollToLatestBar: () => null }));
vi.mock('../ScrollToTurnHeaderButton', () => ({ ScrollToTurnHeaderButton: () => null }));
vi.mock('../StickyTaskIndicator', () => ({ StickyTaskIndicator: () => null }));

function userMessage(turnId: string, options?: { registersCollapse?: boolean }) {
  return {
    type: 'user-message',
    turnId,
    data: { id: `message-${turnId}`, ...options },
  };
}

describe('VirtualMessageList Turn stage reclamation', () => {
  let container: HTMLDivElement;
  let root: Root;
  let frames: Map<number, () => void>;
  let nextFrameHandle: number;
  let resizeObserverCallbacks: Array<() => void>;
  let naturalContentPx: number;

  // Real layout growth reaches the stage through the scroller's ResizeObserver.
  const notifyLayoutChange = () => {
    act(() => resizeObserverCallbacks.forEach(callback => callback()));
  };

  const footerHeightPx = () => {
    const footer = container.querySelector<HTMLElement>('.message-list-footer');
    return Number.parseInt(footer?.style.height ?? '0', 10);
  };
  const stageSpacePx = () => footerHeightPx() - BOTTOM_LAYOUT_INSET_PX;
  const runFrames = (count = 12) => {
    for (let index = 0; index < count; index += 1) {
      const pending = Array.from(frames.values());
      frames.clear();
      act(() => pending.forEach(frame => frame()));
    }
  };

  beforeEach(() => {
    frames = new Map();
    nextFrameHandle = 1;
    naturalContentPx = DEFAULT_NATURAL_CONTENT_PX;
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      const handle = nextFrameHandle;
      nextFrameHandle += 1;
      frames.set(handle, callback);
      return handle;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      frames.delete(handle);
    });
    resizeObserverCallbacks = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) {
        resizeObserverCallbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    });

    mocks.items = [userMessage('turn-1')];
    mocks.activeSession = { sessionId: 'session-1', dialogTurns: [] };
    mocks.isProcessing = false;
    mocks.scrollTopPx = 0;
    mocks.viewportOwner = 'idle';
    mocks.enterFollowOutput.mockReset();
    mocks.exitFollowOutput.mockReset();
    mocks.collapse.mockReset();
    mocks.setVisibleTurnInfo.mockReset();

    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  // jsdom does not lay out, so the scroller reports the geometry the Footer it
  // actually rendered implies: real transcript plus the current stage.
  const stubScrollerGeometry = () => {
    const scroller = container.querySelector<HTMLElement>('[data-virtuoso-scroller]');
    if (!scroller) throw new Error('scroller was not rendered');
    mocks.scrollerElement = scroller;
    Object.defineProperty(scroller, 'scrollHeight', {
      configurable: true,
      get: () => Math.max(CLIENT_HEIGHT_PX, naturalContentPx + footerHeightPx()),
    });
    Object.defineProperty(scroller, 'clientHeight', {
      configurable: true,
      get: () => CLIENT_HEIGHT_PX,
    });
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => mocks.scrollTopPx,
      set: (next: number) => { mocks.scrollTopPx = next; },
    });
    scroller.getBoundingClientRect = () => ({
      top: 0, bottom: CLIENT_HEIGHT_PX, left: 0, right: 0,
      width: 0, height: CLIENT_HEIGHT_PX, x: 0, y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  };

  /**
   * Mounts one Turn, then places a second one. Calibration keeps 600px of the
   * 800px provisional stage: at scrollTop 1168 the reader is 200px short of the
   * physical bottom, and that 200px is the part removing the stage could not
   * clamp.
   */
  const placeSecondTurn = (options?: {
    firstTurnRegistersCollapse?: boolean;
    scrollTopAtCalibration?: number;
  }) => {
    mocks.items = [userMessage('turn-1', {
      registersCollapse: options?.firstTurnRegistersCollapse,
    })];
    act(() => root.render(<VirtualMessageList />));
    stubScrollerGeometry();
    runFrames();

    mocks.items = [...mocks.items, userMessage('turn-2')];
    mocks.isProcessing = true;
    act(() => root.render(<VirtualMessageList />));
    // The provisional stage is committed one frame in; align from there.
    runFrames(1);
    mocks.scrollTopPx = options?.scrollTopAtCalibration ?? 1_168;
    runFrames();
  };

  it('calibrates a stage that outlives the placement transaction', () => {
    placeSecondTurn();
    expect(stageSpacePx()).toBe(600);
  });

  describe('at Turn completion', () => {
    it('reclaims only the stage past the viewport bottom', () => {
      placeSecondTurn();
      // 1968px of scroll content in an 800px viewport: the reader at 868 still
      // sees 300px of the 600px stage, and 300px sits below them.
      mocks.scrollTopPx = 868;

      mocks.isProcessing = false;
      act(() => root.render(<VirtualMessageList />));
      runFrames();

      expect(stageSpacePx()).toBe(300);
      // The reclaim landed exactly on the point where the reader is still at the
      // bottom of the scroll range, so nothing moved under them.
      expect(mocks.scrollTopPx).toBe(868);
      const scroller = mocks.scrollerElement as HTMLElement;
      expect(scroller.scrollHeight - CLIENT_HEIGHT_PX).toBe(868);
    });

    // Regression: a fresh session whose transcript is shorter than the viewport.
    // Only the stage makes the page scrollable, and reclaiming more than the
    // slack clamps scrollTop — the transcript visibly falls.
    it('never reclaims past the slack when the transcript is shorter than the viewport', () => {
      naturalContentPx = 300;
      placeSecondTurn({ scrollTopAtCalibration: 200 });
      const scroller = mocks.scrollerElement as HTMLElement;
      const stageBefore = stageSpacePx();
      const slackBefore = scroller.scrollHeight - CLIENT_HEIGHT_PX - mocks.scrollTopPx;
      expect(scroller.scrollHeight - stageBefore - CLIENT_HEIGHT_PX).toBeLessThan(0);

      mocks.isProcessing = false;
      act(() => root.render(<VirtualMessageList />));
      runFrames();

      expect(stageBefore - stageSpacePx()).toBe(slackBefore);
      expect(scroller.scrollHeight - CLIENT_HEIGHT_PX).toBeGreaterThanOrEqual(mocks.scrollTopPx);
    });

    it('reclaims nothing from a reader sitting at the physical bottom', () => {
      placeSecondTurn();
      // Every pixel of the stage is holding this viewport up.
      mocks.scrollTopPx = 1_168;

      mocks.isProcessing = false;
      act(() => root.render(<VirtualMessageList />));
      runFrames();

      expect(stageSpacePx()).toBe(600);
    });

    it('leaves later growth consuming the trimmed stage pixel for pixel', () => {
      placeSecondTurn();
      mocks.scrollTopPx = 868;
      mocks.isProcessing = false;
      act(() => root.render(<VirtualMessageList />));
      runFrames();
      expect(stageSpacePx()).toBe(300);

      // A follow-up round grows the transcript by 100px. The trim must not have
      // left the stage owing anything: growth still consumes one for one.
      naturalContentPx = DEFAULT_NATURAL_CONTENT_PX + 100;
      mocks.isProcessing = true;
      act(() => root.render(<VirtualMessageList />));
      notifyLayoutChange();
      runFrames();

      expect(stageSpacePx()).toBe(200);
    });
  });

  describe('on an explicit jump to the latest content', () => {
    it('drops the whole stage before entering follow', () => {
      const listRef = React.createRef<VirtualMessageListRef>();
      mocks.items = [userMessage('turn-1')];
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      stubScrollerGeometry();
      runFrames();
      mocks.items = [...mocks.items, userMessage('turn-2')];
      mocks.isProcessing = true;
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      runFrames(1);
      mocks.scrollTopPx = 1_168;
      runFrames();
      expect(stageSpacePx()).toBe(600);

      act(() => listRef.current?.scrollToLatestEndPosition());

      // The space goes in the click's own commit, and follow is only entered
      // afterwards so it aims at the tail that is left.
      expect(stageSpacePx()).toBe(0);
      expect(mocks.enterFollowOutput).not.toHaveBeenCalled();
      runFrames(1);
      expect(mocks.enterFollowOutput).toHaveBeenCalledWith('jump-to-latest');
    });

    it('releases the placement gate when the jump interrupts the transaction', () => {
      const listRef = React.createRef<VirtualMessageListRef>();
      mocks.items = [userMessage('turn-1')];
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      stubScrollerGeometry();
      runFrames();
      mocks.items = [...mocks.items, userMessage('turn-2')];
      mocks.isProcessing = true;
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      runFrames(1);
      expect(mocks.coordinatorOptions?.isTurnPlacementPending).toBe(true);

      // Placement never reaches calibration. The gate it raised suspends every
      // follow write, so the jump has to lower it in its own commit — follow is
      // entered on the very next frame, well before the abandoned transaction
      // gets around to releasing anything.
      act(() => listRef.current?.scrollToLatestEndPosition());

      expect(mocks.coordinatorOptions?.isTurnPlacementPending).toBe(false);
    });

    it('does not let a placement still waiting for its user message rebuild the stage', () => {
      const listRef = React.createRef<VirtualMessageListRef>();
      mocks.items = [userMessage('turn-1')];
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      stubScrollerGeometry();
      runFrames();

      // The new Turn exists but its user message has not been projected yet, so
      // placement sits in its retry loop with no stage to show for it.
      mocks.items = [...mocks.items, { type: 'assistant', turnId: 'turn-2', data: {} }];
      mocks.isProcessing = true;
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      runFrames(2);
      expect(stageSpacePx()).toBe(0);

      act(() => listRef.current?.scrollToLatestEndPosition());
      mocks.items = [mocks.items[0], userMessage('turn-2')];
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      // Exactly the frame the retry lands on. It re-enters createStage directly
      // rather than through the step guard, so only its own ownership check can
      // stop it from reinstating what the jump just dismissed — one frame of a
      // viewport-tall Footer is a visible flash, not a harmless intermediate.
      runFrames(1);

      expect(stageSpacePx()).toBe(0);
    });

    it('enters follow directly when there is no stage to drop', () => {
      const listRef = React.createRef<VirtualMessageListRef>();
      act(() => root.render(<VirtualMessageList ref={listRef} />));
      stubScrollerGeometry();
      runFrames();

      act(() => listRef.current?.scrollToLatestEndPosition());

      expect(mocks.enterFollowOutput).toHaveBeenCalledWith('jump-to-latest');
    });
  });

  describe('when a new Turn is placed', () => {
    it('runs collapses held over from earlier Turns inside the transaction', () => {
      placeSecondTurn({ firstTurnRegistersCollapse: true });

      // The card never left the viewport, so only the placement transaction —
      // which realigns from the geometry that results — could collapse it.
      expect(mocks.collapse).toHaveBeenCalledTimes(1);
    });

    it('leaves a held collapse alone while no Turn is being placed', () => {
      mocks.items = [userMessage('turn-1', { registersCollapse: true })];
      act(() => root.render(<VirtualMessageList />));
      stubScrollerGeometry();
      runFrames();

      expect(mocks.collapse).not.toHaveBeenCalled();
    });
  });
});
