// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ModelThinkingDisplay } from './ModelThinkingDisplay';
import { clearToolCardExpansionMemory } from './toolCardExpansionMemory';
import { FlowChatAutoCollapseContext } from '../components/modern/useFlowChatAutoCollapse';
import type { FlowThinkingItem } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('../hooks/useTypewriter', () => ({
  useTypewriter: (content: string) => ({ displayText: content, isRevealing: false }),
}));

vi.mock('../hooks/typewriterRevealGateContext', () => ({
  useReportTypewriterReveal: vi.fn(),
}));

vi.mock('@/component-library/components/Markdown/Markdown', () => ({
  Markdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

// The coordinator accepts the collapse request but never runs it, which is what
// happens while the card is still inside the viewport.
const deferredAutoCollapse = {
  isManaged: true,
  request: () => () => undefined,
};

function thinkingItem(isStreaming: boolean): FlowThinkingItem {
  return {
    id: 'thinking-1',
    type: 'thinking',
    content: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7\nline 8',
    isStreaming,
    status: isStreaming ? 'streaming' : 'completed',
  } as FlowThinkingItem;
}

describe('ModelThinkingDisplay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Card expansion memory is module-level; a shared card id would
    // otherwise carry state from one test into the next.
    clearToolCardExpansionMemory();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('ResizeObserver', class {
      observe() {}
      unobserve() {}
      disconnect() {}
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const renderCard = (isStreaming: boolean, isLastItem = true) => (
    <FlowChatAutoCollapseContext.Provider value={deferredAutoCollapse}>
      <ModelThinkingDisplay thinkingItem={thinkingItem(isStreaming)} isLastItem={isLastItem} />
    </FlowChatAutoCollapseContext.Provider>
  );
  const content = () => container.querySelector('[data-testid="chat-thinking-content"]');
  const isComfortable = () => content()?.classList.contains('thinking-content--comfortable');

  // An explore group absorbing a round unmounts the round's cards and remounts
  // them inside the group, where they are no longer the last item. Re-deriving
  // the default there would collapse the card in the viewport without ever
  // asking the coordinator.
  it('restores what it showed across a remount instead of re-deriving it', () => {
    act(() => root.render(renderCard(true)));
    expect(container.firstElementChild?.getAttribute('data-expanded')).toBe('true');

    act(() => root.unmount());
    container.remove();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    // Fresh mount, settled, no longer the last item: the shape of an absorption.
    act(() => root.render(renderCard(false, false)));

    expect(container.firstElementChild?.getAttribute('data-expanded')).toBe('true');
  });

  it('mounts collapsed when the card has never been shown', () => {
    act(() => root.render(renderCard(false, false)));

    expect(container.firstElementChild?.getAttribute('data-expanded')).toBe('false');
  });

  it('keeps the compact height across streaming and settling', () => {
    act(() => root.render(renderCard(true)));
    expect(isComfortable()).toBe(false);

    act(() => root.render(renderCard(false)));
    expect(content()).not.toBeNull();
    expect(isComfortable()).toBe(false);
  });

  it('keeps the compact height while a deferred collapse leaves the card open', () => {
    act(() => root.render(renderCard(true)));
    // No longer the last item: the collapse is requested but the coordinator
    // holds it, so the card stays expanded in the viewport.
    act(() => root.render(renderCard(false, false)));

    expect(container.firstElementChild?.getAttribute('data-expanded')).toBe('true');
    expect(isComfortable()).toBe(false);
  });

  it('uses the reading height once the user expands finished thinking', () => {
    act(() => root.render(renderCard(true)));
    act(() => root.render(renderCard(false)));

    const toggle = container.querySelector('[data-testid="chat-thinking-toggle"]') as HTMLElement;
    // Collapse, then reopen: only the reopen counts as "let me read this".
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    expect(container.firstElementChild?.getAttribute('data-expanded')).toBe('true');
    expect(isComfortable()).toBe(true);
  });

  it('does not treat a toggle made while streaming as a request to read', () => {
    act(() => root.render(renderCard(true)));

    const toggle = container.querySelector('[data-testid="chat-thinking-toggle"]') as HTMLElement;
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    act(() => toggle.dispatchEvent(new MouseEvent('click', { bubbles: true })));

    act(() => root.render(renderCard(false)));

    expect(container.firstElementChild?.getAttribute('data-expanded')).toBe('true');
    expect(isComfortable()).toBe(false);
  });
});
