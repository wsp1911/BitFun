import { useCallback, useMemo, useRef, type RefObject } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import { flowChatDiagnostics } from '@/infrastructure/diagnostics/flowChatDiagnostics';

export type FlowChatViewportOwner =
  | 'idle'
  | 'following'
  | 'turn-placement'
  | 'stage-consuming'
  | 'explicit-navigation';

type ViewportWriter = Exclude<FlowChatViewportOwner, 'idle' | 'stage-consuming'>;

interface UseFlowChatViewportCoordinatorOptions {
  activeSessionId: string | null;
  scrollerRef: RefObject<HTMLElement | null>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  getLastItemIndex: () => number;
  isTurnPlacementPending: boolean;
}

export interface FlowChatViewportCoordinator {
  getOwner: () => FlowChatViewportOwner;
  setFollowingDesired: (following: boolean, reason: string) => void;
  beginTurnPlacement: (reason: string) => void;
  beginStageConsumption: (reason: string) => boolean;
  finishStageConsumption: (reason: string) => void;
  beginExplicitNavigation: (reason: string) => void;
  handleUserIntent: (reason: string) => void;
  scrollToTail: (writer: 'following', behavior: ScrollBehavior) => boolean;
  scrollToIndex: (
    writer: 'turn-placement' | 'explicit-navigation',
    options: { index: number; align: 'start' | 'center' | 'end'; behavior: 'auto' | 'smooth' },
  ) => boolean;
  setScrollTop: (
    writer: 'turn-placement' | 'explicit-navigation',
    top: number,
    behavior?: ScrollBehavior,
  ) => boolean;
  adjustScrollTop: (
    writer: 'turn-placement' | 'explicit-navigation',
    delta: number,
  ) => boolean;
}

function clampScrollTop(scroller: HTMLElement, top: number): number {
  return Math.max(0, Math.min(scroller.scrollHeight - scroller.clientHeight, top));
}

export function useFlowChatViewportCoordinator({
  activeSessionId,
  scrollerRef,
  virtuosoRef,
  getLastItemIndex,
  isTurnPlacementPending,
}: UseFlowChatViewportCoordinatorOptions): FlowChatViewportCoordinator {
  const ownerRef = useRef<FlowChatViewportOwner>('idle');
  const followingDesiredRef = useRef(false);
  const isTurnPlacementPendingRef = useRef(isTurnPlacementPending);
  isTurnPlacementPendingRef.current = isTurnPlacementPending;

  const transition = useCallback((nextOwner: FlowChatViewportOwner, reason: string) => {
    const previousOwner = ownerRef.current;
    if (previousOwner === nextOwner) return;
    ownerRef.current = nextOwner;
    flowChatDiagnostics.trace({
      hypothesis: 'VIEWPORT',
      location: 'useFlowChatViewportCoordinator.transition',
      message: 'FlowChat viewport ownership changed',
      data: () => ({
        sessionId: activeSessionId,
        previousOwner,
        nextOwner,
        reason,
      }),
    });
  }, [activeSessionId]);

  const canWrite = useCallback((writer: ViewportWriter) => (
    ownerRef.current === writer
    && !(writer === 'following' && isTurnPlacementPendingRef.current)
  ), []);

  const setFollowingDesired = useCallback((following: boolean, reason: string) => {
    followingDesiredRef.current = following;
    if (!following) {
      if (ownerRef.current === 'following') transition('idle', reason);
      return;
    }
    if (ownerRef.current !== 'turn-placement' && ownerRef.current !== 'stage-consuming') {
      transition('following', reason);
    }
  }, [transition]);

  const beginTurnPlacement = useCallback((reason: string) => {
    transition('turn-placement', reason);
  }, [transition]);

  const beginStageConsumption = useCallback((reason: string) => {
    if (ownerRef.current !== 'turn-placement' && ownerRef.current !== 'stage-consuming') {
      return false;
    }
    transition('stage-consuming', reason);
    return true;
  }, [transition]);

  const finishStageConsumption = useCallback((reason: string) => {
    if (ownerRef.current !== 'stage-consuming' && ownerRef.current !== 'turn-placement') return;
    transition(followingDesiredRef.current ? 'following' : 'idle', reason);
  }, [transition]);

  const beginExplicitNavigation = useCallback((reason: string) => {
    followingDesiredRef.current = false;
    transition('explicit-navigation', reason);
  }, [transition]);

  const handleUserIntent = useCallback((reason: string) => {
    followingDesiredRef.current = false;
    transition('idle', reason);
  }, [transition]);

  const scrollToTail = useCallback((writer: 'following', behavior: ScrollBehavior) => {
    if (!canWrite(writer)) return false;
    const scroller = scrollerRef.current;
    if (scroller) {
      scroller.scrollTo({
        top: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
        behavior,
      });
      return true;
    }
    virtuosoRef.current?.scrollToIndex({
      index: Math.max(0, getLastItemIndex()),
      align: 'end',
      behavior: behavior === 'smooth' ? 'smooth' : 'auto',
    });
    return virtuosoRef.current !== null;
  }, [canWrite, getLastItemIndex, scrollerRef, virtuosoRef]);

  const scrollToIndex = useCallback((
    writer: 'turn-placement' | 'explicit-navigation',
    options: { index: number; align: 'start' | 'center' | 'end'; behavior: 'auto' | 'smooth' },
  ) => {
    if (!canWrite(writer) || !virtuosoRef.current) return false;
    virtuosoRef.current.scrollToIndex(options);
    return true;
  }, [canWrite, virtuosoRef]);

  const setScrollTop = useCallback((
    writer: 'turn-placement' | 'explicit-navigation',
    top: number,
    behavior: ScrollBehavior = 'auto',
  ) => {
    if (!canWrite(writer)) return false;
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    scroller.scrollTo({ top: clampScrollTop(scroller, top), behavior });
    return true;
  }, [canWrite, scrollerRef]);

  const adjustScrollTop = useCallback((
    writer: 'turn-placement' | 'explicit-navigation',
    delta: number,
  ) => {
    const scroller = scrollerRef.current;
    if (!scroller) return false;
    return setScrollTop(writer, scroller.scrollTop + delta);
  }, [scrollerRef, setScrollTop]);

  const getOwner = useCallback(() => ownerRef.current, []);

  return useMemo(() => ({
    getOwner,
    setFollowingDesired,
    beginTurnPlacement,
    beginStageConsumption,
    finishStageConsumption,
    beginExplicitNavigation,
    handleUserIntent,
    scrollToTail,
    scrollToIndex,
    setScrollTop,
    adjustScrollTop,
  }), [
    adjustScrollTop,
    beginExplicitNavigation,
    beginStageConsumption,
    beginTurnPlacement,
    finishStageConsumption,
    getOwner,
    handleUserIntent,
    scrollToIndex,
    scrollToTail,
    setFollowingDesired,
    setScrollTop,
  ]);
}
