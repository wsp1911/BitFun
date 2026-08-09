import { useCallback, useRef, useState } from 'react';
import { useFlowChatAutoCollapse } from '../components/modern/useFlowChatAutoCollapse';
interface UseToolCardHeightContractOptions {
  toolId: string | null | undefined;
  toolName: string;
  getAnchorElement?: () => HTMLElement | null;
}

interface ApplyHeightContractOptions {
  onExpand?: () => void;
}

interface RequestAutoCollapseOptions {
  beforeCollapse?: () => void;
}

export function useToolCardHeightContract({
  toolId: _toolId,
  toolName: _toolName,
  getAnchorElement: _getAnchorElement,
}: UseToolCardHeightContractOptions) {
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
