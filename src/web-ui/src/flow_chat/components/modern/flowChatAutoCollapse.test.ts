import { describe, expect, it } from 'vitest';
import {
  getFlowChatAutoCollapseDecision,
  isFlowChatAutoCollapseEligible,
} from './flowChatAutoCollapse';

const geometry = { cardTop: 0, cardBottom: 10, viewportTop: 100, viewportBottom: 500 };

describe('flowChatAutoCollapse', () => {
  it('allows fully outside cards while following output', () => {
    expect(isFlowChatAutoCollapseEligible({ ...geometry, isFollowingOutput: true, isAtNaturalTail: false })).toBe(true);
    expect(isFlowChatAutoCollapseEligible({ ...geometry, cardTop: 600, cardBottom: 700, isFollowingOutput: true, isAtNaturalTail: false })).toBe(true);
    expect(isFlowChatAutoCollapseEligible({ ...geometry, cardTop: 490, cardBottom: 510, isFollowingOutput: true, isAtNaturalTail: false })).toBe(false);
  });

  it('only allows below-viewport cards away from the natural tail when not following', () => {
    expect(isFlowChatAutoCollapseEligible({ ...geometry, isFollowingOutput: false, isAtNaturalTail: false })).toBe(false);
    expect(isFlowChatAutoCollapseEligible({ ...geometry, cardTop: 600, cardBottom: 700, isFollowingOutput: false, isAtNaturalTail: false })).toBe(true);
    expect(isFlowChatAutoCollapseEligible({ ...geometry, cardTop: 600, cardBottom: 700, isFollowingOutput: false, isAtNaturalTail: true })).toBe(false);
  });

  it('returns stable waiting reasons for diagnostics', () => {
    expect(getFlowChatAutoCollapseDecision({
      ...geometry,
      isFollowingOutput: false,
      isAtNaturalTail: false,
    })).toBe('above-without-follow');
    expect(getFlowChatAutoCollapseDecision({
      ...geometry,
      cardTop: 600,
      cardBottom: 700,
      isFollowingOutput: false,
      isAtNaturalTail: true,
    })).toBe('below-at-natural-tail');
    expect(getFlowChatAutoCollapseDecision({
      ...geometry,
      cardTop: 490,
      cardBottom: 510,
      isFollowingOutput: true,
      isAtNaturalTail: false,
    })).toBe('intersects-viewport');
  });
});
