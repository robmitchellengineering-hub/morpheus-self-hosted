// The order the Command Deck's widgets appear in — and the one that can never move.
//
// Rob, 2026-10-04: *"braindump is meant to be locked at the top of the page and i saw on a new users account
// that suggestions was coming up first for them. you're meant to be able to move everything else around which
// you can do but braindump is always locked at the top of the command deck."*
//
// WHY IT WAS WRONG, and it was two separate faults reading the same code:
//
//   1. `DECK_WIDGETS[0]` is `jarvis_suggestions`, and a brand-new account seeds one `DeckWidgetInstance` per
//      registry entry with `sort_order: i` — so a new user's FIRST widget was Jarvis's suggestions, exactly
//      what Rob saw. The registry order and the seed agree, which is precisely why nobody noticed.
//   2. Nothing was pinned. `moveWidget` swapped any two adjacent widgets, so brain dump could be pushed down
//      and anything could be moved above it.
//
// THE ORDER IS ENFORCED ON READ, not repaired in the database. Every account already has stored
// `sort_order` values that put suggestions at 0, and a migration would fix that once and then be
// re-breakable by the next `moveWidget`. Ordering through this function instead means the pinned widget is
// first for every account, on every device, from the moment this ships — and the storage cannot disagree
// with the screen, because the screen does not trust it.
//
// Pure and import-free, so `scripts/verify-deck-widget-order.mjs` can exercise every rule in CI's no-install
// job. The registry key is passed in rather than imported, so this module has no dependency on deckWidgets.js
// (which imports React icon components).

/** Brain dump. Always the first widget on the deck; never movable. */
export const PINNED_WIDGET_KEY = 'brain_dump';

/** May this widget be reordered? The pinned one may not — that is the whole rule. */
export function canReorderWidget(key) {
  return String(key || '') !== PINNED_WIDGET_KEY;
}

/**
 * The display order: the pinned widget first, then everything else by its stored `sort_order`.
 *
 * A tie on `sort_order` keeps the incoming order, so a duplicate order value cannot make the deck flicker
 * between renders. Missing or non-numeric `sort_order` sorts last rather than producing `NaN` comparisons —
 * `Array.sort` with a `NaN` comparator leaves the array in an arbitrary order, which is a real symptom and
 * not a theoretical one.
 *
 * @param {Array<{widget_key: string, sort_order?: number}>} instances
 * @returns {Array<object>} a new array; the input is not mutated
 */
export function orderDeckWidgets(instances) {
  const list = Array.isArray(instances) ? instances.filter(Boolean) : [];
  const pinned = list.filter((w) => w.widget_key === PINNED_WIDGET_KEY);
  const rest = list
    .filter((w) => w.widget_key !== PINNED_WIDGET_KEY)
    .map((w, index) => ({ w, index }))
    .sort((a, b) => {
      const av = Number(a.w.sort_order);
      const bv = Number(b.w.sort_order);
      const aOk = Number.isFinite(av);
      const bOk = Number.isFinite(bv);
      if (aOk && bOk && av !== bv) return av - bv;
      if (aOk !== bOk) return aOk ? -1 : 1; // a usable value beats a missing one
      return a.index - b.index;
    })
    .map((entry) => entry.w);
  return [...pinned, ...rest];
}

/**
 * Move one widget one place earlier or later, and return the whole list renumbered from 0.
 *
 * THE PINNED WIDGET IS NOT IN THE MOVABLE LIST AT ALL, rather than being guarded by a comparison: with the
 * pin simply absent from the list being swapped, **nothing can move above it and it cannot move down** — two
 * separate rules that would each need their own test become one that cannot be got wrong.
 *
 * @param {Array} instances
 * @param {string} key
 * @param {-1|1} direction
 * @returns {Array<object>|null} the renumbered list, or `null` when the move is refused
 */
export function reorderWidgets(instances, key, direction) {
  if (!canReorderWidget(key)) return null;
  if (direction !== -1 && direction !== 1) return null;

  const ordered = orderDeckWidgets(instances);
  const pinned = ordered.filter((w) => w.widget_key === PINNED_WIDGET_KEY);
  const movable = ordered.filter((w) => w.widget_key !== PINNED_WIDGET_KEY);

  const index = movable.findIndex((w) => w.widget_key === key);
  if (index < 0) return null;
  const swapWith = index + direction;
  if (swapWith < 0 || swapWith >= movable.length) return null;

  [movable[index], movable[swapWith]] = [movable[swapWith], movable[index]];
  return [...pinned, ...movable].map((w, i) => ({ ...w, sort_order: i }));
}
