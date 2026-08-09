import { createContext, useContext } from 'react';

export interface FlowChatAutoCollapseContextValue {
  isManaged: boolean;
  request: (element: HTMLElement, collapse: () => void) => () => void;
}

export const immediateFlowChatAutoCollapseContext: FlowChatAutoCollapseContextValue = {
  isManaged: false,
  request: (_element, collapse) => {
    collapse();
    return () => undefined;
  },
};

export const FlowChatAutoCollapseContext = createContext(
  immediateFlowChatAutoCollapseContext,
);

export const useFlowChatAutoCollapse = () => useContext(FlowChatAutoCollapseContext);
