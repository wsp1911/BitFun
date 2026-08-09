# FlowChat Turn Stage and Collapse Contract

FlowChat has one deliberately narrow synthetic layout mechanism: a bounded
stage created when a new live Turn begins. It exists only to place the new user
message near the viewport top. It is not a general scroll-compensation system.

## Turn Stage

- `VirtualMessageList` is the only stage owner and the Footer is its only DOM
  representation.
- Initial session rendering, session switching, history reading, navigation,
  and search do not create a stage.
- A new live Turn replaces the previous stage; stages never accumulate.
- Initialization first commits a provisional stage of one viewport height while
  continuous follow movement and stage consumption are suspended. The user
  message is aligned from the resulting real scroll range, then unused space is
  trimmed once and the natural-content baseline is calibrated. The coordinator
  then enters `stage-consuming`; follow movement resumes only after the stage is
  exhausted.
- A provisional stage and a calibrated stage are distinct types. Only the
  calibrated one carries a baseline and only it can be consumed, so the guard is
  enforced by the type checker rather than by a distant runtime check.
- Suspension during the placement transaction is decided from coordinator
  ownership, never from a ref written during render.
- Placement aligns the already-rendered user message by measuring its own DOM
  rect, one step per frame, abandoning the transaction if ownership changes.
- Placement asserts its own postcondition: settling further than a few pixels
  from the viewport top is recorded as a failure, not as a successful stage.
- The calibrated stage remains clamped to one viewport height and never grows.
- Natural content growth consumes the stage using a maximum-height watermark.
  Content shrink, card collapse, input shrink, and remeasurement never restore
  consumed space.
- Unconsumed space remains until the next Turn instead of being reclaimed at
  Turn completion.

Do not add sticky-latest modes, multiple reservations, header anchors,
pre-collapse measurements, scroll restoration, or another tail-space writer.

## Viewport Ownership

Keep `followOutput={false}` on Virtuoso. `useFlowChatViewportCoordinator` is the
only module allowed to issue outer-scroller or Virtuoso movement commands.
Callers submit typed movement requests under one of these owners:

- `turn-placement` owns the bounded new-Turn alignment transaction.
- `stage-consuming` writes nothing; it preserves the placed viewport while
  content consumes the remaining stage.
- `following` may move to the natural tail only after the stage is exhausted.
- `explicit-navigation` owns Turn, index, search, history-anchor, Task, and
  focused-item navigation.
- `idle` represents user-owned natural scrolling.

Explicit wheel, touch, or keyboard navigation releases follow ownership;
ordinary scroll and layout events do not. Virtuoso remeasurement is observed
as geometry, never registered as a competing owner or compensated afterward.

Ownership governs how long a command stays live, not only who may issue it.
`scrollToIndex` delegates to Virtuoso, which retains the requested location and
replays it from its own size tree whenever item sizes change afterwards. The
coordinator cannot revoke a delegated command, so `scrollToIndex` is restricted
to one-shot `explicit-navigation`. Bounded transactions align from measured DOM
geometry through `setScrollTop`/`adjustScrollTop`, which complete immediately.

`FlowChatHeader` participates in the container's normal column layout above the
message viewport. It must not overlay the Virtuoso scroller or require a
synthetic list-header inset; viewport coordinates begin at the actual message
area.

## Automatic Collapse

Tool and thinking cards request automatic collapse through
`FlowChatAutoCollapseProvider`. The coordinator reads each card's own DOM rect,
not the containing Virtuoso item:

- While following output, a card may auto-collapse only when fully above or
  fully below the FlowChat viewport.
- Outside follow mode, a card may auto-collapse only when fully below the
  viewport and the viewport is not at the natural tail.
- Any viewport intersection prevents automatic collapse.
- Candidates execute oldest-first, one at a time, with two animation frames
  allowed for React commit and Virtuoso remeasurement before the next one.
- A card requests collapse as soon as its own state says it should be compact.
  Deciding *when* that happens belongs to the coordinator, so cards must not
  delay the request behind a local timer or grace period.
- A card with a compact and a comfortable size grows only when the user expands
  it after the work settled, reported through
  `useToolCardHeightContract.markUserExpandedSettled()`. Streaming and the
  window where the coordinator is holding a collapse request both use the
  compact size, so a card never changes its own height in the viewport.
- Deferral keeps interactive cards on screen past the point where their work
  settled. Such a card must retire an action it can no longer perform while
  holding the row that carried it, so the affordance disappears without the
  card shrinking under the reader.
- Coordinated automatic collapse is instant. User-triggered expand/collapse
  retains the local smooth animation.

Cards outside the main FlowChat provider keep their historical immediate
automatic-collapse behavior. Card code must not write the outer scroll position
or publish a collapse-compensation event.

## Long-Term Diagnostics

When `app.logging.flow_chat_diagnostics` is enabled, the dedicated
`flowchat.log` channel records semantic state transitions rather than every
scroll or resize callback:

- `STAGE`: creation, 75/50/25/0 percent consumption milestones and their
  post-commit anchor geometry, exhaustion, creation failure, placement that
  settled away from the viewport top, and clearing on session or presentation
  changes.
- `FOLLOW`: ownership entry/exit, inactive-viewport rejection, and natural-tail
  corrections rate-limited to one entry per second.
- `COLLAPSE`: candidate registration/cancellation, waiting-reason changes,
  eligibility, execution, disconnection, and post-collapse settlement with
  before/after geometry for the currently staged Turn anchor.
- `VIEWPORT`: ownership transitions between placement, stage consumption,
  following, explicit navigation, and idle.

Do not add full DOM item arrays, streaming text, or unthrottled native-scroll
geometry to this long-term channel. Every record must contain stable Turn/card
identity where available and enough scalar geometry to reconstruct the state
transition.

## Footer Contract

Footer height is:

```text
current input-stack layout inset + remaining Turn stage
```

History state and `RuntimeStatusSlot` remain real Footer content. No other
component may synchronously change Footer height or retain a prior measurement.

## Verification

Run the smallest relevant automated checks:

```text
pnpm --dir src/web-ui run test:run -- --pool=threads --maxWorkers=1 \
  src/flow_chat/components/modern/flowChatTurnStage.test.ts \
  src/flow_chat/components/modern/flowChatAutoCollapse.test.ts \
  src/flow_chat/components/modern/useFlowChatFollowOutput.test.tsx \
  src/flow_chat/components/modern/useFlowChatViewportCoordinator.test.tsx \
  src/flow_chat/components/modern/VirtualMessageList.session-boundary.test.tsx \
  src/flow_chat/tool-cards/useToolCardHeightContract.test.tsx
pnpm run type-check:web
pnpm --dir src/web-ui run lint
```

Agents must not perform UI interaction verification. A human follow-up should
check new-Turn top placement, streaming follow, explicit user-scroll ownership,
offscreen collapse above and below, manual collapse animation, short-answer
remaining space, and natural behavior after stage exhaustion.
