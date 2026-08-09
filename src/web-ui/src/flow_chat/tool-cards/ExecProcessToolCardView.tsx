import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Terminal } from 'lucide-react';
import type { FlowToolItem } from '../types/flow-chat';
import {
  LazyTerminalOutputRenderer,
  type TerminalOutputRendererHandle,
} from '@/tools/terminal/components/LazyTerminalOutputRenderer';
import { getEstimatedTerminalOutputRowHeight } from '@/tools/terminal/components/terminalOutputPresentation';
import { BaseToolCard, ToolCardHeader } from './BaseToolCard';
import { ToolCardCopyAction, ToolCardHeaderActions } from './ToolCardHeaderActions';
import { CopyableTextPreview } from '../components/CopyableTextPreview';
import { ToolTimeoutIndicator } from './ToolTimeoutIndicator';
import { DotMatrixLoader } from '../../component-library';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import { resolveToolCardExpanded } from './toolCardExpansionMemory';
import { formatSessionViewPreviewText } from '../utils/sessionViewPreview';
import './ExecProcessToolCard.scss';

const EXEC_COLLAPSED_STATUSES = new Set(['completed', 'cancelled', 'error', 'rejected']);
const EXEC_OUTPUT_STREAMING_MAX_ROWS = 4;
const EXEC_OUTPUT_EXPANDED_MAX_ROWS = 15;

/**
 * The compact card reserves exactly the rows it is allowed to show, so the
 * output area is the same height whether it holds four rows of streaming
 * output, one line of result, or a "running" placeholder. Row height depends on
 * the device pixel ratio, so it is read rather than hard-coded.
 */
function getExecOutputReservedHeightPx(): number {
  return EXEC_OUTPUT_STREAMING_MAX_ROWS * getEstimatedTerminalOutputRowHeight();
}

export interface ExecProcessCardModel {
  kind: 'command' | 'stdin' | 'control';
  actionLabel: string;
  primaryText: string;
  emptyText: string;
  copyText: string;
  copyDisabled?: boolean;
  waitingText: string;
  noOutputText: string;
  resultNoticeText?: string;
  resultOutput: string;
  workdir?: string;
  sessionId?: number;
  exitCode?: number;
  wallTimeSeconds?: number;
  remote?: boolean;
  tty?: boolean;
}

interface ExecProcessToolCardViewProps {
  toolItem: FlowToolItem;
  model: ExecProcessCardModel;
  onExpand?: () => void;
}

function isCollapsedStatus(status: string): boolean {
  return EXEC_COLLAPSED_STATUSES.has(status);
}

function getInitialExpandedState(status: string): boolean {
  return !isCollapsedStatus(status);
}

function getAutoExpandedStateForStatus(
  status: string,
): boolean | null {
  if (isCollapsedStatus(status)) {
    // Requesting the collapse right away is safe: the FlowChat coordinator
    // holds it until the card leaves the viewport.
    return false;
  }

  if (status === 'preparing' || status === 'streaming' || status === 'running' || status === 'receiving') {
    return true;
  }

  return null;
}

function isCancelledStatus(status: string): boolean {
  return status === 'cancelled';
}

function isUserRejectedTool(toolItem: FlowToolItem): boolean {
  if (toolItem.status === 'rejected') {
    return true;
  }

  if (toolItem.status === 'cancelled') {
    if (toolItem.userConfirmed === false) {
      return true;
    }

    const error = toolItem.toolResult?.error;
    return typeof error === 'string' && /\buser rejected\b/i.test(error);
  }

  return false;
}

function isRejectedOrCancelledStatus(toolItem: FlowToolItem): boolean {
  return isCancelledStatus(toolItem.status) || isUserRejectedTool(toolItem);
}

function readProgressLogs(toolItem: FlowToolItem): string[] {
  const logs = (toolItem as any)._progressLogs;
  return Array.isArray(logs) ? logs.filter((entry): entry is string => typeof entry === 'string') : [];
}

function formatSecondsAsMs(seconds?: number): number | undefined {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? Math.max(0, Math.round(seconds * 1000))
    : undefined;
}

/**
 * Always rendered, including while the command is still running with nothing to
 * report yet. The row is part of the card's reserved height: letting it appear
 * on completion made the card change height in the viewport, which the browser
 * answered by moving the transcript under the reader.
 *
 * Elapsed and final duration both live in the header's `ToolTimeoutIndicator`,
 * so the footer deliberately carries no time of its own.
 */
function renderFooter(
  model: ExecProcessCardModel,
  t: (key: string, options?: Record<string, unknown>) => string,
  notice?: React.ReactNode,
) {
  return (
    <div data-bf-component="exec-process-tool-card" data-bf-part="footer" className="terminal-result-footer exec-process-result-footer">
      {notice}
      {model.workdir && (
        <span className="exec-process-footer-group exec-process-footer-group--workdir">
          <span className="terminal-result-label">{t('toolCards.terminal.workingDirectory')}</span>
          <span className="terminal-result-value">{model.workdir}</span>
        </span>
      )}
      {(model.sessionId != null || model.remote || model.tty) && (
        <span className="exec-process-footer-group exec-process-footer-group--meta">
          {model.sessionId != null && (
            <span className="exec-process-footer-item">
              <span className="terminal-result-label">{t('toolCards.execProcess.session')}</span>
              <span className="terminal-result-value">#{model.sessionId}</span>
            </span>
          )}
          {model.remote && (
            <span className="exec-process-footer-item terminal-result-value">{t('toolCards.execProcess.remote')}</span>
          )}
          {model.tty && (
            <span className="exec-process-footer-item terminal-result-value">{t('toolCards.execProcess.tty')}</span>
          )}
        </span>
      )}
      {model.exitCode != null && (
        <span className="exec-process-footer-group exec-process-footer-group--metrics">
          <span className={`terminal-exit-code ${model.exitCode === 0 ? 'success' : 'error'}`}>
            {t('toolCards.terminal.exitCode', { code: model.exitCode })}
          </span>
        </span>
      )}
    </div>
  );
}

export const ExecProcessToolCardView: React.FC<ExecProcessToolCardViewProps> = ({
  toolItem,
  model,
  onExpand,
}) => {
  const { t } = useTranslation('flow-chat');
  const status = toolItem.status || 'pending';
  const isParamsStreaming = Boolean(toolItem.isParamsStreaming);
  const progressLogs = useMemo(() => readProgressLogs(toolItem), [toolItem]);
  const liveOutput = useMemo(() => {
    if (progressLogs.length > 0) {
      return progressLogs.join('');
    }
    const progressMessage = (toolItem as any)._progressMessage;
    return typeof progressMessage === 'string' ? progressMessage : '';
  }, [progressLogs, toolItem]);
  const isRunning = status === 'preparing' || status === 'streaming' || status === 'running' || status === 'receiving';
  const rejectedOrCancelled = isRejectedOrCancelledStatus(toolItem);
  const cancelledStatusLabelKey = isUserRejectedTool(toolItem)
    ? 'toolCards.terminal.rejected'
    : 'toolCards.terminal.cancelled';
  const cancelledStatusClassName = isUserRejectedTool(toolItem)
    ? 'status-rejected'
    : 'status-cancelled';
  const toolId = toolItem.id ?? toolItem.toolCall?.id;
  const icon = <Terminal size={16} className="terminal-card-icon" />;

  const [isExpanded, setIsExpandedState] = useState(
    () => resolveToolCardExpanded(toolId, getInitialExpandedState(status)),
  );
  const commandRef = useRef<HTMLElement | null>(null);
  const outputRendererRef = useRef<TerminalOutputRendererHandle | null>(null);
  const [isPrimaryTextTruncated, setIsPrimaryTextTruncated] = useState(false);
  const {
    cardRootRef,
    applyExpandedState,
    requestAutoCollapse,
    isAutoCollapseInstant,
    hasUserExpandedSettled,
    markUserExpandedSettled,
    isUserControlled,
    markUserControlled,
  } = useToolCardHeightContract({ cardId: toolId, isExpanded });

  const applyExecExpandedState = useCallback((nextExpanded: boolean) => {
    if (nextExpanded === isExpanded) {
      return;
    }

    applyExpandedState(isExpanded, nextExpanded, setIsExpandedState, { onExpand });
  }, [applyExpandedState, isExpanded, onExpand]);

  const toggleExpanded = useCallback(() => {
    markUserControlled();
    if (!isExpanded && isCollapsedStatus(status)) {
      markUserExpandedSettled();
    }
    applyExecExpandedState(!isExpanded);
  }, [applyExecExpandedState, isExpanded, markUserControlled, markUserExpandedSettled, status]);

  useLayoutEffect(() => {
    if (isUserControlled()) {
      return;
    }

    const nextExpanded = getAutoExpandedStateForStatus(status);
    if (nextExpanded !== null) {
      if (!nextExpanded) {
        return requestAutoCollapse(isExpanded, setIsExpandedState);
      }
      applyExecExpandedState(true);
    }
  }, [
    applyExecExpandedState,
    isExpanded,
    isUserControlled,
    requestAutoCollapse,
    status,
  ]);

  // A settled card the coordinator has not collapsed yet keeps the streaming
  // row count, so completion does not grow the card under a reader who never
  // asked for the full output. Tail position is irrelevant: the coordinator,
  // not the item's place in the transcript, decides when it goes away.
  const compactSettledPreview =
    isExpanded &&
    isCollapsedStatus(status) &&
    !hasUserExpandedSettled;
  const maxRows = isRunning || compactSettledPreview
    ? EXEC_OUTPUT_STREAMING_MAX_ROWS
    : EXEC_OUTPUT_EXPANDED_MAX_ROWS;
  const reservedOutputHeightPx = getExecOutputReservedHeightPx();

  const updatePrimaryTextTruncation = useCallback(() => {
    const element = commandRef.current;
    if (!element) {
      setIsPrimaryTextTruncated(false);
      return;
    }
    const nextValue = element.scrollWidth - element.clientWidth > 1;
    setIsPrimaryTextTruncated((prev) => (prev === nextValue ? prev : nextValue));
  }, []);

  useEffect(() => {
    const element = commandRef.current;
    if (!element) {
      setIsPrimaryTextTruncated(false);
      return;
    }

    const frameId = window.requestAnimationFrame(updatePrimaryTextTruncation);
    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(updatePrimaryTextTruncation)
      : null;
    resizeObserver?.observe(element);
    if (element.parentElement) {
      resizeObserver?.observe(element.parentElement);
    }
    window.addEventListener('resize', updatePrimaryTextTruncation);

    return () => {
      window.cancelAnimationFrame(frameId);
      resizeObserver?.disconnect();
      window.removeEventListener('resize', updatePrimaryTextTruncation);
    };
  }, [model.primaryText, updatePrimaryTextTruncation]);

  const handleCardClick = useCallback((event: React.MouseEvent) => {
    const target = event.target as HTMLElement;
    if (target.closest('.tool-card-header-actions, .terminal-action-btn')) {
      return;
    }
    toggleExpanded();
  }, [toggleExpanded]);

  const completedDurationMs =
    formatSecondsAsMs(model.wallTimeSeconds) ?? toolItem.toolResult?.duration_ms ?? toolItem.durationMs;
  const timeoutMs = typeof toolItem.toolCall?.input?.yield_time_ms === 'number' && toolItem.toolCall.input.yield_time_ms > 0
    ? toolItem.toolCall.input.yield_time_ms
    : undefined;

  const renderPrimaryText = (variant: 'default' | 'compact' = 'default') => (
    <CopyableTextPreview
      ref={commandRef}
      as={variant === 'compact' ? 'span' : 'code'}
      text={model.primaryText}
      emptyText={model.emptyText}
      className={
        variant === 'compact'
          ? 'terminal-command-compact copyable-text-preview--compact copyable-text-preview--theme-font'
          : 'terminal-command copyable-text-preview--theme-font'
      }
      tooltipContent={model.primaryText && isPrimaryTextTruncated ? model.primaryText : undefined}
    />
  );

  const renderCopyButton = () => (
    <ToolCardCopyAction
      className="terminal-action-btn copy-command-btn"
      getText={() => model.copyText}
      disabled={model.copyDisabled}
      tooltip={t('toolCards.execProcess.copyPrimary')}
      copiedTooltip={t('toolCards.execProcess.primaryCopied')}
      successMessage={t('toolCards.execProcess.primaryCopied')}
      failureMessage={t('toolCards.execProcess.copyPrimaryFailed')}
      ariaLabel={t('toolCards.execProcess.copyPrimary')}
      showSuccessNotification={false}
    />
  );

  const getOutputText = useCallback(() => {
    if (status === 'completed') {
      return formatSessionViewPreviewText(model.resultOutput);
    }

    if (status === 'cancelled') {
      return liveOutput;
    }

    if (liveOutput && isRunning) {
      return liveOutput;
    }

    return '';
  }, [isRunning, liveOutput, model.resultOutput, status]);

  const getVisibleOutputText = useCallback(() => {
    return outputRendererRef.current?.getVisibleText() ?? getOutputText();
  }, [getOutputText]);

  const renderCopyOutputButton = () => (
    <ToolCardCopyAction
      className="terminal-action-btn copy-command-btn exec-process-copy-output-btn"
      getText={getVisibleOutputText}
      disabled={!getOutputText().trim()}
      tooltip={t('toolCards.execProcess.copyOutput')}
      copiedTooltip={t('toolCards.execProcess.outputCopied')}
      successMessage={t('toolCards.execProcess.outputCopied')}
      failureMessage={t('toolCards.execProcess.copyOutputFailed')}
      ariaLabel={t('toolCards.execProcess.copyOutput')}
      showSuccessNotification={false}
    />
  );

  const renderOutputWithCopyAction = (
    output: string,
    options?: { formatSessionPreview?: boolean },
  ) => (
    <div className="exec-process-output-copy-region" data-bf-component="exec-process-tool-card" data-bf-part="output">
      <div className="exec-process-output-copy-actions" data-bf-component="exec-process-tool-card" data-bf-part="actions">
        {renderCopyOutputButton()}
      </div>
      <LazyTerminalOutputRenderer
        ref={outputRendererRef}
        content={options?.formatSessionPreview ? formatSessionViewPreviewText(output) : output}
        className="terminal-xterm-output"
        minHeight={reservedOutputHeightPx}
        maxRows={maxRows}
      />
    </div>
  );

  const renderTimeoutIndicator = () => (
    <span className="terminal-header-duration">
      <ToolTimeoutIndicator
        startTime={toolItem.startTime}
        isRunning={isRunning}
        timeoutMs={timeoutMs}
        showControls={false}
        completedDurationMs={status === 'completed' ? completedDurationMs : undefined}
        completedStatus={
          status === 'completed'
            ? model.exitCode === 0 || model.exitCode == null ? 'success' : 'error'
            : status === 'error' ? 'error' : rejectedOrCancelled ? 'cancelled' : undefined
        }
      />
    </span>
  );

  const renderHeaderExtra = () => (
    <span className="terminal-header-extra" data-bf-component="exec-process-tool-card" data-bf-part="actions">
      {renderTimeoutIndicator()}
      {rejectedOrCancelled && (
        <span className={`terminal-status-text ${cancelledStatusClassName}`} data-bf-component="exec-process-tool-card" data-bf-part="status">
          {t(cancelledStatusLabelKey)}
        </span>
      )}
      <ToolCardHeaderActions className="terminal-header-actions">
        {renderCopyButton()}
      </ToolCardHeaderActions>
    </span>
  );

  const renderLoadingStatusIcon = () => (
    isRunning ? <DotMatrixLoader size="medium" /> : null
  );

  /**
   * What fills the reserved output area. Every branch returns content only — the
   * slot around it owns the height, so which branch is showing cannot change it.
   */
  const renderOutputSlotContent = () => {
    if (status === 'completed') {
      if (model.resultOutput) {
        return renderOutputWithCopyAction(model.resultOutput, { formatSessionPreview: true });
      }
      return (
        <span className="waiting-text">{model.resultNoticeText || model.noOutputText}</span>
      );
    }

    if (liveOutput) {
      return renderOutputWithCopyAction(liveOutput);
    }

    if (rejectedOrCancelled) {
      return <span className="waiting-text">{t(cancelledStatusLabelKey)}</span>;
    }

    return (
      <span className="waiting-text">
        {isParamsStreaming ? t('toolCards.terminal.receivingParams') : model.waitingText}
      </span>
    );
  };

  /**
   * One structure for running, cancelled and completed alike. The card used to
   * swap whole regions at completion — running indicator out, output and footer
   * in — so its height dipped between the two commits and the browser answered
   * by moving the transcript under the reader. Reserving the output area and
   * keeping the footer mounted makes the transition content-only.
   *
   * Approval is deliberately left out: nothing is running yet, and growing into
   * this layout when it starts is benign.
   */
  const renderExpandedContent = () => {
    if (status === 'pending_confirmation') {
      return (
        <div data-bf-component="exec-process-tool-card" data-bf-part="waiting" data-bf-state="waiting" className="terminal-execution-output terminal-waiting">
          <span className="waiting-text">{t('toolCards.approval.waiting')}</span>
        </div>
      );
    }

    if (status !== 'completed' && !rejectedOrCancelled && !isRunning && !isParamsStreaming) {
      return null;
    }

    return (
      <div
        data-bf-component="exec-process-tool-card"
        data-bf-part="result"
        data-bf-state={rejectedOrCancelled ? 'cancelled' : undefined}
        className={`terminal-result-container${rejectedOrCancelled ? ' cancelled' : ''}`}
      >
        <div
          className="terminal-result-output exec-process-output-slot"
          data-bf-component="exec-process-tool-card"
          data-bf-part="outputSlot"
          style={{ minHeight: `${reservedOutputHeightPx}px` }}
        >
          {renderOutputSlotContent()}
        </div>
        {renderFooter(
          model,
          t,
          rejectedOrCancelled
            ? <span className="terminal-cancelled-text">{t(cancelledStatusLabelKey)}</span>
            : undefined,
        )}
      </div>
    );
  };

  const renderErrorContent = () => {
    if (status !== 'error') {
      return null;
    }

    return (
      <div data-bf-component="exec-process-tool-card" data-bf-part="error" data-bf-state="error" className="error-content">
        <div className="error-message">
          {toolItem.toolResult?.error || t('toolCards.terminal.executionFailed')}
        </div>
      </div>
    );
  };

  const renderHeader = () => (
    <ToolCardHeader
      icon={icon}
      action={model.actionLabel}
      content={renderPrimaryText()}
      extra={renderHeaderExtra()}
      statusIcon={renderLoadingStatusIcon()}
    />
  );

  return (
    <div ref={cardRootRef} data-tool-card-id={toolId ?? ''} data-bf-component="exec-process-tool-card" data-bf-part="root">
      <BaseToolCard
        status={status}
        isExpanded={isExpanded}
        onClick={handleCardClick}
        className={`terminal-tool-card exec-process-tool-card${!isExpanded ? ' terminal-tool-card--compact-truncated' : ''}`}
        header={renderHeader()}
        // Keep the previous result mounted while SmoothHeightCollapse animates
        // from its measured height to zero. Removing it in the same render as
        // isExpanded=false makes the collapse jump instead of animate.
        expandedContent={renderExpandedContent()}
        errorContent={renderErrorContent()}
        isFailed={status === 'error'}
        requiresConfirmation={status === 'pending_confirmation'}
        disableExpandAnimation={isAutoCollapseInstant}
      />
    </div>
  );
};

export default ExecProcessToolCardView;
