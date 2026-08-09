import { useCallback, useRef, useState } from 'react';
import { useFlowChatAutoCollapse } from '../components/modern/useFlowChatAutoCollapse';

interface ApplyHeightContractOptions {
  onExpand?: () => void;
}

interface RequestAutoCollapseOptions {
  beforeCollapse?: () => void;
}

/**
 * Card-side half of the automatic collapse contract: it owns the card root ref
 * and forwards collapse requests to the FlowChat coordinator, which decides
 * when the card is far enough outside the viewport to collapse silently.
 */
export function useToolCardHeightContract() {
  const cardRootRef = useRef<HTMLDivElement>(null);
  const [isAutoCollapseInstant, setIsAutoCollapseInstant] = useState(false);
  const [hasUserExpandedSettled, setHasUserExpandedSettled] = useState(false);
  const autoCollapse = useFlowChatAutoCollapse();

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
  }, []);

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
  };
}
