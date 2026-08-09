/**
 * Virtualized FlowChat transcript with natural browser scroll range.
 *
 * The list uses one bounded, monotonic Turn stage budget for the initial
 * placement of a new live Turn. All later geometry remains natural.
 */

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  Virtuoso,
  type Components,
  type ContextProp,
  type ListRange,
  type VirtuosoHandle,
} from 'react-virtuoso';
import { Loader2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useActiveSessionState } from '../../hooks/useActiveSessionState';
import { useScrollToTurnHeader } from '../../hooks/useScrollToTurnHeader';
import { useVisibleTaskInfo } from '../../hooks/useVisibleTaskInfo';
import type { SessionHistoryWindowDirection } from '../../store/FlowChatStore';
import {
  useActiveSession,
  useModernFlowChatStore,
  useVirtualItems,
  type VirtualItem,
} from '../../store/modernFlowChatStore';
import { useChatInputState } from '../../store/chatInputStateStore';
import type { ActiveTurnRenderRange } from '../../types/flow-chat';
import { computeFlowChatInputStackFooterPx } from '../../utils/flowChatScrollLayout';
import { ScrollToLatestBar } from '../ScrollToLatestBar';
import { ScrollToTurnHeaderButton } from '../ScrollToTurnHeaderButton';
import {
  findElementWithDataValue,
  findFlowChatSearchTextRanges,
  getFlowChatSearchTextRoot,
  setFlowChatSearchHighlight,
} from './flowChatSearchDom';
import { RuntimeStatusSlot } from './RuntimeStatusSlot';
import { StickyTaskIndicator } from '../StickyTaskIndicator';
import { useFlowChatFollowOutput } from './useFlowChatFollowOutput';
import { useFlowChatViewportCoordinator } from './useFlowChatViewportCoordinator';
import {
  FlowChatAutoCollapseProvider,
  type FlowChatAutoCollapseController,
} from './FlowChatAutoCollapseContext';
import {
  calibrateFlowChatTurnStage,
  consumeFlowChatTurnStage,
  createProvisionalFlowChatTurnStage,
  getFlowChatTurnStageRemainingBucket,
  measureVisibleFlowChatTurnStagePx,
  trimFlowChatTurnStage,
  type FlowChatTurnStageState,
} from './flowChatTurnStage';
import { flowChatDiagnostics } from '@/infrastructure/diagnostics/flowChatDiagnostics';
import { measureFlowChatTurnAnchorGeometry } from './flowChatViewportDiagnostics';
import { VirtualItemRenderer } from './VirtualItemRenderer';
import { getLeadingVirtualItemIndexDelta } from './virtualMessageListLayout';
import { resolveVisibleFlowChatTurnIds } from './flowChatVisibleTurns';
import './VirtualMessageList.scss';

const VIRTUOSO_FIRST_ITEM_INDEX_BASE = 1_000_000;
const SEARCH_NAVIGATION_MAX_ATTEMPTS = 24;
/** Sub-pixel residue not worth another scroll write during Turn placement. */
const TURN_PLACEMENT_ALIGNMENT_EPSILON_PX = 0.5;
/** Above this the new Turn is visibly detached from the header: a failure. */
const TURN_PLACEMENT_MAX_SETTLED_OFFSET_PX = 4;
/** Below this a backwards scroll is sub-pixel residue, not the viewport falling. */
const VIEWPORT_FALL_EPSILON_PX = 1;
/** A backwards scroll this soon after a wheel, touch or key is the reader's. */
const USER_SCROLL_INTENT_GRACE_MS = 700;
const FLOW_CHAT_VIRTUOSO_OVERSCAN = { main: 600, reverse: 600 } as const;
const FLOW_CHAT_VIRTUOSO_VIEWPORT_INCREASE = { top: 600, bottom: 600 } as const;
const IDLE_HISTORY_WINDOW_BOUNDARY_STATE: Record<
  SessionHistoryWindowDirection,
  'idle' | 'loading' | 'error'
> = { before: 'idle', after: 'idle' };

/** What a fall is measured against; see `sampleStageGeometry`. */
interface StageGeometrySample {
  scrollTopPx: number;
  scrollHeightPx: number;
  remainingPx: number;
}

export type FlowChatTurnNavigationStatus = 'rejected' | 'pending' | 'settled';

export interface TurnNavigationOptions {
  behavior?: ScrollBehavior;
}

export type HistoryWindowBoundaryIntentResult =
  | 'applied'
  | 'exhausted'
  | 'not-ready'
  | 'cancelled';

type HistoryWindowBoundaryIntentResponse =
  | HistoryWindowBoundaryIntentResult
  | boolean
  | void;

export interface HistoryWindowBoundaryIntentOptions {
  prepareViewportForPresentationCommit?: () => boolean | void | Promise<boolean | void>;
  cancelViewportPresentationCommit?: () => void;
}

export interface VirtualMessageListRef {
  scrollToTurn: (turnIndex: number) => void;
  scrollToIndex: (index: number) => void;
  scrollFlowItemIntoView: (itemId: string) => boolean;
  scrollToSearchMatch: (target: {
    virtualItemIndex: number;
    query: string;
    flowItemId?: string;
    occurrenceIndex?: number;
    expandableIds?: readonly string[];
  }) => void;
  clearSearchMatch: () => void;
  scrollToPhysicalBottom: () => void;
  scrollToTurnEnd: (turnId: string) => boolean;
  isTurnRenderedInViewport: (turnId: string) => boolean;
  isTurnTextRenderedInViewport: (turnId: string) => boolean;
  scrollToLatestEndPosition: () => void;
  navigateToTurn: (turnId: string, options?: TurnNavigationOptions) => boolean;
  navigateToTurnWithStatus: (
    turnId: string,
    options?: TurnNavigationOptions,
  ) => FlowChatTurnNavigationStatus;
  prepareTurnNavigation: (
    turnId: string,
    options?: TurnNavigationOptions,
  ) => FlowChatTurnNavigationStatus;
}

export interface VirtualMessageListProps {
  items?: VirtualItem[];
  isViewportActive?: boolean;
  presentationMode?: 'tail' | 'history-window';
  viewportMode?: 'live-tail' | 'history-reading';
  historyWindow?: ActiveTurnRenderRange | null;
  presentationRevision?: number;
  historyBoundaryState?: Record<SessionHistoryWindowDirection, 'idle' | 'loading' | 'error'>;
  onHistoryWindowBoundaryIntent?: (
    direction: SessionHistoryWindowDirection,
    options?: HistoryWindowBoundaryIntentOptions,
  ) => HistoryWindowBoundaryIntentResponse | Promise<HistoryWindowBoundaryIntentResponse>;
  onRequestJumpToLatest?: () => void;
  onUserScrollIntent?: () => void;
}

type FlowChatVirtuosoContext = {
  bottomLayoutInsetPx: number;
  stageSpacePx: number;
  previousHistoryBoundaryStatusNode: React.ReactNode;
  nextHistoryBoundaryStatusNode: React.ReactNode;
  runtimeStatusSessionId: string | null;
};

type PreparedTurnNavigation = {
  turnId: string;
  behavior: ScrollBehavior;
};

type HistoryPrependAnchor = {
  turnId: string;
  offsetFromScrollerTop: number;
};

const FlowChatVirtuosoHeader = ({ context }: ContextProp<FlowChatVirtuosoContext>) => (
  <>{context.previousHistoryBoundaryStatusNode}</>
);

const FlowChatVirtuosoFooter = ({ context }: ContextProp<FlowChatVirtuosoContext>) => (
  <div
    className="message-list-footer"
    data-bf-component="virtual-message-list"
    data-bf-part="footer"
    style={{
      height: `${context.bottomLayoutInsetPx + context.stageSpacePx}px`,
      minHeight: `${context.bottomLayoutInsetPx + context.stageSpacePx}px`,
    }}
  >
    {context.nextHistoryBoundaryStatusNode}
    <RuntimeStatusSlot sessionId={context.runtimeStatusSessionId} placement="footer" />
  </div>
);

const FLOW_CHAT_VIRTUOSO_COMPONENTS: Components<VirtualItem, FlowChatVirtuosoContext> = {
  Header: FlowChatVirtuosoHeader,
  Footer: FlowChatVirtuosoFooter,
};

const FlowChatHistoryPagingSentinel = ({
  state,
  label,
}: {
  state: 'idle' | 'loading' | 'error';
  label: string;
}) => (
  <div
    className="virtual-message-list__history-paging-sentinel"
    data-history-paging-sentinel={state}
    data-history-boundary-status={state === 'loading' ? 'preparing' : state === 'error' ? 'not-ready' : undefined}
    aria-hidden={state === 'idle'}
    role={state === 'idle' ? undefined : 'status'}
    aria-live={state === 'idle' ? undefined : 'polite'}
  >
    {state === 'loading' ? (
      <Loader2 size={14} aria-hidden className="virtual-message-list__history-paging-spinner" />
    ) : null}
    <span>{label}</span>
  </div>
);

function normalizeBoundaryResult(
  result: HistoryWindowBoundaryIntentResponse,
): HistoryWindowBoundaryIntentResult {
  if (result === true) return 'applied';
  if (result === false || result === undefined) return 'not-ready';
  return result;
}

function normalizeVirtuosoBehavior(behavior: ScrollBehavior): 'auto' | 'smooth' {
  return behavior === 'smooth' ? 'smooth' : 'auto';
}

function getVirtualItemStableKey(item: VirtualItem): string {
  switch (item.type) {
    case 'user-message':
    case 'user-steering-message':
      return `${item.type}:${item.turnId}:${item.data.id}`;
    case 'model-round':
      return `${item.type}:${item.turnId}:${item.data.id}`;
    case 'explore-group':
      return `${item.type}:${item.turnId}:${item.data.groupId}`;
    case 'turn-completion-notice':
      return `${item.type}:${item.turnId}:${item.data.reasonCode}`;
    case 'turn-failure-notice':
    case 'image-analyzing':
      return `${item.type}:${item.turnId}`;
  }
}

function isElementVisibleInScroller(element: HTMLElement, scroller: HTMLElement): boolean {
  const elementRect = element.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  return elementRect.bottom > scrollerRect.top && elementRect.top < scrollerRect.bottom;
}

const VirtualMessageListSession = forwardRef<VirtualMessageListRef, VirtualMessageListProps>(({
  items,
  isViewportActive = true,
  presentationMode = 'tail',
  viewportMode = presentationMode === 'history-window' ? 'history-reading' : 'live-tail',
  historyWindow: _historyWindow = null,
  presentationRevision: _presentationRevision = 0,
  historyBoundaryState = IDLE_HISTORY_WINDOW_BOUNDARY_STATE,
  onHistoryWindowBoundaryIntent,
  onRequestJumpToLatest,
  onUserScrollIntent,
}, ref) => {
  const { t } = useTranslation('flow-chat');
  const canonicalVirtualItems = useVirtualItems();
  const virtualItems = items ?? canonicalVirtualItems;
  const activeSession = useActiveSession();
  const activeSessionState = useActiveSessionState();
  const activeSessionId = activeSession?.sessionId ?? null;
  const latestTurnId = virtualItems.at(-1)?.turnId ?? null;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [turnStage, setTurnStage] = useState<FlowChatTurnStageState | null>(null);
  const [isTurnStageCalibrating, setIsTurnStageCalibrating] = useState(false);
  const turnStageRef = useRef<FlowChatTurnStageState | null>(null);
  const virtualItemsRef = useRef(virtualItems);
  const stageRemainingBucketRef = useRef<number | null>(null);
  const previousStageTurnIdRef = useRef(latestTurnId);
  const previousStageSessionIdRef = useRef(activeSessionId);
  const preparedTurnNavigationRef = useRef<PreparedTurnNavigation | null>(null);
  const historyPrependAnchorRef = useRef<HistoryPrependAnchor | null>(null);
  const boundaryRequestRef = useRef<Record<SessionHistoryWindowDirection, Promise<void> | null>>({
    before: null,
    after: null,
  });
  const exhaustedBoundaryRef = useRef<Record<SessionHistoryWindowDirection, boolean>>({
    before: false,
    after: false,
  });
  const searchNavigationRequestIdRef = useRef(0);
  const visibleTurnUpdateFrameRef = useRef<number | null>(null);
  const stageMilestoneSettlementFrameRef = useRef<number | null>(null);
  const turnStageUpdateFrameRef = useRef<number | null>(null);
  const pendingStageTrimReasonRef = useRef<string | null>(null);
  const stageGeometrySampleRef = useRef<StageGeometrySample | null>(null);
  const lastScrollTopRef = useRef<number | null>(null);
  const lastUserScrollIntentAtRef = useRef(Number.NEGATIVE_INFINITY);
  const jumpToLatestFrameRef = useRef<number | null>(null);
  const autoCollapseControllerRef = useRef<FlowChatAutoCollapseController | null>(null);
  const resumeFollowAfterStageRef = useRef<() => void>(() => {});

  const virtuosoIndexStateRef = useRef({
    sessionId: activeSessionId,
    firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_BASE,
    virtualItems,
  });
  const virtuosoIndexState = virtuosoIndexStateRef.current;
  if (virtuosoIndexState.sessionId !== activeSessionId) {
    virtuosoIndexState.sessionId = activeSessionId;
    virtuosoIndexState.firstItemIndex = VIRTUOSO_FIRST_ITEM_INDEX_BASE;
    virtuosoIndexState.virtualItems = virtualItems;
  } else if (virtuosoIndexState.virtualItems !== virtualItems) {
    virtuosoIndexState.firstItemIndex = Math.max(
      0,
      virtuosoIndexState.firstItemIndex + getLeadingVirtualItemIndexDelta(
        virtuosoIndexState.virtualItems,
        virtualItems,
        getVirtualItemStableKey,
      ),
    );
    virtuosoIndexState.virtualItems = virtualItems;
  }
  const virtuosoFirstItemIndex = virtuosoIndexState.firstItemIndex;

  const userMessageItems = useMemo(() => virtualItems
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.type === 'user-message'), [virtualItems]);

  const isStreamingOutput = useMemo(() => {
    if (viewportMode === 'history-reading') return false;
    if (activeSessionState.isProcessing) return true;
    const latestTurn = activeSession?.dialogTurns.at(-1);
    return Boolean(
      latestTurn && (
        latestTurn.status === 'processing' ||
        latestTurn.status === 'finishing' ||
        latestTurn.status === 'image_analyzing' ||
        latestTurn.modelRounds.some(round => round.isStreaming)
      )
    );
  }, [activeSession, activeSessionState.isProcessing, viewportMode]);

  const isInputActive = useChatInputState(state => state.isActive);
  const isInputExpanded = useChatInputState(state => state.isExpanded);
  const inputHeight = useChatInputState(state => state.inputHeight);
  const bottomLayoutInsetPx = computeFlowChatInputStackFooterPx(inputHeight);
  turnStageRef.current = turnStage;
  virtualItemsRef.current = virtualItems;

  const hasPendingTurnStageCalibration = Boolean(
    presentationMode === 'tail'
    && viewportMode === 'live-tail'
    && latestTurnId
    && latestTurnId !== previousStageTurnIdRef.current
    && virtualItems.length > 0,
  );
  const getLastVirtualItemIndex = useCallback(
    () => Math.max(0, virtualItemsRef.current.length - 1),
    [],
  );

  const viewportCoordinator = useFlowChatViewportCoordinator({
    activeSessionId,
    scrollerRef: scrollerElementRef,
    virtuosoRef,
    getLastItemIndex: getLastVirtualItemIndex,
    isTurnPlacementPending: hasPendingTurnStageCalibration,
  });

  /** The reference `updateTurnStage` leaves behind for the fall tripwire. */
  const sampleStageGeometry = useCallback((scroller: HTMLElement) => {
    if (!flowChatDiagnostics.isEnabled()) return;
    const stage = turnStageRef.current;
    stageGeometrySampleRef.current = {
      scrollTopPx: scroller.scrollTop,
      scrollHeightPx: scroller.scrollHeight,
      remainingPx: stage?.remainingPx ?? 0,
    };
  }, []);

  /**
   * Nothing in this module writes the viewport backwards, so a fall is by
   * definition something nobody asked for — almost always the browser clamping
   * `scrollTop` after total height dipped below it. The reader is the only other
   * candidate, and their wheel, touch or key lands here first, so a recent
   * intent is what disqualifies a record rather than the current owner: falls
   * happen while idle too, and gating on ownership hid them.
   *
   * Landing exactly on the bottom of the range is *not* used as the test. The
   * dip can recover inside the same layout pass, and scroll events are dispatched
   * at the start of the following frame, so by then the range is often already
   * taller than where the reader was left. That distinction is recorded as data
   * instead.
   *
   * Known blind spot: falls smaller than the reader ever notices have been seen
   * without a record landing here. Absence of records is not proof the viewport
   * held still. Splitting the drop into `stageDeltaPx` and `naturalExtentDeltaPx`
   * is what makes a record actionable; attributing it further needs per-element
   * measurement, which is too costly to leave running.
   */
  const reportViewportFall = useCallback((scroller: HTMLElement) => {
    const previousScrollTopPx = lastScrollTopRef.current;
    lastScrollTopRef.current = scroller.scrollTop;
    const previous = stageGeometrySampleRef.current;
    if (!flowChatDiagnostics.isEnabled() || !previous || previousScrollTopPx === null) return;
    const fellByPx = previousScrollTopPx - scroller.scrollTop;
    if (fellByPx <= VIEWPORT_FALL_EPSILON_PX) return;
    const owner = viewportCoordinator.getOwner();
    const sinceUserScrollIntentMs = performance.now() - lastUserScrollIntentAtRef.current;
    if (sinceUserScrollIntentMs < USER_SCROLL_INTENT_GRACE_MS) return;

    const maxScrollTopPx = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
    const stage = turnStageRef.current;
    flowChatDiagnostics.trace({
      hypothesis: 'STAGE',
      location: 'VirtualMessageList.handleNativeScroll',
      message: 'Viewport fell while the coordinator was not writing it',
      data: () => ({
        sessionId: activeSessionId,
        turnId: stage?.turnId ?? null,
        fellByPx,
        scrollTopBefore: previousScrollTopPx,
        scrollTopAfter: scroller.scrollTop,
        maxScrollTopPx,
        // Zero means the dip was still present when this event was dispatched;
        // positive means it had already recovered and only the fall remains.
        slackAfterFallPx: maxScrollTopPx - scroller.scrollTop,
        slackBeforeFallPx: (previous.scrollHeightPx - scroller.clientHeight) - previousScrollTopPx,
        sinceUserScrollIntentMs,
        scrollHeightBefore: previous.scrollHeightPx,
        scrollHeightAfter: scroller.scrollHeight,
        scrollHeightDeltaPx: scroller.scrollHeight - previous.scrollHeightPx,
        stageRemainingBefore: previous.remainingPx,
        stageRemainingAfter: stage?.remainingPx ?? null,
        // Splits the dip into the part the stage gave up and the part the
        // transcript itself lost.
        stageDeltaPx: (stage?.remainingPx ?? 0) - previous.remainingPx,
        naturalExtentDeltaPx: (scroller.scrollHeight - (stage?.remainingPx ?? 0))
          - (previous.scrollHeightPx - previous.remainingPx),
        maxNaturalExtentPx: stage?.isCalibrated ? stage.maxNaturalExtentPx : null,
        viewportOwner: owner,
      }),
    });
  }, [activeSessionId, viewportCoordinator]);

  const updateTurnStage = useCallback(() => {
    const trimReason = pendingStageTrimReasonRef.current;
    pendingStageTrimReasonRef.current = null;
    const scroller = scrollerElementRef.current;
    const stage = turnStageRef.current;
    // Ownership lives outside React rendering, so it stays accurate even when a
    // layout callback lands between the placement transaction's own renders.
    if (!scroller || !stage || viewportCoordinator.getOwner() === 'turn-placement') return;
    if (!stage.isCalibrated) return;
    sampleStageGeometry(scroller);
    const consumed = consumeFlowChatTurnStage(
      stage,
      scroller.scrollHeight,
      bottomLayoutInsetPx,
    );
    // Consumption and trimming are one writer sharing one DOM read. Splitting
    // them would let the second measure a scroll height the first has already
    // committed against but the browser has not laid out yet, and count the
    // same pixels twice.
    //
    // The trim is measured against `stage`, whose `remainingPx` is what the
    // Footer currently lays out, so it stays independent of the consumption
    // committed alongside it.
    const next = trimReason
      ? trimFlowChatTurnStage(consumed, measureVisibleFlowChatTurnStagePx(stage, {
        scrollTopPx: scroller.scrollTop,
        scrollHeightPx: scroller.scrollHeight,
        clientHeightPx: scroller.clientHeight,
      }))
      : consumed;
    if (next !== stage) {
      turnStageRef.current = next;
      setTurnStage(next);
      if (next !== consumed) {
        flowChatDiagnostics.trace({
          hypothesis: 'STAGE',
          location: 'VirtualMessageList.updateTurnStage',
          message: 'Turn stage trimmed to the part the viewport still reaches',
          data: () => ({
            sessionId: activeSessionId,
            turnId: next.turnId,
            reason: trimReason,
            laidOutRemainingPx: stage.remainingPx,
            consumedRemainingPx: consumed.remainingPx,
            trimmedRemainingPx: next.remainingPx,
            reclaimedPx: consumed.remainingPx - next.remainingPx,
            scrollTop: scroller.scrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
            bottomLayoutInsetPx,
          }),
        });
      }
      const previousBucket = stageRemainingBucketRef.current;
      const nextBucket = getFlowChatTurnStageRemainingBucket(next);
      if (previousBucket !== nextBucket) {
        stageRemainingBucketRef.current = nextBucket;
        const anchorGeometryBeforeCommit = measureFlowChatTurnAnchorGeometry(
          scroller,
          next.turnId,
        );
        flowChatDiagnostics.trace({
          hypothesis: 'STAGE',
          location: 'VirtualMessageList.updateTurnStage',
          message: nextBucket === 0
            ? 'Turn stage exhausted'
            : 'Turn stage consumption crossed a milestone',
          data: () => ({
            sessionId: activeSessionId,
            turnId: next.turnId,
            previousBucket,
            nextBucket,
            initialPx: next.initialPx,
            remainingPx: next.remainingPx,
            consumedPx: next.initialPx - next.remainingPx,
            baselineNaturalExtentPx: next.baselineNaturalExtentPx,
            maxNaturalExtentPx: next.maxNaturalExtentPx,
            anchorGeometryBeforeCommit,
            bottomLayoutInsetPx,
          }),
        });
        if (stageMilestoneSettlementFrameRef.current !== null) {
          cancelAnimationFrame(stageMilestoneSettlementFrameRef.current);
        }
        stageMilestoneSettlementFrameRef.current = requestAnimationFrame(() => {
          stageMilestoneSettlementFrameRef.current = requestAnimationFrame(() => {
            stageMilestoneSettlementFrameRef.current = null;
            const settledScroller = scrollerElementRef.current;
            if (!settledScroller) return;
            const settledStage = turnStageRef.current;
            const anchorGeometryAfterSettlement = measureFlowChatTurnAnchorGeometry(
              settledScroller,
              next.turnId,
            );
            flowChatDiagnostics.trace({
              hypothesis: 'STAGE',
              location: 'VirtualMessageList.updateTurnStage',
              message: 'Turn stage consumption milestone settled',
              data: () => ({
                sessionId: activeSessionId,
                turnId: next.turnId,
                previousBucket,
                nextBucket,
                previousRemainingPx: stage.remainingPx,
                requestedRemainingPx: next.remainingPx,
                settledRemainingPx: settledStage?.turnId === next.turnId
                  ? settledStage.remainingPx
                  : null,
                viewportOwner: viewportCoordinator.getOwner(),
                anchorGeometryBeforeCommit,
                anchorGeometryAfterSettlement,
                anchorOffsetDeltaPx:
                  anchorGeometryBeforeCommit.userMessageOffsetFromViewportTop !== null
                  && anchorGeometryAfterSettlement.userMessageOffsetFromViewportTop !== null
                    ? anchorGeometryAfterSettlement.userMessageOffsetFromViewportTop
                      - anchorGeometryBeforeCommit.userMessageOffsetFromViewportTop
                    : null,
                scrollTopDeltaPx:
                  anchorGeometryAfterSettlement.scrollTop
                  - anchorGeometryBeforeCommit.scrollTop,
                scrollHeightDeltaPx:
                  anchorGeometryAfterSettlement.scrollHeight
                  - anchorGeometryBeforeCommit.scrollHeight,
              }),
            });
          });
        });
      }
      if (next.remainingPx <= 0) {
        requestAnimationFrame(() => {
          if (turnStageRef.current?.turnId === next.turnId && turnStageRef.current.remainingPx <= 0) {
            viewportCoordinator.finishStageConsumption('stage-exhausted-after-footer-commit');
            resumeFollowAfterStageRef.current();
          }
        });
      }
    }
  }, [activeSessionId, bottomLayoutInsetPx, sampleStageGeometry, viewportCoordinator]);

  // Consumption changes the Footer height, which the same ResizeObserver would
  // observe again. Coalescing to one frame keeps that out of the observer's own
  // delivery, like the other two jobs sharing the callback.
  const scheduleTurnStageUpdate = useCallback(() => {
    if (turnStageUpdateFrameRef.current !== null) return;
    turnStageUpdateFrameRef.current = requestAnimationFrame(() => {
      turnStageUpdateFrameRef.current = null;
      updateTurnStage();
    });
  }, [updateTurnStage]);

  const requestTurnStageTrim = useCallback((reason: string) => {
    pendingStageTrimReasonRef.current = reason;
    scheduleTurnStageUpdate();
  }, [scheduleTurnStageUpdate]);

  // A finished Turn is the moment to hand back stage space the transcript never
  // grew into. Only the part past the viewport bottom goes: it is invisible, so
  // removing it cannot clamp `scrollTop`. Reclaiming the part still on screen
  // would drop content under a reader who did nothing, which is the shrink no
  // reserve can repay — and the space that stays is exactly the reserve doing
  // its job for a short answer.
  const wasStreamingOutputRef = useRef(isStreamingOutput);
  useEffect(() => {
    const wasStreamingOutput = wasStreamingOutputRef.current;
    wasStreamingOutputRef.current = isStreamingOutput;
    if (!wasStreamingOutput || isStreamingOutput) return;
    requestTurnStageTrim('turn-completed');
  }, [isStreamingOutput, requestTurnStageTrim]);

  useEffect(() => () => {
    if (stageMilestoneSettlementFrameRef.current !== null) {
      cancelAnimationFrame(stageMilestoneSettlementFrameRef.current);
    }
    if (turnStageUpdateFrameRef.current !== null) {
      cancelAnimationFrame(turnStageUpdateFrameRef.current);
    }
    if (jumpToLatestFrameRef.current !== null) {
      cancelAnimationFrame(jumpToLatestFrameRef.current);
    }
  }, []);

  const scrollToTail = useCallback((behavior: ScrollBehavior) => {
    viewportCoordinator.scrollToTail('following', behavior);
  }, [viewportCoordinator]);
  const correctToTail = useCallback(() => (
    viewportCoordinator.scrollToTail('following', 'auto')
  ), [viewportCoordinator]);

  const {
    isFollowingOutput,
    enterFollowOutput,
    exitFollowOutput,
    scheduleFollowToLatest,
    handleUserScrollIntent,
    handleScroll,
  } = useFlowChatFollowOutput({
    activeSessionId: activeSessionId ?? undefined,
    latestTurnId,
    virtualItemCount: virtualItems.length,
    isStreaming: isStreamingOutput,
    isViewportActive,
    scrollerRef: scrollerElementRef,
    scrollToTail,
    correctToTail,
    setFollowingDesired: viewportCoordinator.setFollowingDesired,
  });
  resumeFollowAfterStageRef.current = scheduleFollowToLatest;

  const notifyUserScrollIntent = useCallback(() => {
    lastUserScrollIntentAtRef.current = performance.now();
    viewportCoordinator.handleUserIntent('user-scroll');
    handleUserScrollIntent();
    onUserScrollIntent?.();
  }, [handleUserScrollIntent, onUserScrollIntent, viewportCoordinator]);

  const updateVisibleTurnInfoFromViewport = useCallback(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    const scrollerRect = scroller.getBoundingClientRect();
    const viewportEntries = Array.from(
      scroller.querySelectorAll<HTMLElement>('.virtual-item-wrapper[data-turn-id]'),
    ).map(element => {
      const rect = element.getBoundingClientRect();
      return {
        turnId: element.dataset.turnId ?? null,
        itemType: element.dataset.itemType ?? null,
        top: rect.top,
        bottom: rect.bottom,
      };
    });
    const visibleTurnIds = resolveVisibleFlowChatTurnIds(
      viewportEntries,
      scrollerRect.top,
      scrollerRect.bottom,
    );
    const currentTurnId = visibleTurnIds[0] ?? null;
    const currentTurn = currentTurnId
      ? userMessageItems.find(({ item }) => item.turnId === currentTurnId)
      : undefined;
    const store = useModernFlowChatStore.getState();

    if (!currentTurn || currentTurn.item.type !== 'user-message') {
      if (store.visibleTurnInfo !== null) store.setVisibleTurnInfo(null);
      return;
    }

    const nextVisibleTurnInfo = {
      turnIndex: userMessageItems.indexOf(currentTurn) + 1,
      totalTurns: userMessageItems.length,
      userMessage: currentTurn.item.data.content ?? '',
      turnId: currentTurn.item.turnId,
      visibleTurnIds,
    };
    const previous = store.visibleTurnInfo;
    const unchanged = previous?.turnId === nextVisibleTurnInfo.turnId
      && previous.turnIndex === nextVisibleTurnInfo.turnIndex
      && previous.totalTurns === nextVisibleTurnInfo.totalTurns
      && previous.userMessage === nextVisibleTurnInfo.userMessage
      && previous.visibleTurnIds.length === visibleTurnIds.length
      && previous.visibleTurnIds.every((turnId, index) => turnId === visibleTurnIds[index]);
    if (!unchanged) store.setVisibleTurnInfo(nextVisibleTurnInfo);
  }, [userMessageItems]);

  const scheduleVisibleTurnInfoUpdate = useCallback(() => {
    if (visibleTurnUpdateFrameRef.current !== null) return;
    visibleTurnUpdateFrameRef.current = requestAnimationFrame(() => {
      visibleTurnUpdateFrameRef.current = null;
      updateVisibleTurnInfoFromViewport();
    });
  }, [updateVisibleTurnInfoFromViewport]);

  useEffect(() => () => {
    if (visibleTurnUpdateFrameRef.current !== null) {
      cancelAnimationFrame(visibleTurnUpdateFrameRef.current);
      visibleTurnUpdateFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    if (!scrollerElement) return;
    const handleNativeScroll = () => {
      const distanceFromBottom = Math.max(
        0,
        scrollerElement.scrollHeight - scrollerElement.clientHeight - scrollerElement.scrollTop,
      );
      setIsAtBottom(distanceFromBottom <= 50);
      // Before anything else: the dip that caused a clamp may only exist for
      // this event, and reading geometry later finds it already recovered.
      reportViewportFall(scrollerElement);
      handleScroll();
      scheduleVisibleTurnInfoUpdate();
    };
    const handleWheel = () => notifyUserScrollIntent();
    const handleTouchMove = () => notifyUserScrollIntent();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) {
        notifyUserScrollIntent();
      }
    };
    scrollerElement.addEventListener('scroll', handleNativeScroll, { passive: true });
    scrollerElement.addEventListener('wheel', handleWheel, { passive: true });
    scrollerElement.addEventListener('touchmove', handleTouchMove, { passive: true });
    scrollerElement.addEventListener('keydown', handleKeyDown);
    return () => {
      scrollerElement.removeEventListener('scroll', handleNativeScroll);
      scrollerElement.removeEventListener('wheel', handleWheel);
      scrollerElement.removeEventListener('touchmove', handleTouchMove);
      scrollerElement.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    handleScroll,
    notifyUserScrollIntent,
    reportViewportFall,
    scheduleVisibleTurnInfoUpdate,
    scrollerElement,
  ]);

  useEffect(() => {
    if (!scrollerElement) return;
    const observer = new ResizeObserver(() => {
      scheduleTurnStageUpdate();
      scheduleFollowToLatest();
      scheduleVisibleTurnInfoUpdate();
    });
    const content = scrollerElement.firstElementChild;
    if (content) observer.observe(content);
    observer.observe(scrollerElement);
    return () => observer.disconnect();
  }, [
    scheduleFollowToLatest,
    scheduleTurnStageUpdate,
    scheduleVisibleTurnInfoUpdate,
    scrollerElement,
  ]);

  const getRenderedUserMessageElement = useCallback((turnId: string) => (
    Array.from(
      scrollerElementRef.current?.querySelectorAll<HTMLElement>(
        '.virtual-item-wrapper[data-item-type="user-message"]',
      ) ?? [],
    ).find(element => element.dataset.turnId === turnId) ?? null
  ), []);

  useEffect(() => {
    if (previousStageSessionIdRef.current !== activeSessionId) {
      const previousStage = turnStageRef.current;
      if (previousStage) {
        flowChatDiagnostics.trace({
          hypothesis: 'STAGE',
          location: 'VirtualMessageList.turnStageEffect',
          message: 'Turn stage cleared for a session change',
          data: () => ({
            previousSessionId: previousStageSessionIdRef.current,
            nextSessionId: activeSessionId,
            turnId: previousStage.turnId,
            remainingPx: previousStage.remainingPx,
          }),
        });
      }
      previousStageSessionIdRef.current = activeSessionId;
      previousStageTurnIdRef.current = latestTurnId;
      turnStageRef.current = null;
      stageRemainingBucketRef.current = null;
      setIsTurnStageCalibrating(false);
      setTurnStage(null);
      return;
    }

    const previousTurnId = previousStageTurnIdRef.current;
    if (presentationMode !== 'tail' || viewportMode !== 'live-tail') {
      previousStageTurnIdRef.current = latestTurnId;
      setIsTurnStageCalibrating(false);
      if (turnStageRef.current) {
        const previousStage = turnStageRef.current;
        flowChatDiagnostics.trace({
          hypothesis: 'STAGE',
          location: 'VirtualMessageList.turnStageEffect',
          message: 'Turn stage cleared outside the live tail viewport',
          data: () => ({
            sessionId: activeSessionId,
            turnId: previousStage.turnId,
            remainingPx: previousStage.remainingPx,
            presentationMode,
            viewportMode,
          }),
        });
        turnStageRef.current = null;
        stageRemainingBucketRef.current = null;
        setTurnStage(null);
      }
      return;
    }
    if (!latestTurnId || latestTurnId === previousTurnId || virtualItemsRef.current.length === 0) return;

    const scroller = scrollerElementRef.current;
    if (!scroller) return;
    viewportCoordinator.beginTurnPlacement('new-live-turn');
    setIsTurnStageCalibrating(true);
    let frame: number | null = null;
    let attempts = 0;
    let cancelled = false;

    const finishCalibration = () => {
      if (cancelled) return;
      setIsTurnStageCalibrating(false);
    };

    const releasePlacement = () => {
      if (turnStageRef.current?.turnId === latestTurnId) {
        turnStageRef.current = null;
        stageRemainingBucketRef.current = null;
        setTurnStage(null);
      }
      previousStageTurnIdRef.current = latestTurnId;
      finishCalibration();
    };

    // Each step runs one frame after the previous one so React can commit and
    // Virtuoso can remeasure in between. Losing ownership mid-transaction
    // abandons placement rather than writing the viewport behind its new owner.
    const stepWhilePlacing = (run: () => void) => {
      frame = requestAnimationFrame(() => {
        frame = null;
        if (cancelled) return;
        if (viewportCoordinator.getOwner() !== 'turn-placement') {
          releasePlacement();
          return;
        }
        run();
      });
    };

    // The user message is already rendered, so alignment is measured from the
    // real DOM. Virtuoso's `scrollToIndex` would leave a pending location
    // behind that it replays from its own size tree on every later
    // remeasurement, overwriting the placed viewport.
    const alignUserMessageToViewportTop = () => {
      const userMessage = getRenderedUserMessageElement(latestTurnId);
      if (!userMessage) return null;
      const offset = userMessage.getBoundingClientRect().top
        - scroller.getBoundingClientRect().top;
      if (Math.abs(offset) > TURN_PLACEMENT_ALIGNMENT_EPSILON_PX) {
        viewportCoordinator.adjustScrollTop('turn-placement', offset);
      }
      return offset;
    };

    const calibratePlacement = () => {
      const currentStage = turnStageRef.current;
      if (!currentStage || currentStage.turnId !== latestTurnId) {
        viewportCoordinator.finishStageConsumption('turn-placement-cancelled');
        finishCalibration();
        return;
      }

      const maxScrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      const removableWithoutClamp = Math.max(0, maxScrollTop - scroller.scrollTop);
      const finalRemainingPx = Math.max(
        0,
        currentStage.remainingPx - removableWithoutClamp,
      );
      const calibrated = calibrateFlowChatTurnStage({
        stage: currentStage,
        remainingPx: finalRemainingPx,
        scrollHeightPx: scroller.scrollHeight,
        bottomLayoutInsetPx,
      });
      const placedUserMessage = getRenderedUserMessageElement(latestTurnId);
      const placedOffsetFromViewportTop = placedUserMessage
        ? placedUserMessage.getBoundingClientRect().top - scroller.getBoundingClientRect().top
        : null;

      turnStageRef.current = calibrated;
      stageRemainingBucketRef.current = getFlowChatTurnStageRemainingBucket(calibrated);
      previousStageTurnIdRef.current = latestTurnId;
      setTurnStage(calibrated);
      if (calibrated.remainingPx > 0) {
        viewportCoordinator.beginStageConsumption('turn-stage-calibrated');
      } else {
        viewportCoordinator.finishStageConsumption('turn-stage-empty-after-calibration');
        requestAnimationFrame(() => resumeFollowAfterStageRef.current());
      }
      flowChatDiagnostics.trace({
        hypothesis: 'STAGE',
        location: 'VirtualMessageList.createTurnStage',
        message: 'Turn stage alignment calibrated',
        data: () => ({
          sessionId: activeSessionId,
          turnId: latestTurnId,
          provisionalPx: currentStage.initialPx,
          finalRemainingPx: calibrated.remainingPx,
          removedPx: currentStage.initialPx - calibrated.remainingPx,
          removableWithoutClamp,
          baselineNaturalExtentPx: calibrated.baselineNaturalExtentPx,
          userMessageOffsetFromViewportTop: placedOffsetFromViewportTop,
          scrollTop: scroller.scrollTop,
          maxScrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          bottomLayoutInsetPx,
          nextViewportOwner: calibrated.remainingPx > 0
            ? 'stage-consuming'
            : 'following',
        }),
      });
      // Placement has exactly one postcondition. Assert it here so a miss is a
      // single greppable record instead of arithmetic across three of them.
      if (
        placedOffsetFromViewportTop === null
        || Math.abs(placedOffsetFromViewportTop) > TURN_PLACEMENT_MAX_SETTLED_OFFSET_PX
      ) {
        flowChatDiagnostics.trace({
          hypothesis: 'STAGE',
          location: 'VirtualMessageList.createTurnStage',
          message: 'Turn stage placement did not reach the viewport top',
          data: () => ({
            sessionId: activeSessionId,
            turnId: latestTurnId,
            userMessageOffsetFromViewportTop: placedOffsetFromViewportTop,
            toleratedOffsetPx: TURN_PLACEMENT_MAX_SETTLED_OFFSET_PX,
            removableWithoutClamp,
            provisionalPx: currentStage.initialPx,
            stageRemainingPxAtPlacement: currentStage.remainingPx,
            finalRemainingPx: calibrated.remainingPx,
            scrollTop: scroller.scrollTop,
            maxScrollTop,
            scrollHeight: scroller.scrollHeight,
            clientHeight: scroller.clientHeight,
          }),
        });
      }
      finishCalibration();
    };

    const correctPlacement = () => {
      alignUserMessageToViewportTop();
      stepWhilePlacing(calibratePlacement);
    };

    const alignPlacement = () => {
      alignUserMessageToViewportTop();
      stepWhilePlacing(correctPlacement);
    };

    const createStage = () => {
      // The retry below re-enters here directly rather than through
      // `stepWhilePlacing`, so this is where the transaction notices it lost
      // ownership while waiting for the user message to render. Without it, a
      // jump to the latest content during that wait would be undone by a stage
      // created a frame later.
      if (viewportCoordinator.getOwner() !== 'turn-placement') {
        releasePlacement();
        return;
      }
      attempts += 1;
      const userMessage = getRenderedUserMessageElement(latestTurnId);
      if (!userMessage) {
        if (attempts < SEARCH_NAVIGATION_MAX_ATTEMPTS) {
          frame = requestAnimationFrame(createStage);
        } else {
          flowChatDiagnostics.trace({
            hypothesis: 'STAGE',
            location: 'VirtualMessageList.createTurnStage',
            message: 'Turn stage creation abandoned because the user message was not rendered',
            data: () => ({
              sessionId: activeSessionId,
              turnId: latestTurnId,
              attempts,
              virtualItemCount: virtualItemsRef.current.length,
            }),
          });
          previousStageTurnIdRef.current = latestTurnId;
          viewportCoordinator.finishStageConsumption('turn-placement-abandoned');
          finishCalibration();
        }
        return;
      }
      const previousStageRemainingPx = turnStageRef.current?.remainingPx ?? 0;
      const provisional = createProvisionalFlowChatTurnStage({
        turnId: latestTurnId,
        viewportHeightPx: scroller.clientHeight,
      });
      turnStageRef.current = provisional;
      stageRemainingBucketRef.current = getFlowChatTurnStageRemainingBucket(provisional);
      setTurnStage(provisional);
      // This transaction is about to relocate the viewport and realign from the
      // resulting geometry, so height changes made now cost nothing to correct.
      // It is the only moment collapses held over from earlier Turns can run
      // without moving content under the reader — waiting for them to leave the
      // viewport on their own can take an arbitrary number of Turns.
      //
      // It must land here, in the same commit as the provisional stage: before
      // both alignment passes measure, and before calibration reads
      // `scrollHeight`. A baseline taken against a height that is about to
      // shrink would make later growth repay the difference before it consumed
      // anything, and the stage would outstay its Turn.
      const flushedCollapseCount = autoCollapseControllerRef.current?.flushPending(
        'turn-placement',
      ) ?? 0;
      flowChatDiagnostics.trace({
        hypothesis: 'STAGE',
        location: 'VirtualMessageList.createTurnStage',
        message: 'Provisional Turn stage created for a new live Turn',
        data: () => ({
          sessionId: activeSessionId,
          turnId: latestTurnId,
          attempts,
          provisionalPx: provisional.initialPx,
          flushedCollapseCount,
          previousStageRemainingPx,
          scrollTopBeforePlacement: scroller.scrollTop,
          scrollHeight: scroller.scrollHeight,
          clientHeight: scroller.clientHeight,
          bottomLayoutInsetPx,
          userMessageTopBeforePlacement:
            userMessage.getBoundingClientRect().top - scroller.getBoundingClientRect().top,
        }),
      });

      stepWhilePlacing(alignPlacement);
    };
    frame = requestAnimationFrame(createStage);
    return () => {
      cancelled = true;
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [
    activeSessionId,
    bottomLayoutInsetPx,
    getRenderedUserMessageElement,
    latestTurnId,
    presentationMode,
    viewportCoordinator,
    viewportMode,
  ]);

  const navigateToTurnWithStatus = useCallback((
    turnId: string,
    options?: TurnNavigationOptions,
  ): FlowChatTurnNavigationStatus => {
    const targetIndex = virtualItems.findIndex(item => (
      item.turnId === turnId && item.type === 'user-message'
    ));
    if (targetIndex < 0 || !virtuosoRef.current) return 'rejected';
    exitFollowOutput('scroll-to-turn');
    viewportCoordinator.beginExplicitNavigation('scroll-to-turn');
    viewportCoordinator.scrollToIndex('explicit-navigation', {
      index: targetIndex,
      align: 'start',
      behavior: normalizeVirtuosoBehavior(options?.behavior ?? 'auto'),
    });
    return 'settled';
  }, [exitFollowOutput, viewportCoordinator, virtualItems]);

  const navigateToTurn = useCallback((turnId: string, options?: TurnNavigationOptions) => (
    navigateToTurnWithStatus(turnId, options) !== 'rejected'
  ), [navigateToTurnWithStatus]);

  const prepareTurnNavigation = useCallback((
    turnId: string,
    options?: TurnNavigationOptions,
  ): FlowChatTurnNavigationStatus => {
    if (!turnId || !activeSessionId) return 'rejected';
    exitFollowOutput('scroll-to-turn');
    viewportCoordinator.beginExplicitNavigation('prepare-turn-navigation');
    preparedTurnNavigationRef.current = {
      turnId,
      behavior: options?.behavior ?? 'auto',
    };
    return 'pending';
  }, [activeSessionId, exitFollowOutput, viewportCoordinator]);

  useLayoutEffect(() => {
    const prepared = preparedTurnNavigationRef.current;
    if (!prepared) return;
    const status = navigateToTurnWithStatus(prepared.turnId, { behavior: prepared.behavior });
    if (status === 'settled') preparedTurnNavigationRef.current = null;
  }, [navigateToTurnWithStatus, virtualItems]);

  const scrollToTurn = useCallback((turnIndex: number) => {
    const target = userMessageItems[turnIndex - 1];
    if (target) navigateToTurn(target.item.turnId, { behavior: 'smooth' });
  }, [navigateToTurn, userMessageItems]);

  const scrollToIndex = useCallback((index: number) => {
    if (!virtuosoRef.current || index < 0 || index >= virtualItems.length) return;
    exitFollowOutput('scroll-to-index');
    viewportCoordinator.beginExplicitNavigation('scroll-to-index');
    viewportCoordinator.scrollToIndex('explicit-navigation', {
      index,
      align: 'center',
      behavior: 'auto',
    });
  }, [exitFollowOutput, viewportCoordinator, virtualItems.length]);

  const scrollFlowItemIntoView = useCallback((itemId: string) => {
    const scroller = scrollerElementRef.current;
    const element = scroller?.querySelector<HTMLElement>(
      `[data-flow-item-id="${CSS.escape(itemId)}"]`,
    );
    if (!scroller || !element) return false;
    exitFollowOutput('scroll-to-index');
    viewportCoordinator.beginExplicitNavigation('focus-flow-item');
    const scrollerRect = scroller.getBoundingClientRect();
    const elementRect = element.getBoundingClientRect();
    return viewportCoordinator.setScrollTop(
      'explicit-navigation',
      scroller.scrollTop + elementRect.top - scrollerRect.top
        - Math.max(0, (scroller.clientHeight - elementRect.height) / 2),
    );
  }, [exitFollowOutput, viewportCoordinator]);

  const scrollToTurnEnd = useCallback((turnId: string) => {
    let targetIndex = -1;
    for (let index = virtualItems.length - 1; index >= 0; index -= 1) {
      if (virtualItems[index]?.turnId === turnId) {
        targetIndex = index;
        break;
      }
    }
    if (targetIndex < 0 || !virtuosoRef.current) return false;
    exitFollowOutput('scroll-to-turn');
    viewportCoordinator.beginExplicitNavigation('scroll-to-turn-end');
    viewportCoordinator.scrollToIndex('explicit-navigation', {
      index: targetIndex,
      align: 'end',
      behavior: 'auto',
    });
    return true;
  }, [exitFollowOutput, viewportCoordinator, virtualItems]);

  const isTurnRenderedInViewport = useCallback((turnId: string) => {
    const scroller = scrollerElementRef.current;
    const element = getRenderedUserMessageElement(turnId);
    return Boolean(scroller && element && isElementVisibleInScroller(element, scroller));
  }, [getRenderedUserMessageElement]);

  const isTurnTextRenderedInViewport = useCallback((turnId: string) => {
    const scroller = scrollerElementRef.current;
    const element = getRenderedUserMessageElement(turnId);
    return Boolean(
      scroller &&
      element &&
      element.textContent?.trim() &&
      isElementVisibleInScroller(element, scroller)
    );
  }, [getRenderedUserMessageElement]);

  const clearSearchMatch = useCallback(() => {
    searchNavigationRequestIdRef.current += 1;
    setFlowChatSearchHighlight(null);
  }, []);

  const scrollToSearchMatch = useCallback((target: {
    virtualItemIndex: number;
    query: string;
    flowItemId?: string;
    occurrenceIndex?: number;
    expandableIds?: readonly string[];
  }) => {
    clearSearchMatch();
    exitFollowOutput('scroll-to-index');
    viewportCoordinator.beginExplicitNavigation('search-navigation');
    const requestId = searchNavigationRequestIdRef.current;
    viewportCoordinator.scrollToIndex('explicit-navigation', {
      index: target.virtualItemIndex,
      align: 'center',
      behavior: 'auto',
    });
    let attempts = 0;
    const resolve = () => {
      if (searchNavigationRequestIdRef.current !== requestId) return;
      attempts += 1;
      const scroller = scrollerElementRef.current;
      const wrapper = Array.from(
        scroller?.querySelectorAll<HTMLElement>('.virtual-item-wrapper') ?? [],
      ).find(element => Number(element.dataset.virtualIndex) === target.virtualItemIndex);
      if (!scroller || !wrapper) {
        if (attempts < SEARCH_NAVIGATION_MAX_ATTEMPTS) requestAnimationFrame(resolve);
        return;
      }
      for (const expandableId of target.expandableIds ?? []) {
        const expandable = findElementWithDataValue(wrapper, 'data-tool-card-id', expandableId);
        if (expandable?.dataset.expanded === 'false') {
          expandable.querySelector<HTMLElement>(
            '[data-testid="chat-explore-group-toggle"], [data-testid="chat-thinking-toggle"]',
          )?.click();
          if (attempts < SEARCH_NAVIGATION_MAX_ATTEMPTS) requestAnimationFrame(resolve);
          return;
        }
      }
      const root = getFlowChatSearchTextRoot(wrapper, target.flowItemId);
      const ranges = findFlowChatSearchTextRanges(root, target.query);
      const rangeIndex = Math.min(target.occurrenceIndex ?? 0, Math.max(0, ranges.length - 1));
      const range = ranges[rangeIndex] ?? null;
      if (!range) return;
      setFlowChatSearchHighlight(range, ranges.filter((_, index) => index !== rangeIndex));
      const rangeRect = range.getBoundingClientRect();
      const scrollerRect = scroller.getBoundingClientRect();
      viewportCoordinator.setScrollTop('explicit-navigation', Math.max(
        0,
        Math.min(
          scroller.scrollHeight - scroller.clientHeight,
          scroller.scrollTop + rangeRect.top - scrollerRect.top -
            Math.max(0, (scroller.clientHeight - rangeRect.height) / 2),
        ),
      ));
    };
    requestAnimationFrame(resolve);
  }, [clearSearchMatch, exitFollowOutput, viewportCoordinator]);

  useEffect(() => () => setFlowChatSearchHighlight(null), []);

  const captureHistoryPrependAnchor = useCallback(() => {
    const scroller = scrollerElementRef.current;
    if (!scroller) return false;
    const scrollerRect = scroller.getBoundingClientRect();
    const anchor = Array.from(
      scroller.querySelectorAll<HTMLElement>(
        '.virtual-item-wrapper[data-item-type="user-message"]',
      ),
    ).find(element => element.getBoundingClientRect().bottom > scrollerRect.top);
    if (!anchor?.dataset.turnId) return false;
    historyPrependAnchorRef.current = {
      turnId: anchor.dataset.turnId,
      offsetFromScrollerTop: anchor.getBoundingClientRect().top - scrollerRect.top,
    };
    return true;
  }, []);

  useLayoutEffect(() => {
    const anchor = historyPrependAnchorRef.current;
    const scroller = scrollerElementRef.current;
    if (!anchor || !scroller) return;
    const element = getRenderedUserMessageElement(anchor.turnId);
    if (!element) return;
    const correction = element.getBoundingClientRect().top -
      scroller.getBoundingClientRect().top - anchor.offsetFromScrollerTop;
    viewportCoordinator.beginExplicitNavigation('history-prepend-anchor');
    viewportCoordinator.adjustScrollTop('explicit-navigation', correction);
    historyPrependAnchorRef.current = null;
  }, [getRenderedUserMessageElement, viewportCoordinator, virtualItems]);

  const requestHistoryBoundary = useCallback((direction: SessionHistoryWindowDirection) => {
    if (
      !onHistoryWindowBoundaryIntent ||
      boundaryRequestRef.current[direction] ||
      exhaustedBoundaryRef.current[direction]
    ) return;
    const request = Promise.resolve(onHistoryWindowBoundaryIntent(direction, direction === 'before' ? {
      prepareViewportForPresentationCommit: captureHistoryPrependAnchor,
      cancelViewportPresentationCommit: () => {
        historyPrependAnchorRef.current = null;
      },
    } : undefined)).then(normalizeBoundaryResult).then(result => {
      if (result === 'exhausted') {
        exhaustedBoundaryRef.current[direction] = true;
      } else if (result === 'applied') {
        exhaustedBoundaryRef.current[direction] = false;
      }
      if (result !== 'applied') historyPrependAnchorRef.current = null;
    }).finally(() => {
      boundaryRequestRef.current[direction] = null;
    });
    boundaryRequestRef.current[direction] = request;
  }, [captureHistoryPrependAnchor, onHistoryWindowBoundaryIntent]);

  const handleRangeChanged = useCallback((range: ListRange) => {
    const localStart = Math.max(0, range.startIndex - virtuosoFirstItemIndex);
    const localEnd = Math.max(localStart, range.endIndex - virtuosoFirstItemIndex);
    scheduleVisibleTurnInfoUpdate();
    if (localStart <= 1) requestHistoryBoundary('before');
    if (localEnd >= virtualItems.length - 2 && presentationMode === 'history-window') {
      requestHistoryBoundary('after');
    }
  }, [presentationMode, requestHistoryBoundary, scheduleVisibleTurnInfoUpdate, virtualItems.length, virtuosoFirstItemIndex]);

  useLayoutEffect(() => {
    scheduleVisibleTurnInfoUpdate();
  }, [scheduleVisibleTurnInfoUpdate, virtualItems]);

  useEffect(() => {
    if (userMessageItems.length === 0) {
      useModernFlowChatStore.getState().setVisibleTurnInfo(null);
    }
  }, [userMessageItems.length]);

  const handleScrollerRef = useCallback((element: HTMLElement | Window | null) => {
    const scroller = element instanceof HTMLElement ? element : null;
    scrollerElementRef.current = scroller;
    setScrollerElement(scroller);
  }, []);

  const scrollToPhysicalBottom = useCallback(() => {
    enterFollowOutput('jump-to-latest');
  }, [enterFollowOutput]);

  /**
   * An explicit jump to the latest content is the one moment the whole stage may
   * go. The space exists to hold a new Turn near the viewport top; a reader
   * asking to be taken to the tail has withdrawn that request, and the resulting
   * shrink is paid for by the movement they asked for. Keeping the space instead
   * sends them to a tail made of blank Footer.
   */
  const discardTurnStageForJumpToLatest = useCallback(() => {
    const stage = turnStageRef.current;
    // A placement that has not produced a stage yet still has to be called off:
    // it is waiting for the new user message to render and would otherwise
    // reinstate the space a frame after the jump removed it.
    const isPlacingTurn = viewportCoordinator.getOwner() === 'turn-placement';
    if (!stage && !isPlacingTurn) return false;
    flowChatDiagnostics.trace({
      hypothesis: 'STAGE',
      location: 'VirtualMessageList.scrollToLatestEndPosition',
      message: 'Turn stage discarded for an explicit jump to the latest content',
      data: () => ({
        sessionId: activeSessionId,
        turnId: stage?.turnId ?? latestTurnId,
        remainingPx: stage?.remainingPx ?? 0,
        isCalibrated: stage?.isCalibrated ?? null,
        isPlacingTurn,
        viewportOwner: viewportCoordinator.getOwner(),
        scrollTop: scrollerElementRef.current?.scrollTop ?? null,
        scrollHeight: scrollerElementRef.current?.scrollHeight ?? null,
      }),
    });
    turnStageRef.current = null;
    stageRemainingBucketRef.current = null;
    pendingStageTrimReasonRef.current = null;
    setTurnStage(null);
    setIsTurnStageCalibrating(false);
    // Placement for this Turn is over either way, and the jump may well have
    // interrupted it mid-transaction. Leaving this marker unset would keep
    // `hasPendingTurnStageCalibration` true for good, and that gate blocks every
    // follow write.
    previousStageTurnIdRef.current = latestTurnId;
    viewportCoordinator.finishStageConsumption('turn-stage-discarded-for-jump-to-latest');
    return true;
  }, [activeSessionId, latestTurnId, viewportCoordinator]);

  const scrollToLatestEndPosition = useCallback(() => {
    onUserScrollIntent?.();
    if (!discardTurnStageForJumpToLatest()) {
      enterFollowOutput('jump-to-latest');
      return;
    }
    // The Footer shrinks on the commit this call just triggered. Entering follow
    // one frame later aims at the tail that exists rather than at the one the
    // stage was still padding, so the jump is a single movement.
    if (jumpToLatestFrameRef.current !== null) {
      cancelAnimationFrame(jumpToLatestFrameRef.current);
    }
    jumpToLatestFrameRef.current = requestAnimationFrame(() => {
      jumpToLatestFrameRef.current = null;
      enterFollowOutput('jump-to-latest');
    });
  }, [discardTurnStageForJumpToLatest, enterFollowOutput, onUserScrollIntent]);

  useImperativeHandle(ref, () => ({
    scrollToTurn,
    scrollToIndex,
    scrollFlowItemIntoView,
    scrollToSearchMatch,
    clearSearchMatch,
    scrollToPhysicalBottom,
    scrollToTurnEnd,
    isTurnRenderedInViewport,
    isTurnTextRenderedInViewport,
    scrollToLatestEndPosition,
    navigateToTurn,
    navigateToTurnWithStatus,
    prepareTurnNavigation,
  }), [
    clearSearchMatch,
    isTurnRenderedInViewport,
    isTurnTextRenderedInViewport,
    navigateToTurn,
    navigateToTurnWithStatus,
    prepareTurnNavigation,
    scrollToIndex,
    scrollFlowItemIntoView,
    scrollToLatestEndPosition,
    scrollToPhysicalBottom,
    scrollToSearchMatch,
    scrollToTurn,
    scrollToTurnEnd,
  ]);

  const visibleTurnInfo = useModernFlowChatStore(state => state.visibleTurnInfo);
  const handleJumpToCurrentTurn = useCallback(() => {
    if (visibleTurnInfo?.turnId) {
      navigateToTurn(visibleTurnInfo.turnId, { behavior: 'smooth' });
    }
  }, [navigateToTurn, visibleTurnInfo?.turnId]);
  const { shouldShowButton: shouldShowTurnHeaderButton, handleClick: handleTurnHeaderClick } =
    useScrollToTurnHeader({
      scrollerRef: scrollerElementRef,
      currentTurnId: visibleTurnInfo?.turnId ?? null,
      currentTurnIndex: visibleTurnInfo?.turnIndex ?? 0,
      visibleTurnInfo,
      onJumpToCurrentTurn: handleJumpToCurrentTurn,
    });
  const handleScrollToTaskOffset = useCallback((offset: number, behavior: ScrollBehavior) => {
    exitFollowOutput('scroll-to-index');
    viewportCoordinator.beginExplicitNavigation('scroll-to-task');
    viewportCoordinator.setScrollTop('explicit-navigation', offset, behavior);
  }, [exitFollowOutput, viewportCoordinator]);
  const { visibleTaskInfo, scrollToTask } = useVisibleTaskInfo({
    scrollerRef: scrollerElementRef,
    virtualItems,
    onScrollToOffset: handleScrollToTaskOffset,
  });

  const previousHistoryBoundaryStatusNode = useMemo(() => (
    historyBoundaryState.before !== 'idle' ? (
      <FlowChatHistoryPagingSentinel
        state={historyBoundaryState.before}
        label={historyBoundaryState.before === 'error'
          ? t('historyState.olderHistoryNotReady')
          : t('historyState.preparingOlderHistory')}
      />
    ) : null
  ), [historyBoundaryState.before, t]);
  const nextHistoryBoundaryStatusNode = useMemo(() => (
    presentationMode === 'history-window' && historyBoundaryState.after !== 'idle' ? (
      <FlowChatHistoryPagingSentinel
        state={historyBoundaryState.after}
        label={t('historyState.loadingDescription')}
      />
    ) : null
  ), [historyBoundaryState.after, presentationMode, t]);
  const virtuosoContext = useMemo<FlowChatVirtuosoContext>(() => ({
    bottomLayoutInsetPx,
    stageSpacePx: turnStage?.remainingPx ?? 0,
    previousHistoryBoundaryStatusNode,
    nextHistoryBoundaryStatusNode,
    runtimeStatusSessionId: activeSessionId,
  }), [activeSessionId, bottomLayoutInsetPx, nextHistoryBoundaryStatusNode, previousHistoryBoundaryStatusNode, turnStage?.remainingPx]);
  const computeVirtuosoItemKey = useCallback((_: number, item: VirtualItem) => (
    `${activeSessionId ?? 'no-active-session'}:${getVirtualItemStableKey(item)}`
  ), [activeSessionId]);
  const renderVirtuosoItem = useCallback((index: number, item: VirtualItem) => (
    <VirtualItemRenderer item={item} index={index - virtuosoFirstItemIndex} />
  ), [virtuosoFirstItemIndex]);

  if (virtualItems.length === 0) {
    return (
      <div
        data-bf-component="virtual-message-list"
        data-bf-part="root"
        data-bf-state="empty"
        className="virtual-message-list virtual-message-list--empty"
        data-testid="flowchat-message-list-empty"
      >
        <div className="empty-state" data-bf-component="virtual-message-list" data-bf-part="empty">
          <p data-bf-component="virtual-message-list" data-bf-part="emptyMessage">No messages yet</p>
        </div>
      </div>
    );
  }

  return (
    <div
      data-bf-component="virtual-message-list"
      data-bf-part="root"
      className="virtual-message-list"
      data-testid="flowchat-message-list"
      data-presentation-mode={presentationMode}
      data-viewport-mode={viewportMode}
      data-streaming-output={isStreamingOutput ? 'true' : 'false'}
    >
      <FlowChatAutoCollapseProvider
        scrollerRef={scrollerElementRef}
        isFollowingOutput={isFollowingOutput}
        stageSpacePx={turnStage?.remainingPx ?? 0}
        bottomLayoutInsetPx={bottomLayoutInsetPx}
        sessionId={activeSessionId}
        anchorTurnId={turnStage?.turnId ?? null}
        isSuspended={isTurnStageCalibrating || hasPendingTurnStageCalibration}
        controllerRef={autoCollapseControllerRef}
      >
      <Virtuoso
        key={activeSessionId ?? 'no-active-session'}
        ref={virtuosoRef}
        data={virtualItems}
        firstItemIndex={virtuosoFirstItemIndex}
        initialTopMostItemIndex={{ index: Math.max(0, virtualItems.length - 1), align: 'end' }}
        computeItemKey={computeVirtuosoItemKey}
        itemContent={renderVirtuosoItem}
        followOutput={false}
        alignToBottom={false}
        overscan={FLOW_CHAT_VIRTUOSO_OVERSCAN}
        increaseViewportBy={FLOW_CHAT_VIRTUOSO_VIEWPORT_INCREASE}
        atBottomThreshold={50}
        atBottomStateChange={setIsAtBottom}
        rangeChanged={handleRangeChanged}
        scrollerRef={handleScrollerRef}
        context={virtuosoContext}
        components={FLOW_CHAT_VIRTUOSO_COMPONENTS}
      />
      </FlowChatAutoCollapseProvider>

      <ScrollToTurnHeaderButton
        visible={shouldShowTurnHeaderButton}
        onClick={handleTurnHeaderClick}
        turnLabel={visibleTurnInfo ? `Turn ${visibleTurnInfo.turnIndex}` : undefined}
      />
      <StickyTaskIndicator
        visible={Boolean(visibleTaskInfo)}
        taskInfo={visibleTaskInfo}
        onClick={scrollToTask}
      />
      <ScrollToLatestBar
        visible={(viewportMode === 'history-reading' || !isAtBottom) && virtualItems.length > 0}
        onClick={viewportMode === 'history-reading' && onRequestJumpToLatest
          ? onRequestJumpToLatest
          : scrollToLatestEndPosition}
        isInputActive={isInputActive}
        isInputExpanded={isInputExpanded}
        inputHeight={inputHeight}
      />
    </div>
  );
});

VirtualMessageListSession.displayName = 'VirtualMessageListSession';

export const VirtualMessageList = forwardRef<VirtualMessageListRef, VirtualMessageListProps>((props, ref) => {
  const activeSession = useActiveSession();
  return <VirtualMessageListSession key={activeSession?.sessionId ?? 'no-active-session'} ref={ref} {...props} />;
});

VirtualMessageList.displayName = 'VirtualMessageList';
