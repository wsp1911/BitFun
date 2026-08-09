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
  const autoCollapse = useFlowChatAutoCollapse();

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
  };
}
