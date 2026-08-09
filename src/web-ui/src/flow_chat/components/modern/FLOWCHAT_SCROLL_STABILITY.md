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
- Unconsumed space is reclaimed on exactly two occasions. At Turn completion,
  only the part past the viewport bottom goes: it is invisible, so removing it
  cannot clamp `scrollTop` and nothing moves. On an explicit jump to the latest
  content the whole stage goes, because there the shrink is paid for by the
  movement the reader asked for — and a stage left standing would send them to a
  tail made of blank Footer.
- Reclaiming space that is still on screen is forbidden, at Turn completion as
  everywhere else. It is the same unrepayable shrink, and for a short answer
  that space is the reserve doing its job.
- What is free is the slack between `scrollTop` and the bottom of the scroll
  range, measured directly. Never derive it by subtracting the stage from
  `scrollHeight` to reconstruct a stage-free scroll range: a transcript shorter
  than its viewport makes that quantity negative, and flooring it at zero
  reports the whole of `scrollTop` as stage-supported.
- Consumption and reclamation are one writer sharing one DOM read. Splitting
  them lets the second measure a scroll height the first has already committed
  against but the browser has not laid out yet, and count the same pixels twice.
  Reclaiming lowers `initialPx` by what it took, so consumption cannot recompute
  the space back into existence.
- An explicit jump calls off a placement transaction in flight, including the
  window where it is still waiting for the new user message to render. That
  retry re-enters stage creation directly rather than through the step guard, so
  it carries its own ownership check.

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

The browser is the remaining writer nothing can revoke. When an element
restructures inside the viewport, the resulting height change can move
`scrollTop` — through clamping, or through scroll anchoring holding a node below
the change still — and neither goes through a scroll API, so no amount of
ownership discipline in this module prevents it. The only defence is upstream:
elements must not change height in the viewport in the first place.

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
- Merged explore groups follow the same contract, and have exactly two sizes:
  open at their natural height, and the header row. They must not reintroduce a
  bounded inner scroll box. A capped box absorbs later rounds merging into it
  for free, which turns benign tail growth into a shrink no reserve can repay,
  and a nested scroller breaks the single-scroller geometry the coordinator
  measures cards against.
- A projection flag that drives automatic collapse must be monotonic. Round
  classification is not: a round that has produced only thinking is not explore
  content yet and becomes so when its first collapsible tool lands. A group is
  therefore closed only by content that can no longer join it — never by "is
  not currently the tail".
- Automatic collapse must not record explicit user state. Recording it outlives
  the automatic reason for it and pins the card against every later default.
- A remount must restore what a card showed, not re-derive it. Absorption into
  an explore group unmounts a round's cards and remounts them where their
  derived default has already flipped, so re-deriving collapses them in the
  viewport without ever asking the coordinator. Cards read their initial state
  through `resolveToolCardExpanded()` and report it through
  `useToolCardHeightContract({ cardId, isExpanded })`.
- Deferral keeps interactive cards on screen past the point where their work
  settled. Such a card must retire an action it can no longer perform while
  holding the row that carried it, so the affordance disappears without the
  card shrinking under the reader.
- Settling must not restructure a card's body. Swapping whole regions — a
  running indicator out, output and a result footer in — dips the card's height
  between the two commits, and the browser answers a dip by moving the
  transcript. A card reserves the space its settled state will need while it is
  still running: the exec card reserves its streaming row count for the output
  area and keeps the result footer mounted with nothing in it yet, so completion
  changes content only. Placeholders sit inside the reserved area rather than
  replacing it.
- Collapses still pending when a new Turn is placed run inside the placement
  transaction, batched into one commit, before both alignment passes measure and
  before calibration reads `scrollHeight`. That transaction is about to relocate
  the viewport and realign from the geometry that results, so it is the only
  moment arbitrary height changes cost nothing to correct — and waiting for
  those cards to leave the viewport on their own can take an arbitrary number of
  Turns. Calibrating against a height that is about to shrink would make later
  growth repay the difference before it consumed anything.
- Nothing else may flush. The one-at-a-time, two-frame discipline is what keeps
  every other automatic collapse individually invisible.
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
  settled away from the viewport top, reclamation with the geometry that decided
  how much was free, the viewport falling while the coordinator was not writing
  it, and clearing on session, presentation, or jump-to-latest.

  Nothing here writes the viewport backwards, so a fall is unrequested by
  definition. The reader is the only other candidate and their wheel, touch or
  key arrives first, so a recent user intent is what disqualifies a record —
  not the current owner, since falls happen while idle too. Do not test for the
  fall landing on the bottom of the range either: the dip can recover inside the
  same layout pass, and scroll events are dispatched at the start of the
  following frame, by which point the range is often taller again. Record the
  slack on both sides instead, and split the drop into the part the stage gave
  up and the part the transcript lost — that split is what makes a record
  actionable.

  This tripwire has a known blind spot: falls of a few pixels have been observed
  without a record landing. Absence of records is not proof the viewport held
  still. Attributing a fall to a specific element needs a rect and computed
  style per rendered element, which distorts the timing it is trying to measure,
  so it is not left running; add it back temporarily when hunting a specific
  regression.
- `FOLLOW`: ownership entry/exit, inactive-viewport rejection, and natural-tail
  corrections rate-limited to one entry per second.
- `COLLAPSE`: candidate registration/cancellation, waiting-reason changes,
  eligibility, execution, disconnection, batched flushes inside Turn placement,
  and post-collapse settlement with before/after geometry for the currently
  staged Turn anchor.
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
  src/flow_chat/components/modern/VirtualMessageList.turn-stage.test.tsx \
  src/flow_chat/tool-cards/useToolCardHeightContract.test.tsx
pnpm run type-check:web
pnpm --dir src/web-ui run lint
```

Agents must not perform UI interaction verification. A human follow-up should
check new-Turn top placement, streaming follow, explicit user-scroll ownership,
offscreen collapse above and below, manual collapse animation, short-answer
remaining space, and natural behavior after stage exhaustion.
