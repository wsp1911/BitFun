/* eslint-disable @typescript-eslint/no-use-before-define */
/**
 * Explore group renderer.
 * Renders merged explore-only rounds as a collapsible region.
 */

import React, { useMemo, useCallback, useLayoutEffect, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { FlowItem, FlowToolItem, FlowTextItem, FlowThinkingItem, ToolRejectOptions } from '../../types/flow-chat';
import type { ExploreGroupData } from '../../store/modernFlowChatStore';
import { FlowTextBlock } from '../FlowTextBlock';
import { FlowToolCard } from '../FlowToolCard';
import { ModelThinkingDisplay } from '../../tool-cards/ModelThinkingDisplay';
import { useToolCardHeightContract } from '../../tool-cards/useToolCardHeightContract';
import { useFlowChatContext, useFlowChatVolatileContext } from './FlowChatContext';
import { SmoothHeightCollapse } from './SmoothHeightCollapse';
import { FLOWCHAT_COLLAPSE_DURATION_MS } from './flowChatCollapseMotion';
import './ExploreRegion.scss';

export interface ExploreGroupRendererProps {
  data: ExploreGroupData;
  turnId: string;
}

function getExploreGroupKind(
  stats: ExploreGroupData['stats'],
  itemCount: number
): 'read' | 'search' | 'command' | 'mixed' | 'other' {
  const activeKinds = [
    stats.readCount > 0 ? 'read' : null,
    stats.searchCount > 0 ? 'search' : null,
    stats.commandCount > 0 ? 'command' : null,
  ].filter(Boolean) as Array<'read' | 'search' | 'command'>;

  if (activeKinds.length === 1) {
    return activeKinds[0];
  }

  if (activeKinds.length > 1) {
    return 'mixed';
  }

  return itemCount > 0 ? 'other' : 'mixed';
}

export const ExploreGroupRenderer: React.FC<ExploreGroupRendererProps> = React.memo(({
  data,
  turnId,
}) => {
  const { t } = useTranslation('flow-chat');

  const {
    onExploreGroupToggle,
    onCollapseGroup,
  } = useFlowChatContext();
  const { exploreGroupStates } = useFlowChatVolatileContext();
  
  const { 
    groupId, 
    allItems, 
    stats, 
    isGroupStreaming,
    isLastGroupInTurn,
    wasCutByCritical,
  } = data;
  const {
    cardRootRef,
    applyExpandedState,
    requestAutoCollapse,
    isAutoCollapseInstant,
  } = useToolCardHeightContract();

  const hasExplicitState = exploreGroupStates?.has(groupId) ?? false;
  const explicitExpanded = exploreGroupStates?.get(groupId) ?? false;
  // Being cut must not collapse the group during render: the coordinator owns
  // when that happens, and until then the group stays open in the viewport. A
  // group that mounts already cut — history, or scrolling back into the
  // overscan band — starts compact instead of expanding and collapsing again.
  const [isAutoExpanded, setIsAutoExpanded] = useState(!wasCutByCritical);
  const isExpanded = hasExplicitState ? explicitExpanded : isAutoExpanded;
  const isCollapsed = !isExpanded;
  const groupKind = getExploreGroupKind(stats, allItems.length);
  // Header is always interactive so the user can collapse/expand at any time.
  const allowManualToggle = true;

  // A cut group asks the FlowChat coordinator to collapse it, which happens only
  // once the group is fully outside the viewport. The guard is a state
  // predicate, not a transition edge: the effect re-registers whenever it
  // re-runs, so a dependency change cannot silently drop a pending request.
  //
  // An explicit state is user intent and must not be overwritten. The automatic
  // collapse deliberately does not record explicit state either — that is
  // reserved for the user, and recording it here would outlive its own reason.
  useLayoutEffect(() => {
    if (hasExplicitState || !wasCutByCritical || !isAutoExpanded) return;
    return requestAutoCollapse(isAutoExpanded, setIsAutoExpanded);
  }, [
    hasExplicitState,
    isAutoExpanded,
    requestAutoCollapse,
    wasCutByCritical,
  ]);

  // Build summary text with i18n.
  const displaySummary = useMemo(() => {
    const { readCount, searchCount, commandCount } = stats;
    
    const parts: string[] = [];
    if (readCount > 0) {
      parts.push(t('exploreRegion.readFiles', { count: readCount }));
    }
    if (searchCount > 0) {
      parts.push(t('exploreRegion.searchCount', { count: searchCount }));
    }
    if (commandCount > 0) {
      parts.push(t('exploreRegion.commandCount', { count: commandCount }));
    }
    
    if (parts.length === 0) {
      return t('exploreRegion.exploreCount', { count: allItems.length });
    }
    
    return parts.join(t('exploreRegion.separator'));
  }, [stats, allItems.length, t]);
  
  const handleToggle = useCallback(() => {
    if (isCollapsed) {
      applyExpandedState(false, true, () => {
        onExploreGroupToggle?.(groupId);
      });
      return;
    }

    applyExpandedState(true, false, () => {
      onCollapseGroup?.(groupId);
    });
  }, [applyExpandedState, groupId, isCollapsed, onCollapseGroup, onExploreGroupToggle]);

  // Build class list.
  const className = [
    'explore-region',
    'explore-region--collapsible',
    isCollapsed ? 'explore-region--collapsed' : 'explore-region--expanded',
    isGroupStreaming ? 'explore-region--streaming' : null,
  ].filter(Boolean).join(' ');
  return (
    <div data-bf-component="explore-group" data-bf-part="root" data-bf-state={isExpanded ? 'expanded' : undefined}
      ref={cardRootRef}
      data-testid="chat-explore-group"
      data-tool-card-id={groupId}
      data-group-kind={groupKind}
      data-expanded={isExpanded ? 'true' : 'false'}
      data-read-count={String(stats.readCount)}
      data-search-count={String(stats.searchCount)}
      data-command-count={String(stats.commandCount)}
      className={className}
    >
      {allowManualToggle && (
        <div
          data-bf-component="explore-group"
          data-bf-part="header"
          className="explore-region__header"
          onClick={handleToggle}
          data-testid="chat-explore-group-toggle"
          data-group-kind={groupKind}
          data-expanded={isExpanded ? 'true' : 'false'}
        >
          <ChevronRight size={14} className="explore-region__icon" />
          <span data-bf-component="explore-group" data-bf-part="summary" className="explore-region__summary">{displaySummary}</span>
        </div>
      )}
      <SmoothHeightCollapse
        isOpen={isExpanded}
        data-bf-component="explore-group"
        data-bf-part="contentWrapper"
        className="explore-region__content-wrapper"
        innerClassName="explore-region__content-inner"
        durationMs={FLOWCHAT_COLLAPSE_DURATION_MS}
        disableAnimation={isAutoCollapseInstant}
      >
        <div
          data-bf-component="explore-group"
          data-bf-part="content"
          className="explore-region__content"
          data-testid="chat-explore-group-content"
          data-group-kind={groupKind}
          data-expanded={isExpanded ? 'true' : 'false'}
        >
          {allItems.map((item, idx) => (
            <ExploreItemRenderer
              key={item.id}
              item={item}
              turnId={turnId}
              isLastItem={isLastGroupInTurn && idx === allItems.length - 1}
            />
          ))}
        </div>
      </SmoothHeightCollapse>
    </div>
  );
});

/**
 * Explore item renderer inside the explore region.
 * Uses React.memo to avoid unnecessary re-renders.
 */
interface ExploreItemRendererProps {
  item: FlowItem;
  turnId: string;
  isLastItem?: boolean;
}

const ExploreItemRenderer = React.memo<ExploreItemRendererProps>(({ item, turnId, isLastItem }) => {
  const {
    onToolConfirm,
    onToolReject,
    onFileViewRequest,
    onTabOpen,
    sessionId,
  } = useFlowChatContext();
  
  const handleConfirm = useCallback(async (toolId: string, permissionOptionId?: string, approve?: boolean) => {
    if (onToolConfirm) {
      await onToolConfirm(toolId, permissionOptionId, approve);
    }
  }, [onToolConfirm]);
  
  const handleReject = useCallback(async (toolId: string, options?: ToolRejectOptions) => {
    if (onToolReject) {
      await onToolReject(toolId, options);
    }
  }, [onToolReject]);
  
  const handleOpenInEditor = useCallback((filePath: string) => {
    if (onFileViewRequest) {
      onFileViewRequest(filePath, filePath.split(/[/\\]/).pop() || filePath);
    }
  }, [onFileViewRequest]);
  
  const handleOpenInPanel = useCallback((_panelType: string, data: any) => {
    if (onTabOpen) {
      onTabOpen(data, sessionId);
    }
  }, [onTabOpen, sessionId]);
  
  switch (item.type) {
    case 'text':
      return (
        <FlowTextBlock
          textItem={item as FlowTextItem}
        />
      );
    
    case 'thinking': {
      const thinkingItem = item as FlowThinkingItem;
      return (
        <ModelThinkingDisplay thinkingItem={thinkingItem} isLastItem={isLastItem} />
      );
    }
    
    case 'tool':
      return (
        <div data-bf-component="explore-group" data-bf-part="item" className="flowchat-flow-item" data-flow-item-id={item.id} data-flow-item-type="tool">
          <FlowToolCard
            toolItem={item as FlowToolItem}
            isLastItem={isLastItem}
            onConfirm={handleConfirm}
            onReject={handleReject}
            onOpenInEditor={handleOpenInEditor}
            onOpenInPanel={handleOpenInPanel}
            sessionId={sessionId}
            turnId={turnId}
          />
        </div>
      );

    default:
      return null;
  }
});

ExploreGroupRenderer.displayName = 'ExploreGroupRenderer';
