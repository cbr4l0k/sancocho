/**
 * Column reordering, as pure array moves.
 *
 * Kept out of the table component because both entry points — the organiser's
 * move buttons and dragging a header onto another — are easy to get subtly
 * wrong at the ends of the list and when dragging left versus right, and that
 * is exactly the kind of thing worth testing without a DOM.
 *
 * Every function returns a new array, and returns the input order unchanged
 * rather than throwing when a move is not possible: an unknown column id or an
 * out-of-range move is a no-op, not an error worth interrupting a drag for.
 */

/** Moves `columnId` by `offset` positions. */
export function moveInOrder(order: readonly string[], columnId: string, offset: number): string[] {
  const from = order.indexOf(columnId);
  if (from === -1) return [...order];
  const to = from + offset;
  if (to < 0 || to >= order.length) return [...order];
  return spliceMove(order, from, to);
}

/** Moves `draggedId` to the position currently held by `targetId`. */
export function dropInOrder(order: readonly string[], draggedId: string, targetId: string): string[] {
  const from = order.indexOf(draggedId);
  const to = order.indexOf(targetId);
  if (from === -1 || to === -1 || from === to) return [...order];
  return spliceMove(order, from, to);
}

function spliceMove(order: readonly string[], from: number, to: number): string[] {
  const next = [...order];
  const [moved] = next.splice(from, 1);
  // Unreachable for an in-range `from`; narrowing rather than asserting.
  if (moved === undefined) return [...order];
  next.splice(to, 0, moved);
  return next;
}
