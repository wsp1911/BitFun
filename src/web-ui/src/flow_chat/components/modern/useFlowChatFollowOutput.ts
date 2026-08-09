import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { flowChatDiagnostics } from '@/infrastructure/diagnostics/flowChatDiagnostics';

export type FollowOutputEnterReason = 'jump-to-latest' | 'new-turn' | 'streaming-resumed';
export type FollowOutputExitReason =
  | 'session-changed'
  | 'user-scroll'
  | 'scroll-to-turn'
  | 'scroll-to-index';

interface UseFlowChatFollowOutputOptions {
  activeSessionId?: string;
  latestTurnId: string | null;
  virtualItemCount: number;
  isStreaming: boolean;
  isViewportActive: boolean;
  scrollerRef: RefObject<HTMLElement | null>;
  scrollToTail: (behavior: ScrollBehavior) => void;
  correctToTail: () => boolean;
  setFollowingDesired: (following: boolean, reason: string) => void;
}

interface UseFlowChatFollowOutputResult {
  isFollowingOutput: boolean;
  enterFollowOutput: (reason: FollowOutputEnterReason) => void;
  exitFollowOutput: (reason: FollowOutputExitReason) => void;
  scheduleFollowToLatest: () => void;
  handleUserScrollIntent: () => void;
  handleScroll: () => void;
}

const BOTTOM_EPSILON_PX = 2;
const FOLLOW_CORRECTION_DIAGNOSTIC_INTERVAL_MS = 1_000;

function naturalTailScrollTop(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

export function useFlowChatFollowOutput({
  activeSessionId,
  latestTurnId,
  virtualItemCount,
  isStreaming,
  isViewportActive,
  scrollerRef,
  scrollToTail,
  correctToTail,
  setFollowingDesired,
}: UseFlowChatFollowOutputOptions): UseFlowChatFollowOutputResult {
  const [isFollowingOutput, setIsFollowingOutput] = useState(false);
  const isFollowingOutputRef = useRef(false);
  const isStreamingRef = useRef(isStreaming);
  const isViewportActiveRef = useRef(isViewportActive);
  const followFrameRef = useRef<number | null>(null);
  const previousSessionIdRef = useRef(activeSessionId);
  const previousLatestTurnIdRef = useRef<string | null>(latestTurnId);
  const hasMountedRef = useRef(false);
  const lastCorrectionDiagnosticAtRef = useRef(Number.NEGATIVE_INFINITY);

  // `enterFollowOutput`/`exitFollowOutput` write `isFollowingOutputRef` ahead of
  // the state so the rAF loop sees the decision immediately. Reconciling all
  // three on commit — not during render — keeps a discarded or interleaved
  // render from publishing a stale value to that loop.
  useLayoutEffect(() => {
    isFollowingOutputRef.current = isFollowingOutput;
    isStreamingRef.current = isStreaming;
    isViewportActiveRef.current = isViewportActive;
  }, [isFollowingOutput, isStreaming, isViewportActive]);

  const stopFollowFrame = useCallback(() => {
    if (followFrameRef.current !== null) {
      cancelAnimationFrame(followFrameRef.current);
      followFrameRef.current = null;
    }
  }, []);

  const runFollowFrame = useCallback(() => {
    followFrameRef.current = null;
    if (
      !isFollowingOutputRef.current ||
      !isStreamingRef.current ||
      !isViewportActiveRef.current ||
      document.hidden
    ) {
      return;
    }

    const scroller = scrollerRef.current;
    if (scroller) {
      const target = naturalTailScrollTop(scroller);
      if (Math.abs(target - scroller.scrollTop) > BOTTOM_EPSILON_PX) {
        const scrollTopBefore = scroller.scrollTop;
        if (!correctToTail()) {
          return;
        }
        const now = typeof performance === 'undefined' ? Date.now() : performance.now();
        if (now - lastCorrectionDiagnosticAtRef.current >= FOLLOW_CORRECTION_DIAGNOSTIC_INTERVAL_MS) {
          lastCorrectionDiagnosticAtRef.current = now;
          flowChatDiagnostics.trace({
            hypothesis: 'FOLLOW',
            location: 'useFlowChatFollowOutput.runFollowFrame',
            message: 'Follow output corrected the natural tail',
            data: () => ({
              sessionId: activeSessionId ?? null,
              latestTurnId,
              scrollTopBefore,
              scrollTopAfter: target,
              correctionPx: target - scrollTopBefore,
              scrollHeight: scroller.scrollHeight,
              clientHeight: scroller.clientHeight,
            }),
          });
        }
      }
    }
    followFrameRef.current = requestAnimationFrame(runFollowFrame);
  }, [activeSessionId, correctToTail, latestTurnId, scrollerRef]);

  const startFollowFrame = useCallback(() => {
    if (followFrameRef.current === null && isFollowingOutputRef.current && isStreamingRef.current) {
      followFrameRef.current = requestAnimationFrame(runFollowFrame);
    }
  }, [runFollowFrame]);

  const enterFollowOutput = useCallback((reason: FollowOutputEnterReason) => {
    if (!isViewportActiveRef.current) {
      flowChatDiagnostics.trace({
        hypothesis: 'FOLLOW',
        location: 'useFlowChatFollowOutput.enterFollowOutput',
        message: 'Follow output entry rejected for an inactive viewport',
        data: () => ({ reason, sessionId: activeSessionId ?? null, latestTurnId }),
      });
      return;
    }
    const wasFollowing = isFollowingOutputRef.current;
    isFollowingOutputRef.current = true;
    setFollowingDesired(true, reason);
    setIsFollowingOutput(true);
    flowChatDiagnostics.trace({
      hypothesis: 'FOLLOW',
      location: 'useFlowChatFollowOutput.enterFollowOutput',
      message: 'Follow output ownership entered',
      data: () => ({
        reason,
        wasFollowing,
        sessionId: activeSessionId ?? null,
        latestTurnId,
        isStreaming: isStreamingRef.current,
      }),
    });
    scrollToTail(reason === 'jump-to-latest' ? 'smooth' : 'auto');
    startFollowFrame();
  }, [activeSessionId, latestTurnId, scrollToTail, setFollowingDesired, startFollowFrame]);

  const exitFollowOutput = useCallback((reason: FollowOutputExitReason) => {
    const wasFollowing = isFollowingOutputRef.current;
    isFollowingOutputRef.current = false;
    setFollowingDesired(false, reason);
    setIsFollowingOutput(false);
    stopFollowFrame();
    if (wasFollowing) {
      const scroller = scrollerRef.current;
      flowChatDiagnostics.trace({
        hypothesis: 'FOLLOW',
        location: 'useFlowChatFollowOutput.exitFollowOutput',
        message: 'Follow output ownership exited',
        data: () => ({
          reason,
          sessionId: activeSessionId ?? null,
          latestTurnId,
          scrollTop: scroller?.scrollTop ?? null,
          distanceFromNaturalTail: scroller
            ? naturalTailScrollTop(scroller) - scroller.scrollTop
            : null,
        }),
      });
    }
  }, [activeSessionId, latestTurnId, scrollerRef, setFollowingDesired, stopFollowFrame]);

  const scheduleFollowToLatest = useCallback(() => {
    if (
      !isFollowingOutputRef.current ||
      !isViewportActiveRef.current
    ) {
      return;
    }
    scrollToTail('auto');
    startFollowFrame();
  }, [scrollToTail, startFollowFrame]);

  const handleUserScrollIntent = useCallback(() => {
    exitFollowOutput('user-scroll');
  }, [exitFollowOutput]);

  const handleScroll = useCallback(() => {
    // Scroll events describe the resulting viewport position, but do not prove user intent.
    // Layout growth and virtualizer remeasurement can emit them while output follow still owns
    // the viewport. Explicit wheel, touch, and keyboard handlers release that ownership instead.
  }, []);

  useEffect(() => {
    if (!hasMountedRef.current) {
      hasMountedRef.current = true;
      if (isStreaming && virtualItemCount > 0) {
        enterFollowOutput('streaming-resumed');
      }
      return;
    }

    if (previousSessionIdRef.current !== activeSessionId) {
      previousSessionIdRef.current = activeSessionId;
      previousLatestTurnIdRef.current = latestTurnId;
      exitFollowOutput('session-changed');
      if (isStreaming && virtualItemCount > 0) {
        enterFollowOutput('streaming-resumed');
      }
      return;
    }

    const isNewTurn = Boolean(latestTurnId && latestTurnId !== previousLatestTurnIdRef.current);
    previousLatestTurnIdRef.current = latestTurnId;
    if (isNewTurn && virtualItemCount > 0) {
      enterFollowOutput('new-turn');
    }
  }, [
    activeSessionId,
    enterFollowOutput,
    exitFollowOutput,
    isStreaming,
    latestTurnId,
    virtualItemCount,
  ]);

  useEffect(() => {
    if (!isViewportActive) {
      stopFollowFrame();
      return;
    }
    if (isFollowingOutput && isStreaming) {
      scheduleFollowToLatest();
    }
  }, [isFollowingOutput, isStreaming, isViewportActive, scheduleFollowToLatest, stopFollowFrame]);

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        scheduleFollowToLatest();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [scheduleFollowToLatest]);

  useEffect(() => stopFollowFrame, [stopFollowFrame]);

  return {
    isFollowingOutput,
    enterFollowOutput,
    exitFollowOutput,
    scheduleFollowToLatest,
    handleUserScrollIntent,
    handleScroll,
  };
}
