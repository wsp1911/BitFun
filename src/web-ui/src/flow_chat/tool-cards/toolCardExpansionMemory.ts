/**
 * Remembers what a tool card actually showed, keyed by its stable item id.
 *
 * A card derives its default expanded state from data that has often already
 * moved on by the time the card remounts. An explore group absorbing a round
 * unmounts that round's cards and remounts them inside the group, where they
 * are no longer the last item: a fresh `useState(derivedDefault)` therefore
 * mounts collapsed, in the viewport, without ever asking the coordinator that
 * exists to prevent exactly that. The same remount also discards which cards
 * the user had taken control of.
 *
 * Restoring instead of re-deriving keeps the card at the size it had one frame
 * earlier and lets the coordinator own the collapse as usual. A card that has
 * never been recorded falls back to its derived default, which is what history
 * rendering wants.
 */

interface ToolCardExpansionMemo {
  isExpanded: boolean;
  isUserControlled: boolean;
  hasUserExpandedSettled: boolean;
}

/**
 * Bounded so a long session cannot grow this without limit. Entries are
 * recency-ordered, and evicting the oldest only restores the derived default
 * for a card that has been off screen the longest — the behaviour this module
 * replaces.
 */
const MAX_REMEMBERED_CARDS = 4000;

const memory = new Map<string, ToolCardExpansionMemo>();

export function readToolCardExpansionMemo(
  cardId: string | undefined,
): ToolCardExpansionMemo | undefined {
  return cardId === undefined ? undefined : memory.get(cardId);
}

export function rememberToolCardExpansion(
  cardId: string | undefined,
  patch: Partial<ToolCardExpansionMemo>,
): void {
  if (cardId === undefined) return;

  const current = memory.get(cardId);
  if (current) {
    // Re-insert so iteration order stays least-recently-written first.
    memory.delete(cardId);
    memory.set(cardId, { ...current, ...patch });
    return;
  }

  if (memory.size >= MAX_REMEMBERED_CARDS) {
    const oldest = memory.keys().next();
    if (!oldest.done) memory.delete(oldest.value);
  }
  memory.set(cardId, {
    isExpanded: false,
    isUserControlled: false,
    hasUserExpandedSettled: false,
    ...patch,
  });
}

/** `useState` initializer for a card's expanded state. */
export function resolveToolCardExpanded(
  cardId: string | undefined,
  derivedDefault: boolean,
): boolean {
  return readToolCardExpansionMemo(cardId)?.isExpanded ?? derivedDefault;
}

export function clearToolCardExpansionMemory(): void {
  memory.clear();
}
