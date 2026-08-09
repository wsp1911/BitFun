// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FlowToolItem, ToolCardConfig } from '../types/flow-chat';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (
      options?.count === undefined ? key : `${key}:${String(options.count)}`
    ),
  }),
}));

vi.mock('@/component-library', () => ({
  Button: ({
    children,
    isLoading: _isLoading,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { isLoading?: boolean }) => (
    <button type="button" {...props}>{children}</button>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('@/infrastructure/api/service-api/ToolAPI', () => ({
  toolAPI: {
    submitUserAnswers: vi.fn(),
  },
}));

import { AskUserQuestionCard } from './AskUserQuestionCard';
import { toolAPI } from '@/infrastructure/api/service-api/ToolAPI';
import { FlowChatAutoCollapseContext } from '../components/modern/useFlowChatAutoCollapse';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const config: ToolCardConfig = {
  toolName: 'AskUserQuestion',
  displayName: 'Ask User',
  icon: 'Q',
  requiresConfirmation: false,
  resultDisplayType: 'detailed',
};

function questionTool(status: FlowToolItem['status']): FlowToolItem {
  return {
    id: 'question-tool-1',
    type: 'tool',
    toolName: 'AskUserQuestion',
    timestamp: 1,
    status,
    toolCall: {
      id: 'question-call-1',
      input: {
        questions: [{
          header: 'Database',
          question: 'Which database?',
          multiSelect: false,
          options: [{
            label: 'PostgreSQL',
            description: 'Use PostgreSQL',
          }],
        }],
      },
    },
    ...(status === 'completed'
      ? {
          toolResult: {
            success: true,
            result: {
              answers: {
                0: 'PostgreSQL',
              },
            },
          },
        }
      : {}),
  };
}

describe('AskUserQuestionCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps a just-completed tail question visible until newer content arrives', () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('.questions-container')).not.toBeNull();
    expect(container.querySelector('.completed-summary')).toBeNull();

    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('completed')}
          config={config}
          isLastItem
        />,
      );
    });
    expect(container.querySelector('.questions-container')).not.toBeNull();
    expect(container.querySelector('.completed-summary')).toBeNull();

    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('completed')}
          config={config}
          isLastItem={false}
        />,
      );
    });
    expect(container.querySelector('.completed-summary')).not.toBeNull();
  });

  it('stops offering submit once the answer is in flight, without dropping the footer', async () => {
    act(() => {
      root.render(
        <AskUserQuestionCard
          toolItem={questionTool('pending_confirmation')}
          config={config}
          isLastItem
        />,
      );
    });

    act(() => {
      (container.querySelector('input[type="radio"]') as HTMLInputElement).click();
    });
    await act(async () => {
      (container.querySelector('.submit-button') as HTMLButtonElement).click();
    });

    expect(toolAPI.submitUserAnswers).toHaveBeenCalledOnce();
    // The backend has not marked the tool completed yet, so the form is still
    // the rendered shape — but its action is gone and its height is held.
    expect(container.querySelector('.questions-container')).not.toBeNull();
    expect(container.querySelector('.card-footer-row')).not.toBeNull();
    expect(container.querySelector('.submit-button')).toBeNull();
  });

  it('stops offering submit on a completed question the coordinator has not collapsed', () => {
    // The coordinator accepts the collapse request but never runs it, which is
    // what happens while the card is still inside the viewport.
    const deferredAutoCollapse = { isManaged: true, request: () => () => undefined };

    const render = (status: FlowToolItem['status'], isLastItem: boolean) => (
      <FlowChatAutoCollapseContext.Provider value={deferredAutoCollapse}>
        <AskUserQuestionCard
          toolItem={questionTool(status)}
          config={config}
          isLastItem={isLastItem}
        />
      </FlowChatAutoCollapseContext.Provider>
    );

    act(() => root.render(render('pending_confirmation', true)));
    // Completed and no longer the tail: the collapse to the compact summary is
    // requested, but the coordinator holds it while the card is on screen.
    act(() => root.render(render('completed', false)));

    expect(container.querySelector('.completed-summary')).toBeNull();
    expect(container.querySelector('.card-footer-row')).not.toBeNull();
    expect(container.querySelector('.submit-button')).toBeNull();
  });
});
