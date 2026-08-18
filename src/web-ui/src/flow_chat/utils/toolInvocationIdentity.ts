import type { FlowToolItem } from '../types/flow-chat';

export const DEFERRED_TOOL_GATEWAY_NAME = 'CallDeferredTool';

export interface EffectiveToolInvocation {
  toolName: string;
  input: unknown;
  isDeferred: boolean;
}

export function effectiveToolInvocation(
  wireToolName: string,
  wireInput: unknown,
): EffectiveToolInvocation {
  if (
    wireToolName !== DEFERRED_TOOL_GATEWAY_NAME
    || wireInput === null
    || typeof wireInput !== 'object'
    || Array.isArray(wireInput)
  ) {
    return { toolName: wireToolName, input: wireInput, isDeferred: false };
  }

  const input = wireInput as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(input, 'call')) {
    if (
      input.call === null
      || typeof input.call !== 'object'
      || Array.isArray(input.call)
    ) {
      return { toolName: wireToolName, input: wireInput, isDeferred: false };
    }

    const entries = Object.entries(input.call as Record<string, unknown>);
    if (entries.length !== 1) {
      return { toolName: wireToolName, input: wireInput, isDeferred: false };
    }

    const [toolName, args] = entries[0];
    if (
      toolName.trim().length === 0
      || args === null
      || typeof args !== 'object'
      || Array.isArray(args)
    ) {
      return { toolName: wireToolName, input: wireInput, isDeferred: false };
    }

    return {
      toolName,
      input: args,
      isDeferred: true,
    };
  }

  // Keep projecting historical calls written with the previous envelope.
  if (
    typeof input.tool_name !== 'string'
    || input.tool_name.trim().length === 0
  ) {
    return { toolName: wireToolName, input: wireInput, isDeferred: false };
  }

  const hasArgs = Object.prototype.hasOwnProperty.call(input, 'args');
  if (
    hasArgs
    && (
      input.args === null
      || typeof input.args !== 'object'
      || Array.isArray(input.args)
    )
  ) {
    return { toolName: wireToolName, input: wireInput, isDeferred: false };
  }

  const args = hasArgs ? input.args as Record<string, unknown> : {};
  const overflowEntries = Object.entries(input)
    .filter(([key]) => key !== 'tool_name' && key !== 'args');
  const effectiveInput = overflowEntries.length === 0
    ? args
    : Object.fromEntries([
        ...overflowEntries,
        ...Object.entries(args),
      ]);

  return {
    toolName: input.tool_name,
    input: effectiveInput,
    isDeferred: true,
  };
}

export function getEffectiveToolName(toolItem: Pick<FlowToolItem, 'toolName' | 'toolCall'>): string {
  return effectiveToolInvocation(toolItem.toolName, toolItem.toolCall?.input).toolName;
}

export function projectEffectiveToolItem(toolItem: FlowToolItem): FlowToolItem {
  const effective = effectiveToolInvocation(toolItem.toolName, toolItem.toolCall?.input);
  if (!effective.isDeferred) {
    return toolItem;
  }

  return {
    ...toolItem,
    toolName: effective.toolName,
    toolCall: {
      ...toolItem.toolCall,
      input: effective.input,
    },
  };
}
