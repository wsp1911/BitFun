import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  type MutableRefObject,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  getFlowChatAutoCollapseDecision,
  type FlowChatAutoCollapseDecision,
} from './flowChatAutoCollapse';
import { FlowChatAutoCollapseContext } from './useFlowChatAutoCollapse';
import { measureFlowChatTurnAnchorGeometry } from './flowChatViewportDiagnostics';
import { flowChatDiagnostics } from '@/infrastructure/diagnostics/flowChatDiagnostics';

interface AutoCollapseRequest {
  id: number;
  element: HTMLElement;
  collapse: () => void;
  cardId: string | null;
  sessionId: string | null;
  turnId: string | null;
  lastDecision: FlowChatAutoCollapseDecision | 'disconnected' | null;
}

export interface FlowChatAutoCollapseController {
  /**
   * Runs every pending collapse at once and returns how many executed.
   *
   * The one-at-a-time, two-frame discipline in `evaluate` exists to keep each
   * collapse individually invisible. A caller that is about to relocate the
   * viewport and realign from the resulting geometry does not need it: the
   * collapses are collectively invisible, and pacing them would only delay the
   * transaction. Nothing else may call this.
   */
  flushPending: (reason: string) => number;
}

interface FlowChatAutoCollapseProviderProps {
  children: ReactNode;
  scrollerRef: RefObject<HTMLElement | null>;
  isFollowingOutput: boolean;
  stageSpacePx: number;
  bottomLayoutInsetPx: number;
  sessionId: string | null;
  anchorTurnId: string | null;
  isSuspended?: boolean;
  controllerRef?: MutableRefObject<FlowChatAutoCollapseController | null>;
}

const NATURAL_TAIL_EPSILON_PX = 2;

export function FlowChatAutoCollapseProvider({
  children,
  scrollerRef,
  isFollowingOutput,
  stageSpacePx,
  bottomLayoutInsetPx,
  sessionId,
  anchorTurnId,
  isSuspended = false,
  controllerRef,
}: FlowChatAutoCollapseProviderProps) {
  const requestsRef = useRef(new Map<number, AutoCollapseRequest>());
  const nextRequestIdRef = useRef(1);
  const evaluationFrameRef = useRef<number | null>(null);
  const settlingRef = useRef(false);
  const policyRef = useRef({
    isFollowingOutput,
    stageSpacePx,
    bottomLayoutInsetPx,
    anchorTurnId,
    isSuspended,
  });
  // Synced on commit rather than during render, so a discarded or interleaved
  // render cannot publish a stale policy to the rAF callbacks that read it.
  useLayoutEffect(() => {
    policyRef.current = {
      isFollowingOutput,
      stageSpacePx,
      bottomLayoutInsetPx,
      anchorTurnId,
      isSuspended,
    };
  }, [anchorTurnId, bottomLayoutInsetPx, isFollowingOutput, isSuspended, stageSpacePx]);

  const evaluate = useCallback(() => {
    evaluationFrameRef.current = null;
    if (settlingRef.current) return;

    const scroller = scrollerRef.current;
    if (!scroller) return;
    const viewportRect = scroller.getBoundingClientRect();
    const policy = policyRef.current;
    if (policy.isSuspended) return;
    const naturalMaxScrollTop = Math.max(
      0,
      scroller.scrollHeight - policy.stageSpacePx - scroller.clientHeight,
    );
    const isAtNaturalTail = scroller.scrollTop >= naturalMaxScrollTop - NATURAL_TAIL_EPSILON_PX;

    for (const request of requestsRef.current.values()) {
      if (!request.element.isConnected) {
        if (request.lastDecision !== 'disconnected') {
          flowChatDiagnostics.trace({
            hypothesis: 'COLLAPSE',
            location: 'FlowChatAutoCollapseProvider.evaluate',
            message: 'Automatic collapse candidate was removed after its card disconnected',
            data: () => ({
              requestId: request.id,
              cardId: request.cardId,
              sessionId: request.sessionId,
              turnId: request.turnId,
            }),
          });
        }
        requestsRef.current.delete(request.id);
        continue;
      }
      const cardRect = request.element.getBoundingClientRect();
      const decision = getFlowChatAutoCollapseDecision({
        cardTop: cardRect.top,
        cardBottom: cardRect.bottom,
        viewportTop: viewportRect.top,
        viewportBottom: viewportRect.bottom,
        isFollowingOutput: policy.isFollowingOutput,
        isAtNaturalTail,
      });
      if (request.lastDecision !== decision) {
        request.lastDecision = decision;
        flowChatDiagnostics.trace({
          hypothesis: 'COLLAPSE',
          location: 'FlowChatAutoCollapseProvider.evaluate',
          message: decision === 'eligible'
            ? 'Automatic collapse candidate became eligible'
            : 'Automatic collapse candidate is waiting',
          data: () => ({
            requestId: request.id,
            cardId: request.cardId,
            sessionId: request.sessionId,
            turnId: request.turnId,
            decision,
            isFollowingOutput: policy.isFollowingOutput,
            isAtNaturalTail,
            cardTop: cardRect.top,
            cardBottom: cardRect.bottom,
            viewportTop: viewportRect.top,
            viewportBottom: viewportRect.bottom,
            scrollTop: scroller.scrollTop,
            naturalMaxScrollTop,
            stageSpacePx: policy.stageSpacePx,
            pendingCandidateCount: requestsRef.current.size,
          }),
        });
      }
      if (decision !== 'eligible') {
        continue;
      }

      requestsRef.current.delete(request.id);
      settlingRef.current = true;
      const anchorGeometryBefore = measureFlowChatTurnAnchorGeometry(
        scroller,
        policy.anchorTurnId,
      );
      flowChatDiagnostics.trace({
        hypothesis: 'COLLAPSE',
        location: 'FlowChatAutoCollapseProvider.evaluate',
        message: 'Automatic collapse candidate execution started',
        data: () => ({
          requestId: request.id,
          cardId: request.cardId,
          sessionId: request.sessionId,
          turnId: request.turnId,
          isFollowingOutput: policy.isFollowingOutput,
          cardPosition: cardRect.bottom <= viewportRect.top ? 'above' : 'below',
          cardHeight: cardRect.height,
          cardTopFromViewportTop: cardRect.top - viewportRect.top,
          cardBottomFromViewportTop: cardRect.bottom - viewportRect.top,
          anchorTurnId: policy.anchorTurnId,
          anchorGeometryBefore,
          pendingCandidateCount: requestsRef.current.size,
        }),
      });
      request.collapse();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          settlingRef.current = false;
          const settledScroller = scrollerRef.current;
          const settledPolicy = policyRef.current;
          const settledCardRect = request.element.isConnected
            ? request.element.getBoundingClientRect()
            : null;
          const settledViewportRect = settledScroller?.getBoundingClientRect() ?? null;
          const anchorGeometryAfter = settledScroller
            ? measureFlowChatTurnAnchorGeometry(
              settledScroller,
              settledPolicy.anchorTurnId,
            )
            : null;
          flowChatDiagnostics.trace({
            hypothesis: 'COLLAPSE',
            location: 'FlowChatAutoCollapseProvider.evaluate',
            message: 'Automatic collapse candidate settled',
            data: () => ({
              requestId: request.id,
              cardId: request.cardId,
              sessionId: request.sessionId,
              turnId: request.turnId,
              anchorTurnIdBefore: policy.anchorTurnId,
              anchorTurnIdAfter: settledPolicy.anchorTurnId,
              stageSpacePxBefore: policy.stageSpacePx,
              stageSpacePxAfter: settledPolicy.stageSpacePx,
              anchorGeometryBefore,
              anchorGeometryAfter,
              anchorOffsetDeltaPx:
                anchorGeometryBefore.userMessageOffsetFromViewportTop !== null
                && anchorGeometryAfter
                && anchorGeometryAfter.userMessageOffsetFromViewportTop !== null
                  ? anchorGeometryAfter.userMessageOffsetFromViewportTop
                    - anchorGeometryBefore.userMessageOffsetFromViewportTop
                  : null,
              scrollTopDeltaPx: anchorGeometryAfter
                ? anchorGeometryAfter.scrollTop - anchorGeometryBefore.scrollTop
                : null,
              scrollHeightDeltaPx: anchorGeometryAfter
                ? anchorGeometryAfter.scrollHeight - anchorGeometryBefore.scrollHeight
                : null,
              cardHeightBefore: cardRect.height,
              cardHeightAfter: settledCardRect ? settledCardRect.height : null,
              cardShrinkPx: settledCardRect ? cardRect.height - settledCardRect.height : null,
              cardTopFromViewportTopAfter: settledCardRect && settledViewportRect
                ? settledCardRect.top - settledViewportRect.top
                : null,
              pendingCandidateCount: requestsRef.current.size,
            }),
          });
          evaluationFrameRef.current = requestAnimationFrame(evaluate);
        });
      });
      break;
    }
  }, [scrollerRef]);

  const scheduleEvaluation = useCallback(() => {
    if (evaluationFrameRef.current === null && !settlingRef.current) {
      evaluationFrameRef.current = requestAnimationFrame(evaluate);
    }
  }, [evaluate]);

  const flushPending = useCallback((reason: string) => {
    const pending = Array.from(requestsRef.current.values());
    requestsRef.current.clear();
    // The queued evaluation would find an empty map, and its own scheduling
    // gate is the only thing keeping a second one from being queued.
    if (evaluationFrameRef.current !== null) {
      cancelAnimationFrame(evaluationFrameRef.current);
      evaluationFrameRef.current = null;
    }

    let executedCount = 0;
    for (const pendingRequest of pending) {
      if (!pendingRequest.element.isConnected) continue;
      pendingRequest.collapse();
      executedCount += 1;
    }

    if (pending.length > 0) {
      flowChatDiagnostics.trace({
        hypothesis: 'COLLAPSE',
        location: 'FlowChatAutoCollapseProvider.flushPending',
        message: 'Automatic collapse candidates flushed in one commit',
        data: () => ({
          reason,
          sessionId,
          anchorTurnId: policyRef.current.anchorTurnId,
          pendingCount: pending.length,
          executedCount,
          cardIds: pending.map(pendingRequest => pendingRequest.cardId),
        }),
      });
    }
    return executedCount;
  }, [sessionId]);

  useLayoutEffect(() => {
    if (!controllerRef) return;
    controllerRef.current = { flushPending };
    return () => {
      controllerRef.current = null;
    };
  }, [controllerRef, flushPending]);

  const request = useCallback((element: HTMLElement, collapse: () => void) => {
    const id = nextRequestIdRef.current;
    nextRequestIdRef.current += 1;
    const cardId = element.dataset.toolCardId ?? null;
    const turnId = element.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId ?? null;
    requestsRef.current.set(id, {
      id,
      element,
      collapse,
      cardId,
      sessionId,
      turnId,
      lastDecision: null,
    });
    flowChatDiagnostics.trace({
      hypothesis: 'COLLAPSE',
      location: 'FlowChatAutoCollapseProvider.request',
      message: 'Automatic collapse candidate registered',
      data: () => ({
        requestId: id,
        cardId,
        sessionId,
        turnId,
        pendingCandidateCount: requestsRef.current.size,
      }),
    });
    scheduleEvaluation();
    return () => {
      if (requestsRef.current.delete(id)) {
        flowChatDiagnostics.trace({
          hypothesis: 'COLLAPSE',
          location: 'FlowChatAutoCollapseProvider.request',
          message: 'Automatic collapse candidate cancelled',
          data: () => ({
            requestId: id,
            cardId,
            sessionId,
            turnId,
            pendingCandidateCount: requestsRef.current.size,
          }),
        });
      }
    };
  }, [scheduleEvaluation, sessionId]);

  useEffect(() => {
    scheduleEvaluation();
  }, [
    anchorTurnId,
    bottomLayoutInsetPx,
    isFollowingOutput,
    isSuspended,
    scheduleEvaluation,
    stageSpacePx,
  ]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const handleViewportChange = () => scheduleEvaluation();
    scroller.addEventListener('scroll', handleViewportChange, { passive: true });
    window.addEventListener('resize', handleViewportChange);
    const observer = new ResizeObserver(handleViewportChange);
    observer.observe(scroller);
    const content = scroller.firstElementChild;
    if (content) observer.observe(content);
    return () => {
      scroller.removeEventListener('scroll', handleViewportChange);
      window.removeEventListener('resize', handleViewportChange);
      observer.disconnect();
    };
  }, [scheduleEvaluation, scrollerRef]);

  useEffect(() => () => {
    if (evaluationFrameRef.current !== null) {
      cancelAnimationFrame(evaluationFrameRef.current);
    }
    requestsRef.current.clear();
  }, []);

  const value = useMemo(() => ({ isManaged: true, request }), [request]);
  return (
    <FlowChatAutoCollapseContext.Provider value={value}>
      {children}
    </FlowChatAutoCollapseContext.Provider>
  );
}
