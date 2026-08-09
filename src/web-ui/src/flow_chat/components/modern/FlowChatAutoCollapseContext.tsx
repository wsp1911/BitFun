import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  getFlowChatAutoCollapseDecision,
  type FlowChatAutoCollapseDecision,
} from './flowChatAutoCollapse';
import { FlowChatAutoCollapseContext } from './useFlowChatAutoCollapse';
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

interface FlowChatAutoCollapseProviderProps {
  children: ReactNode;
  scrollerRef: RefObject<HTMLElement | null>;
  isFollowingOutput: boolean;
  stageSpacePx: number;
  bottomLayoutInsetPx: number;
  sessionId: string | null;
  isSuspended?: boolean;
}

const NATURAL_TAIL_EPSILON_PX = 2;

export function FlowChatAutoCollapseProvider({
  children,
  scrollerRef,
  isFollowingOutput,
  stageSpacePx,
  bottomLayoutInsetPx,
  sessionId,
  isSuspended = false,
}: FlowChatAutoCollapseProviderProps) {
  const requestsRef = useRef(new Map<number, AutoCollapseRequest>());
  const nextRequestIdRef = useRef(1);
  const evaluationFrameRef = useRef<number | null>(null);
  const settlingRef = useRef(false);
  const policyRef = useRef({ isFollowingOutput, stageSpacePx, bottomLayoutInsetPx, isSuspended });
  policyRef.current = { isFollowingOutput, stageSpacePx, bottomLayoutInsetPx, isSuspended };

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
          pendingCandidateCount: requestsRef.current.size,
        }),
      });
      request.collapse();
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          settlingRef.current = false;
          flowChatDiagnostics.trace({
            hypothesis: 'COLLAPSE',
            location: 'FlowChatAutoCollapseProvider.evaluate',
            message: 'Automatic collapse candidate settled',
            data: () => ({
              requestId: request.id,
              cardId: request.cardId,
              sessionId: request.sessionId,
              turnId: request.turnId,
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
  }, [isFollowingOutput, stageSpacePx, bottomLayoutInsetPx, isSuspended, scheduleEvaluation]);

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
