# FlowChat Scroll Instructions

This file applies to the modern FlowChat viewport implementation under this
directory.

## Required Reading

Before changing rendering, virtualization, scrolling, tool-card collapse,
footer layout, runtime-status slots, or reveal behavior, read:

- `FLOWCHAT_SCROLL_STABILITY.md`

Also follow the repository and Web UI instructions in the parent guides.

## Current Contract

- FlowChat uses the natural browser scroll range after one bounded Turn stage.
- The only allowed synthetic tail space is the new-live-Turn stage owned by
  `VirtualMessageList`: it is at most one viewport tall, replaces the previous
  Turn stage, and decreases by a geometry high-water mark without replenishing.
- Do not add other bottom reservations, sticky Turn modes, pre-collapse
  compensation, or persistent element-anchor guards.
- `useFlowChatViewportCoordinator` is the only module allowed to issue outer
  viewport or Virtuoso movement commands. Follow and navigation are clients.
- Keep Virtuoso `followOutput={false}`.
- One-shot Turn/search/history navigation remains inside `VirtualMessageList`.
- Automatic tool/thinking-card collapse is requested through the FlowChat
  coordinator and executes only when the card is fully outside the viewport.
  Manual collapse remains immediate and animated.
- Footer height represents the current input-stack layout plus the single Turn
  stage and real footer content such as history state and `RuntimeStatusSlot`.
- Stable virtual-item keys and projection identity must be preserved.

## Verification

Choose focused tests, then run:

```text
pnpm run type-check:web
pnpm --dir src/web-ui run lint
pnpm --dir src/web-ui run test:run <focused-test-files>
```

Relevant tests include:

- `useFlowChatFollowOutput.test.tsx`
- `VirtualMessageList.layout.test.ts`
- `VirtualMessageList.session-boundary.test.tsx`
- `ModernFlowChatContainer.history-state.test.tsx`
- `flowChatCollapseMotion.test.ts`

Do not perform UI interaction verification. Report the manual checks described
in `FLOWCHAT_SCROLL_STABILITY.md` as pending unless the user confirms them.

Update `FLOWCHAT_SCROLL_STABILITY.md` whenever viewport ownership, natural
navigation, footer layout, or required verification changes.
