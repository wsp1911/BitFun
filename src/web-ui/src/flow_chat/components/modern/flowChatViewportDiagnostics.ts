export interface FlowChatTurnAnchorGeometry {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  maxScrollTop: number;
  userMessageOffsetFromViewportTop: number | null;
}

export function measureFlowChatTurnAnchorGeometry(
  scroller: HTMLElement,
  turnId: string | null,
): FlowChatTurnAnchorGeometry {
  const scrollerRect = scroller.getBoundingClientRect();
  const userMessage = turnId
    ? Array.from(
      scroller.querySelectorAll<HTMLElement>(
        '.virtual-item-wrapper[data-item-type="user-message"]',
      ),
    ).find(element => element.dataset.turnId === turnId) ?? null
    : null;

  return {
    scrollTop: scroller.scrollTop,
    scrollHeight: scroller.scrollHeight,
    clientHeight: scroller.clientHeight,
    maxScrollTop: Math.max(0, scroller.scrollHeight - scroller.clientHeight),
    userMessageOffsetFromViewportTop: userMessage
      ? userMessage.getBoundingClientRect().top - scrollerRect.top
      : null,
  };
}

