/**
 * Tool card for TodoWrite.
 */

import React, { useCallback, useMemo, useState } from 'react';
import { CheckCircle2, Circle, ListTodo, XCircle } from 'lucide-react';
import { TaskRunningIndicator } from '../../component-library';
import { useTranslation } from 'react-i18next';
import type { ToolCardProps } from '../types/flow-chat';
import { useDialogTurnTodos } from '../hooks/useDialogTurnTodos';
import { CompactToolCard, CompactToolCardHeader } from './CompactToolCard';
import { ToolCardStatusSlot } from './ToolCardStatusSlot';
import type { TodoLike } from './todoRenderItems';
import { createTodoRenderItems } from './todoRenderItems';
import { useToolCardHeightContract } from './useToolCardHeightContract';
import './TodoWriteDisplay.scss';

export const TodoWriteDisplay: React.FC<ToolCardProps> = ({
  toolItem,
  config,
  turnId,
  sessionId,
}) => {
  const { t } = useTranslation('flow-chat');
  const { status, toolResult, partialParams, isParamsStreaming } = toolItem;
  const [isExpanded, setIsExpanded] = useState(false);
  const { cardRootRef, applyExpandedState } = useToolCardHeightContract();

  const turnTodos = useDialogTurnTodos(sessionId, turnId);

  const todosToDisplay: TodoLike[] = useMemo(() => {
    if (isParamsStreaming && partialParams?.todos && Array.isArray(partialParams.todos)) {
      return partialParams.todos as TodoLike[];
    }
    if (turnTodos.length > 0) {
      return turnTodos as TodoLike[];
    }
    if (toolResult?.result?.todos && Array.isArray(toolResult.result.todos)) {
      return toolResult.result.todos as TodoLike[];
    }
    return [];
  }, [partialParams, toolResult, isParamsStreaming, turnTodos]);

  const taskStats = useMemo(() => {
    if (todosToDisplay.length === 0) return { completed: 0, total: 0 };
    const completed = todosToDisplay.filter((td) => td.status === 'completed').length;
    return { completed, total: todosToDisplay.length };
  }, [todosToDisplay]);
  const todoRenderItems = useMemo(
    () => createTodoRenderItems(todosToDisplay),
    [todosToDisplay],
  );

  const inProgressTasks = useMemo(
    () => todosToDisplay.filter((td) => td.status === 'in_progress'),
    [todosToDisplay],
  );

  const isAllCompleted = useMemo(
    () => todosToDisplay.length > 0 && taskStats.completed === taskStats.total,
    [todosToDisplay.length, taskStats],
  );

  const statusSlotProps =
    status === 'error' || status === 'cancelled'
      ? { status, defaultIcon: 'status' as const }
      : isAllCompleted
        ? { status: 'completed' as const, defaultIcon: 'status' as const }
        : { status, defaultIcon: 'tool' as const };

  const isLoading = status === 'preparing' || status === 'streaming' || status === 'running';

  const displayMode = config?.displayMode || 'compact';

  const currentDisplayTask = useMemo(() => {
    if (inProgressTasks.length > 0) return inProgressTasks[0];
    return todosToDisplay[0] ?? null;
  }, [inProgressTasks, todosToDisplay]);

  const handleToggleExpanded = useCallback(() => {
    if (todosToDisplay.length === 0) return;
    applyExpandedState(isExpanded, !isExpanded, setIsExpanded);
  }, [applyExpandedState, isExpanded, todosToDisplay.length]);

  const renderTodoItem = (todo: TodoLike, key: string) => (
    <div key={key} data-bf-component="todo-write-display" data-bf-part="item" className={`todo-item status-${todo.status}`}>
      <div className="todo-item-left">
        {todo.status === 'completed' && (
          <CheckCircle2 size={12} className="todo-status-icon todo-status-icon--completed" />
        )}
        {todo.status === 'in_progress' && (
          <TaskRunningIndicator size="xs" className="todo-status-icon todo-status-icon--in-progress" />
        )}
        {todo.status === 'pending' && (
          <Circle size={12} className="todo-status-icon todo-status-icon--pending" />
        )}
        {todo.status === 'cancelled' && (
          <XCircle size={12} className="todo-status-icon todo-status-icon--cancelled" />
        )}
        <span data-bf-component="todo-write-display" data-bf-part="itemContent" className="todo-content">{todo.content}</span>
      </div>
    </div>
  );

  /* ---------- Compact (single-line) display mode ---------- */

  if (displayMode === 'compact') {
    return (
      <div data-bf-component="todo-write-display" data-bf-part="root" data-bf-mode="compact" data-bf-state={[isLoading && 'loading', isAllCompleted && 'completed'].filter(Boolean).join(' ')} className={`tool-display-compact todo-write-compact status-${status}`}>
        <span data-bf-component="todo-write-display" data-bf-part="compactIcon" className="tool-icon">
          {isLoading ? (
            <TaskRunningIndicator size="sm" className="todo-compact-loading-icon" />
          ) : (
            <ListTodo size={14} />
          )}
        </span>
        {todosToDisplay.length > 0 && (
          <>
            <span data-bf-component="todo-write-display" data-bf-part="count" className="todo-count">
              {t('toolCards.todoWrite.tasksCount', { count: todosToDisplay.length })}
            </span>
            <span data-bf-component="todo-write-display" data-bf-part="progress" className="todo-progress">
              {t('toolCards.todoWrite.progress', {
                completed: taskStats.completed,
                total: taskStats.total,
              })}
            </span>
          </>
        )}
      </div>
    );
  }

  /* ---------- Standard display mode ---------- */

  const hasTodos = todosToDisplay.length > 0;
  const tasksLabel = t('toolCards.todoWrite.tasks');

  const headerAction =
    hasTodos && !isExpanded ? (
      <span className="todo-header-action-cluster">
        <span className="todo-header-tasks-label">{tasksLabel}</span>
        <span className="todo-stats">({taskStats.completed}/{taskStats.total})</span>
      </span>
    ) : (
      isExpanded ? undefined : tasksLabel
    );

  const headerContent = (() => {
    if (!hasTodos && isLoading) {
      return (
        <span data-bf-component="todo-write-display" data-bf-part="headerContent" className="todo-header-content todo-header-content--muted">{tasksLabel}…</span>
      );
    }
    if (isAllCompleted) {
      return (
        <span data-bf-component="todo-write-display" data-bf-part="headerContent" className="todo-header-content todo-header-content--success">
          {t('toolCards.todoWrite.allCompleted')}
        </span>
      );
    }
    if (currentDisplayTask) {
      return (
        <span data-bf-component="todo-write-display" data-bf-part="headerContent" className="todo-header-content">
          <span className="todo-header-current">{currentDisplayTask.content}</span>
          {inProgressTasks.length > 1 && (
            <span className="todo-header-more">+{inProgressTasks.length - 1}</span>
          )}
        </span>
      );
    }
    if (hasTodos) {
      return (
        <span data-bf-component="todo-write-display" data-bf-part="headerContent" className="todo-header-content todo-header-content--muted">
          {t('toolCards.todoWrite.tasksCount', { count: todosToDisplay.length })}
        </span>
      );
    }
    return null;
  })();

  const expandedContent = hasTodos ? (
    <div data-bf-component="todo-write-display" data-bf-part="expanded" className="todo-expanded-body">
      <div data-bf-component="todo-write-display" data-bf-part="list" className="todo-full-list">
        {todoRenderItems.map(({ todo, key }) => renderTodoItem(todo, key))}
      </div>
    </div>
  ) : undefined;

  return (
    <div data-bf-component="todo-write-display" data-bf-part="root" data-bf-mode="standard"
      data-bf-state={[isExpanded && 'expanded', isLoading && 'loading', isAllCompleted && 'completed'].filter(Boolean).join(' ')}
      ref={cardRootRef}
      data-tool-card-id={toolItem.id ?? ''}
      className={`todo-write-host mode-${displayMode} status-${status}`}
    >
      <CompactToolCard
        status={status}
        isExpanded={isExpanded && hasTodos}
        onClick={hasTodos ? handleToggleExpanded : undefined}
        clickable={hasTodos}
        toggleTestId="todo-write-toggle"
        className="todo-write-card"
        header={
          <CompactToolCardHeader
            icon={
              <ToolCardStatusSlot
                status={statusSlotProps.status}
                toolIcon={<ListTodo size={16} className="todo-card-icon" />}
                defaultIcon={statusSlotProps.defaultIcon}
              />
            }
            action={headerAction}
            content={headerContent}
            expandable={hasTodos}
            isExpanded={isExpanded && hasTodos}
          />
        }
        expandedContent={expandedContent}
      />
    </div>
  );
};
