import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { useFlowChatAutoCollapse } from '../components/modern/useFlowChatAutoCollapse';
import {
  readToolCardExpansionMemo,
  rememberToolCardExpansion,
} from './toolCardExpansionMemory';

interface ApplyHeightContractOptions {
  onExpand?: () => void;
}

interface RequestAutoCollapseOptions {
  beforeCollapse?: () => void;
}

interface ToolCardHeightContractOptions {
  /**
   * Stable item id. Supplying it — together with `isExpanded` — lets the card
   * restore what it showed across a remount instead of re-deriving it. See
   * `toolCardExpansionMemory`.
   */
  cardId?: string;
  /** The card's current expanded state, recorded on every commit. */
  isExpanded?: boolean;
}

/**
 * Card-side half of the automatic collapse contract: it owns the card root ref
 * and forwards collapse requests to the FlowChat coordinator, which decides
 * when the card is far enough outside the viewport to collapse silently.
 */
export function useToolCardHeightContract(options: ToolCardHeightContractOptions = {}) {
  const { cardId, isExpanded } = options;
  const cardRootRef = useRef<HTMLDivElement>(null);
  const [isAutoCollapseInstant, setIsAutoCollapseInstant] = useState(false);
  const [hasUserExpandedSettled, setHasUserExpandedSettled] = useState(
    () => readToolCardExpansionMemo(cardId)?.hasUserExpandedSettled ?? false,
  );
  const isUserControlledRef = useRef(
    readToolCardExpansionMemo(cardId)?.isUserControlled ?? false,
  );
  const autoCollapse = useFlowChatAutoCollapse();

  useLayoutEffect(() => {
    if (isExpanded === undefined) return;
    rememberToolCardExpansion(cardId, { isExpanded });
  }, [cardId, isExpanded]);

  /**
   * The card reports that this state came from the user, not from its own
   * defaults. It outlives a remount, so scrolling a card out of the virtual
   * window and back does not hand it back to automatic control.
   */
  const markUserControlled = useCallback(() => {
    isUserControlledRef.current = true;
    rememberToolCardExpansion(cardId, { isUserControlled: true });
  }, [cardId]);

  const isUserControlled = useCallback(() => isUserControlledRef.current, []);

  /**
   * Cards with a compact and a comfortable size must only grow when the user
   * asked to read the finished result. Every other expanded state — streaming,
   * and the window where the coordinator is holding a collapse request — keeps
   * the compact size, so a card never changes height on its own.
   *
   * The card owns what "settled" means (completed status, finished stream, …)
   * and calls this from its own toggle handler.
   */
  const markUserExpandedSettled = useCallback(() => {
    setHasUserExpandedSettled(true);
    rememberToolCardExpansion(cardId, { hasUserExpandedSettled: true });
  }, [cardId]);

  const dispatchToolCardToggle = useCallback(() => {
    window.dispatchEvent(new CustomEvent('tool-card-toggle'));
  }, []);

  const applyExpandedState = useCallback((
    currentExpanded: boolean,
    nextExpanded: boolean,
    setExpanded: (nextExpanded: boolean) => void,
    options?: ApplyHeightContractOptions,
  ) => {
    setIsAutoCollapseInstant(false);
    if (nextExpanded !== currentExpanded) {
      setExpanded(nextExpanded);
      dispatchToolCardToggle();
    }

    if (nextExpanded) {
      options?.onExpand?.();
    }
  }, [dispatchToolCardToggle]);

  const requestAutoCollapse = useCallback((
    currentExpanded: boolean,
    setExpanded: (nextExpanded: boolean) => void,
    options?: RequestAutoCollapseOptions,
  ) => {
    if (!currentExpanded) return () => undefined;

    const collapse = () => {
      setIsAutoCollapseInstant(true);
      options?.beforeCollapse?.();
      setExpanded(false);
      dispatchToolCardToggle();
    };
    const element = cardRootRef.current;
    if (!autoCollapse.isManaged) {
      setExpanded(false);
      dispatchToolCardToggle();
      return () => undefined;
    }
    if (!element) {
      collapse();
      return () => undefined;
    }
    return autoCollapse.request(element, collapse);
  }, [autoCollapse, dispatchToolCardToggle]);

  return {
    cardRootRef,
    dispatchToolCardToggle,
    applyExpandedState,
    requestAutoCollapse,
    isAutoCollapseInstant,
    hasUserExpandedSettled,
    markUserExpandedSettled,
    isUserControlled,
    markUserControlled,
  };
}
