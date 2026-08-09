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
- The stage is reclaimed at Turn completion for the part past the viewport
  bottom only, and in full on an explicit jump to the latest content. Never
  reclaim space that is still on screen; consumption and reclamation stay one
  writer sharing one DOM read.
- `useFlowChatViewportCoordinator` is the only module allowed to issue outer
  viewport or Virtuoso movement commands. Follow and navigation are clients.
- The browser moves `scrollTop` on its own when content height dips, without
  going through any scroll API. Ownership discipline cannot revoke that, so
  cards must not change height in the viewport — including by restructuring
  their body when their work settles.
- `scrollToIndex` delegates a location Virtuoso replays on later remeasurement
  and the coordinator cannot revoke, so it is limited to one-shot explicit
  navigation. Bounded transactions align from measured DOM geometry instead.
- State that gates a viewport write must not be mirrored into a ref during
  render; sync it on commit so a discarded render cannot publish a stale value.
- Keep Virtuoso `followOutput={false}`.
- One-shot Turn/search/history navigation remains inside `VirtualMessageList`.
- Automatic tool/thinking-card and explore-group collapse is requested through
  the FlowChat coordinator and executes only when the card is fully outside the
  viewport. Manual collapse remains immediate and animated.
- A card never changes its own height in the viewport. Two-size cards stay
  compact through streaming and through the pending-collapse window, and grow
  only on `markUserExpandedSettled()` from a user expand after the work settled.
- Collapses still pending when a new Turn is placed are flushed in one batch
  inside the placement transaction, before alignment measures and before
  calibration reads `scrollHeight`. Nothing else may flush.
- A projection flag that drives automatic collapse must be monotonic, and the
  collapse must not record explicit user state.
- A remount restores what a card showed rather than re-deriving it, through
  `resolveToolCardExpanded()` plus `useToolCardHeightContract({ cardId,
  isExpanded })`. Re-deriving collapses absorbed cards in the viewport.
- Explore groups render at their natural height. Do not reintroduce a bounded
  inner scroll box; it converts tail growth into an unrepayable shrink and
  breaks the coordinator's single-scroller geometry.
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
- `VirtualMessageList.turn-stage.test.tsx`
- `ModernFlowChatContainer.history-state.test.tsx`
- `flowChatCollapseMotion.test.ts`

Do not perform UI interaction verification. Report the manual checks described
in `FLOWCHAT_SCROLL_STABILITY.md` as pending unless the user confirms them.

Update `FLOWCHAT_SCROLL_STABILITY.md` whenever viewport ownership, natural
navigation, footer layout, or required verification changes.
