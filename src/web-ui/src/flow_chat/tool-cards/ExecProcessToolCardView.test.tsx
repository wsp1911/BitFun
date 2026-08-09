import React from 'react';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';

import { ExecProcessToolCardView, type ExecProcessCardModel } from './ExecProcessToolCardView';
import { clearToolCardExpansionMemory } from './toolCardExpansionMemory';
import { FlowChatAutoCollapseContext } from '../components/modern/useFlowChatAutoCollapse';
import type { FlowToolItem } from '../types/flow-chat';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const messages: Record<string, string> = {
  'toolCards.terminal.cancelled': 'Cancelled',
  'toolCards.terminal.rejected': 'Rejected',
  'toolCards.terminal.receivingParams': 'Receiving parameters...',
  'toolCards.terminal.exitCode': 'Exit code: {{code}}',
  'toolCards.approval.waiting': 'Waiting for confirmation',
  'toolCards.execProcess.copyPrimary': 'Copy',
  'toolCards.execProcess.primaryCopied': 'Copied',
  'toolCards.execProcess.copyPrimaryFailed': 'Failed to copy',
};

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return {
    ...actual,
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const template = messages[key] ?? key;
        return template.replace(/{{(\w+)}}/g, (_, name) => String(options?.[name] ?? ''));
      },
    }),
  };
});

vi.mock('../../component-library', () => ({
  DotMatrixLoader: () => <span data-testid="dot-matrix-loader" />,
  ToolProcessingDots: () => <span data-testid="tool-processing-dots" />,
  IconButton: ({
    children,
    tooltip,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { tooltip?: React.ReactNode }) => (
    <button
      type="button"
      title={typeof tooltip === 'string' ? tooltip : undefined}
      {...props}
    >
      {children}
    </button>
  ),
}));

const mocks = vi.hoisted(() => ({
  outputRendererProps: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/tools/terminal/components/LazyTerminalOutputRenderer', () => ({
  LazyTerminalOutputRenderer: React.forwardRef<
    { getVisibleText: () => string },
    { content: string; className?: string; maxRows?: number }
  >((props, ref) => {
    const { content, className } = props;
    mocks.outputRendererProps.push(props as unknown as Record<string, unknown>);
    React.useImperativeHandle(ref, () => ({ getVisibleText: () => content }), [content]);
    return <pre className={className}>{content}</pre>;
  }),
}));

const model: ExecProcessCardModel = {
  kind: 'command',
  actionLabel: 'Run command:',
  primaryText: 'npm test',
  emptyText: '[No command]',
  copyText: 'npm test',
  waitingText: 'Running command...',
  noOutputText: 'No output',
  resultOutput: '',
};

function toolItem(status: FlowToolItem['status'], isParamsStreaming = false): FlowToolItem {
  return {
    id: 'tool-exec-1',
    type: 'tool',
    toolName: 'ExecCommand',
    status,
    timestamp: Date.now(),
    isParamsStreaming,
    toolCall: {
      id: 'call-exec-1',
      input: { cmd: 'npm test' },
    },
  };
}

describe('ExecProcessToolCardView', () => {
  let dom: JSDOM;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    // Card expansion memory is module-level; a shared card id would
    // otherwise carry state from one test into the next.
    clearToolCardExpansionMemory();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', {
      pretendToBeVisual: true,
    });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('CustomEvent', dom.window.CustomEvent);
    vi.stubGlobal('ResizeObserver', class {
      observe = vi.fn();
      disconnect = vi.fn();
    });

    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
    mocks.outputRendererProps = [];
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shows cancelled state instead of receiving params when a stale streaming flag remains', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('running', true)} model={model} />);
    });

    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('cancelled', true)} model={model} />);
    });

    expect(container.textContent).toContain('Cancelled');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('shows rejected state for user-rejected command confirmation', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('rejected', true)} model={model} />);
    });

    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('keeps legacy cancelled rejection state labeled as rejected', () => {
    act(() => {
      root.render(
        <ExecProcessToolCardView
          toolItem={{
            ...toolItem('cancelled', true),
            userConfirmed: false,
          }}
          model={model}
        />,
      );
    });

    expect(container.textContent).toContain('Rejected');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('shows waiting confirmation instead of receiving params while confirmation is pending', () => {
    act(() => {
      root.render(<ExecProcessToolCardView toolItem={toolItem('pending_confirmation', true)} model={model} />);
    });

    expect(container.querySelector('.base-tool-card')).not.toBeNull();
    expect(container.querySelector('.compact-tool-card')).toBeNull();
    expect(container.textContent).toContain('Waiting for confirmation');
    expect(container.textContent).not.toContain('Receiving parameters...');
  });

  it('keeps the BaseToolCard shell and its output when a command completes', () => {
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'All tests passed',
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView toolItem={toolItem('running')} model={resultModel} />,
      );
    });

    expect(container.querySelector('.base-tool-card')).not.toBeNull();
    expect(container.querySelector('.compact-tool-card')).toBeNull();

    act(() => {
      root.render(
        <ExecProcessToolCardView toolItem={toolItem('completed')} model={resultModel} />,
      );
    });

    // Collapsed cards keep the BaseToolCard shell and animate height closed.
    expect(container.querySelector('.base-tool-card')).not.toBeNull();
    expect(container.querySelector('.base-tool-card.expanded')).toBeNull();
    expect(container.querySelector('.compact-tool-card')).toBeNull();
    expect(container.textContent).toContain('All tests passed');
  });

  it('requests the collapse of a completed result without waiting on a timer', () => {
    vi.useFakeTimers();
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'All tests passed',
    };

    act(() => {
      root.render(
        <ExecProcessToolCardView toolItem={toolItem('running')} model={resultModel} />,
      );
    });

    act(() => {
      root.render(
        <ExecProcessToolCardView toolItem={toolItem('completed')} model={resultModel} />,
      );
    });

    // No collapse coordinator is mounted here, so the request runs immediately
    // instead of being held until the card leaves the viewport.
    expect(container.querySelector('.base-tool-card.expanded')).toBeNull();
    expect(container.querySelector('.terminal-result-container')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(container.querySelector('.terminal-result-container')).not.toBeNull();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(container.querySelector('.terminal-result-container')).toBeNull();
  });

  // The card used to swap whole regions at completion — running indicator out,
  // output and footer in — so its height dipped between the two commits and the
  // browser moved the transcript under the reader to compensate.
  describe('keeping its height across completion', () => {
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'ok',
      exitCode: 0,
      wallTimeSeconds: 1.5,
    };
    const slot = () => container.querySelector<HTMLElement>('[data-bf-part="outputSlot"]');
    const footer = () => container.querySelector('[data-bf-part="footer"]');
    // A card mounted straight at `completed` starts collapsed, so the body only
    // exists on the path a running command actually takes.
    const runThenComplete = () => {
      act(() => {
        root.render(<ExecProcessToolCardView toolItem={toolItem('running')} model={model} />);
      });
      act(() => {
        root.render(<ExecProcessToolCardView toolItem={toolItem('completed')} model={resultModel} />);
      });
    };

    it('renders the same body regions while running as when completed', () => {
      act(() => {
        root.render(<ExecProcessToolCardView toolItem={toolItem('running')} model={model} />);
      });
      expect(container.querySelector('[data-bf-part="result"]')).not.toBeNull();
      expect(slot()).not.toBeNull();
      expect(footer()).not.toBeNull();

      const reservedWhileRunning = slot()?.style.minHeight;
      expect(reservedWhileRunning).toMatch(/^\d+(\.\d+)?px$/);

      act(() => {
        root.render(<ExecProcessToolCardView toolItem={toolItem('completed')} model={resultModel} />);
      });

      expect(container.querySelector('[data-bf-part="result"]')).not.toBeNull();
      expect(footer()).not.toBeNull();
      expect(slot()?.style.minHeight).toBe(reservedWhileRunning);
    });

    it('reserves the streaming row count for the output renderer itself', () => {
      runThenComplete();

      const reservedPx = Number.parseFloat(slot()?.style.minHeight ?? '0');
      expect(reservedPx).toBeGreaterThan(0);
      // A one-line result must not leave the renderer shorter than the box the
      // card reserved while it was streaming.
      expect(mocks.outputRendererProps.at(-1)?.minHeight).toBe(reservedPx);
    });

    it('shows the waiting placeholder inside the reserved area rather than instead of it', () => {
      act(() => {
        root.render(<ExecProcessToolCardView toolItem={toolItem('running')} model={model} />);
      });

      expect(slot()?.textContent).toContain('Running command...');
    });

    it('leaves elapsed and final duration to the header', () => {
      runThenComplete();

      expect(footer()?.querySelector('.terminal-execution-time')).toBeNull();
      expect(footer()?.textContent).toContain('Exit code: 0');
    });
  });

  describe('with a deferred collapse coordinator', () => {
    // The coordinator accepts the collapse request but never runs it, which is
    // what happens while the card is still inside the viewport.
    const deferredAutoCollapse = {
      isManaged: true,
      request: () => () => undefined,
    };
    const resultModel: ExecProcessCardModel = {
      ...model,
      resultOutput: 'line 1\nline 2\nline 3\nline 4\nline 5\nline 6',
    };
    const renderCard = (status: FlowToolItem['status']) => (
      <FlowChatAutoCollapseContext.Provider value={deferredAutoCollapse}>
        <ExecProcessToolCardView toolItem={toolItem(status)} model={resultModel} />
      </FlowChatAutoCollapseContext.Provider>
    );
    const lastMaxRows = () => mocks.outputRendererProps.at(-1)?.maxRows;

    it('keeps the streaming row count while an auto-expanded card stays open', () => {
      act(() => {
        root.render(renderCard('running'));
      });
      act(() => {
        root.render(renderCard('completed'));
      });

      expect(container.querySelector('.base-tool-card.expanded')).not.toBeNull();
      expect(lastMaxRows()).toBe(4);
    });

    it('uses the comfortable row count once the user expands a settled card', () => {
      act(() => {
        root.render(renderCard('running'));
      });
      act(() => {
        root.render(renderCard('completed'));
      });

      const card = container.querySelector('.base-tool-card') as HTMLElement | null;
      // Collapse, then reopen: only the reopen counts as "show me everything".
      act(() => {
        card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      act(() => {
        card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });

      expect(container.querySelector('.base-tool-card.expanded')).not.toBeNull();
      expect(lastMaxRows()).toBe(15);
    });

    // An explore group absorbing a round unmounts the round's cards and
    // remounts them inside the group. Re-deriving the default there would
    // collapse a settled card in the viewport, bypassing the coordinator.
    it('restores what it showed across a remount instead of re-deriving it', () => {
      act(() => {
        root.render(renderCard('running'));
      });
      expect(container.querySelector('.base-tool-card.expanded')).not.toBeNull();

      act(() => root.unmount());
      root = createRoot(container);
      act(() => {
        root.render(renderCard('completed'));
      });

      expect(container.querySelector('.base-tool-card.expanded')).not.toBeNull();
    });

    it('mounts a settled card collapsed when it has never been shown', () => {
      act(() => {
        root.render(renderCard('completed'));
      });

      expect(container.querySelector('.base-tool-card.expanded')).toBeNull();
    });

    it('keeps a user collapse across a remount instead of auto-expanding again', () => {
      act(() => {
        root.render(renderCard('running'));
      });
      const card = container.querySelector('.base-tool-card') as HTMLElement | null;
      act(() => {
        card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      expect(container.querySelector('.base-tool-card.expanded')).toBeNull();

      act(() => root.unmount());
      root = createRoot(container);
      act(() => {
        root.render(renderCard('running'));
      });

      expect(container.querySelector('.base-tool-card.expanded')).toBeNull();
    });

    it('does not treat a toggle made while running as a request for the full output', () => {
      act(() => {
        root.render(renderCard('running'));
      });

      const card = container.querySelector('.base-tool-card') as HTMLElement | null;
      act(() => {
        card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });
      act(() => {
        card?.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
      });

      act(() => {
        root.render(renderCard('completed'));
      });

      expect(container.querySelector('.base-tool-card.expanded')).not.toBeNull();
      expect(lastMaxRows()).toBe(4);
    });
  });
});
