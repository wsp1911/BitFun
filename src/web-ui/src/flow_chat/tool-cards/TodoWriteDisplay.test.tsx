// @vitest-environment jsdom

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';
import { createTodoRenderItems } from './todoRenderItems';
import { TodoWriteDisplay } from './TodoWriteDisplay';
import { FLOWCHAT_COLLAPSE_DURATION_MS } from '../components/modern/flowChatCollapseMotion';

vi.mock('react-i18next', async (importOriginal) => ({
  ...await importOriginal<typeof import('react-i18next')>(),
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('../hooks/useDialogTurnTodos', () => ({
  useDialogTurnTodos: () => [],
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const config: ToolCardConfig = {
  toolName: 'TodoWrite',
  displayName: 'TodoWrite',
  icon: 'list-todo',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
  displayMode: 'standard',
};

function createTodoWriteItem(todos: Array<{
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}>): FlowToolItem {
  return {
    id: 'todo-tool-a',
    type: 'tool',
    toolName: 'TodoWrite',
    timestamp: 1,
    status: 'streaming',
    isParamsStreaming: true,
    partialParams: {
      todos,
    },
    toolCall: {
      id: 'todo-tool-a',
      input: {},
    },
  };
}

describe('createTodoRenderItems', () => {
  it('keeps React render keys unique when restored todos reuse ids', () => {
    const items = createTodoRenderItems([
      { id: '[truncated for session view]', content: 'Phase 1', status: 'completed' },
      { id: '[truncated for session view]', content: 'Phase 2', status: 'completed' },
      { id: 'p3-2', content: 'Phase 3', status: 'pending' },
    ]);

    expect(new Set(items.map(item => item.key)).size).toBe(items.length);
    expect(items.map(item => item.key)).toEqual([
      '[truncated for session view]-0',
      '[truncated for session view]-1',
      'p3-2',
    ]);
  });
});

describe('TodoWriteDisplay collapsed summary', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('stays collapsed and replaces the first task with the in-progress task', () => {
    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem([
        { id: 'todo-a', content: 'First task', status: 'pending' },
        { id: 'todo-b', content: 'Second task', status: 'pending' },
      ])} config={config} />);
    });
    expect(container.querySelector('.todo-expanded-body')).toBeNull();
    expect(container.querySelector('.todo-header-current')?.textContent).toBe('First task');

    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem([
        { id: 'todo-a', content: 'First task', status: 'pending' },
        { id: 'todo-b', content: 'Second task', status: 'in_progress' },
      ])} config={config} />);
    });

    expect(container.querySelector('.todo-expanded-body')).toBeNull();
    expect(container.querySelector('.todo-header-current')?.textContent).toBe('Second task');
  });

  it('still lets the user expand and collapse the full list manually', () => {
    vi.useFakeTimers();
    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem([
        { id: 'todo-a', content: 'First task', status: 'pending' },
        { id: 'todo-b', content: 'Second task', status: 'pending' },
      ])} config={config} />);
    });
    expect(container.querySelector('.todo-expanded-body')).toBeNull();

    act(() => container.querySelector<HTMLElement>('[data-testid="todo-write-toggle"]')?.click());
    expect(container.querySelector('.todo-expanded-body')).not.toBeNull();

    act(() => container.querySelector<HTMLElement>('[data-testid="todo-write-toggle"]')?.click());
    expect(container.querySelector('.todo-write-host')?.getAttribute('data-bf-state')).not.toContain('expanded');
    act(() => vi.advanceTimersByTime(FLOWCHAT_COLLAPSE_DURATION_MS));
    expect(container.querySelector('.todo-expanded-body')).toBeNull();
  });

  it('keeps the completed summary when every task is completed', () => {
    act(() => {
      root.render(<TodoWriteDisplay toolItem={createTodoWriteItem([
        { id: 'todo-a', content: 'First task', status: 'completed' },
        { id: 'todo-b', content: 'Second task', status: 'completed' },
      ])} config={config} />);
    });

    expect(container.querySelector('.todo-header-content--success')?.textContent)
      .toBe('toolCards.todoWrite.allCompleted');
    expect(container.querySelector('.todo-header-current')).toBeNull();
    expect(container.querySelector('.todo-expanded-body')).toBeNull();
  });
});
