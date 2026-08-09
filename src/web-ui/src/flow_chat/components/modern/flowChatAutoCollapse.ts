export interface FlowChatAutoCollapseGeometry {
  cardTop: number;
  cardBottom: number;
  viewportTop: number;
  viewportBottom: number;
}

export interface FlowChatAutoCollapseEligibilityInput extends FlowChatAutoCollapseGeometry {
  isFollowingOutput: boolean;
  isAtNaturalTail: boolean;
}

export type FlowChatAutoCollapseDecision =
  | 'eligible'
  | 'intersects-viewport'
  | 'above-without-follow'
  | 'below-at-natural-tail';

export function getFlowChatAutoCollapseDecision({
  cardTop,
  cardBottom,
  viewportTop,
  viewportBottom,
  isFollowingOutput,
  isAtNaturalTail,
}: FlowChatAutoCollapseEligibilityInput): FlowChatAutoCollapseDecision {
  const fullyAbove = cardBottom <= viewportTop;
  const fullyBelow = cardTop >= viewportBottom;

  if (isFollowingOutput) {
    return fullyAbove || fullyBelow ? 'eligible' : 'intersects-viewport';
  }

  if (fullyAbove) return 'above-without-follow';
  if (!fullyBelow) return 'intersects-viewport';
  return isAtNaturalTail ? 'below-at-natural-tail' : 'eligible';
}

export function isFlowChatAutoCollapseEligible(
  input: FlowChatAutoCollapseEligibilityInput,
): boolean {
  return getFlowChatAutoCollapseDecision(input) === 'eligible';
}
