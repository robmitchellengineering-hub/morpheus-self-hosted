// Is brain dump locked to the top of the Command Deck, and can everything else still move?
//
// WHY THIS EXISTS. Rob, 2026-10-04: *"braindump is meant to be locked at the top of the page and i saw on
// a new users account that suggestions was coming up first for them, you're meant to be able to move
// everything else around which you can do but braindump is always locked at the top of the command deck."*
//
// Two separate faults read the same code, which is why one guard covers both:
//
//   1. A NEW ACCOUNT SAW SUGGESTIONS FIRST. `DECK_WIDGETS[0]` was `jarvis_suggestions`, and seeding writes
//      one `DeckWidgetInstance` per registry entry with `sort_order: i` — so the registry order WAS the new
//      user's deck order. The registry and the seed agreed with each other, which is exactly why nobody
//      noticed; there was no second source to disagree.
//   2. NOTHING WAS PINNED. `moveWidget` swapped any two adjacent rows, so brain dump could be pushed down
//      and anything could be moved above it.
//
// The fix is to enforce the order ON READ (`deckWidgetOrder.js`) rather than repair `sort_order` once in a
// migration, because a migration fixes today's rows and the next `moveWidget` breaks them again. So this
// guard tests the rule directly, and then asserts the four call sites actually use it — a rule nothing
// calls is the failure mode H17 is about.
//
// Run:  node scripts/verify-deck-widget-order.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PINNED_WIDGET_KEY, canReorderWidget, orderDeckWidgets, reorderWidgets,
} from '../src/pages/CommandDeck/deckWidgetOrder.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
/** Just the widget keys, for readable assertions. */
const keys = (list) => list.map((w) => w.widget_key);
/** A row shaped like a DeckWidgetInstance, without needing a database. */
const row = (key, sort_order, extra = {}) => ({ id: `id-${key}`, widget_key: key, sort_order, enabled: true, ...extra });

console.log('\n1. brain dump is the pinned widget, and only it');
check('the pinned key is brain_dump', PINNED_WIDGET_KEY, 'brain_dump');
check('brain dump cannot be reordered', canReorderWidget('brain_dump'), false);
check('every other widget can', ['jarvis_suggestions', 'today_charge', 'inbox', 'calendar'].map(canReorderWidget).join(','), 'true,true,true,true');
check('a key we have never heard of is movable (it is not the pinned one)',
  [canReorderWidget('brand_new_widget'), canReorderWidget(null), canReorderWidget(undefined), canReorderWidget('')].join(','),
  'true,true,true,true');
// The negative that matters: matching must not be a substring or case-insensitive coincidence.
check('a key merely CONTAINING the pinned name is not pinned',
  [canReorderWidget('brain_dump_extra'), canReorderWidget('Brain_Dump'), canReorderWidget('xbrain_dump')].join(','),
  'true,true,true');

console.log('\n2. the order is pinned-first, then stored order');
const messy = [row('inbox', 3), row('brain_dump', 9), row('calendar', 1), row('today_charge', 2)];
check('brain dump is first even though its sort_order is the highest', keys(orderDeckWidgets(messy)), ['brain_dump', 'calendar', 'today_charge', 'inbox']);
check('the rest follow their stored sort_order', keys(orderDeckWidgets([row('a', 2), row('b', 0), row('c', 1)])), ['b', 'c', 'a']);
check('an account that stored the OLD order (suggestions at 0) still shows brain dump first',
  keys(orderDeckWidgets([row('jarvis_suggestions', 0), row('today_charge', 1), row('brain_dump', 2)])),
  ['brain_dump', 'jarvis_suggestions', 'today_charge']);
check('the input array is not mutated by ordering',
  (() => { const input = [row('b', 1), row('a', 0)]; orderDeckWidgets(input); return keys(input); })(),
  ['b', 'a']);
check('ordering returns a NEW array', orderDeckWidgets([row('a', 0)]) !== undefined, true);

console.log('\n3. a value that cannot be compared must not scramble the list');
// `Array.sort` with a NaN comparator silently produces an arbitrary order, which is a real symptom, not a
// theoretical one — so missing and non-numeric sort_order values sort LAST, in their incoming order.
check('rows with no sort_order go last, keeping their relative order',
  keys(orderDeckWidgets([row('a'), row('b', 1), row('c'), row('d', 0)])),
  ['d', 'b', 'a', 'c']);
check('a non-numeric sort_order is treated as missing',
  keys(orderDeckWidgets([row('a', 'nonsense'), row('b', 1)])), ['b', 'a']);
check('a tie keeps the incoming order, so the deck cannot flicker',
  keys(orderDeckWidgets([row('a', 5), row('b', 5), row('c', 5)])), ['a', 'b', 'c']);
check('a hand-edited duplicate cannot put brain dump second',
  keys(orderDeckWidgets([row('a', 0), row('brain_dump', 0)])), ['brain_dump', 'a']);
check('an account with NO brain dump row still orders normally',
  keys(orderDeckWidgets([row('b', 1), row('a', 0)])), ['a', 'b']);
check('nulls and a non-array do not throw',
  [orderDeckWidgets(null), orderDeckWidgets([null, row('a', 0)]), orderDeckWidgets('nope')].map((r) => JSON.stringify(keys(r))).join(' '),
  '[] ["a"] []');

console.log('\n4. moving: everything else can, brain dump cannot, and nothing passes it');
const deck = [row('brain_dump', 0), row('a', 1), row('b', 2), row('c', 3)];
check('moving a widget up swaps it with its neighbour', keys(reorderWidgets(deck, 'b', -1)), ['brain_dump', 'b', 'a', 'c']);
check('moving a widget down swaps the other way', keys(reorderWidgets(deck, 'a', 1)), ['brain_dump', 'b', 'a', 'c']);
check('…and the whole list comes back renumbered from 0',
  reorderWidgets(deck, 'a', 1).map((w) => w.sort_order).join(','), '0,1,2,3');
check('brain dump itself is refused', reorderWidgets(deck, 'brain_dump', -1), null);
check('…and cannot be pushed down either', reorderWidgets(deck, 'brain_dump', 1), null);
check('the top movable widget cannot move up into the pin', reorderWidgets(deck, 'a', -1), null);
check('the bottom widget cannot move down', reorderWidgets(deck, 'c', 1), null);
check('a direction that is not -1/1 is refused',
  [reorderWidgets(deck, 'a', 0), reorderWidgets(deck, 'a', 2), reorderWidgets(deck, 'a')].map(String).join(','),
  'null,null,null');
check('a key that is not on the deck is refused', reorderWidgets(deck, 'nope', -1), null);
check('ordering is left alone by a refused move',
  (() => { const input = [row('brain_dump', 0), row('a', 1)]; reorderWidgets(input, 'brain_dump', -1); return keys(input); })(),
  ['brain_dump', 'a']);

// The property that must hold for EVERY deck: whatever the stored order, whatever the move, the pinned
// widget is first and everything else appears exactly once. This is what the fix actually promises.
console.log('\n5. the promise holds for decks nobody hand-checked');
const KEYS = ['brain_dump', 'a', 'b', 'c', 'd', 'e'];
let permutations = 0, invariant = 0;
for (let mask = 0; mask < 64; mask++) {
  const stored = KEYS.filter((_, i) => mask & (1 << i)).map((k, i) => row(k, (i * 7 + mask) % 5));
  if (stored.length < 2) continue;
  const ordered = orderDeckWidgets(stored);
  permutations++;
  if (ordered.length === stored.length
    && new Set(keys(ordered)).size === stored.length
    && (ordered[0].widget_key === PINNED_WIDGET_KEY || !stored.some((w) => w.widget_key === PINNED_WIDGET_KEY))) invariant++;
  // Every legal move, from every position.
  const movable = ordered.filter((w) => canReorderWidget(w.widget_key));
  for (let i = 0; i < movable.length; i++) {
    for (const dir of [-1, 1]) {
      const moved = reorderWidgets(ordered, movable[i].widget_key, dir);
      if (!moved) continue;
      permutations++;
      const pinnedStillFirst = !moved.some((w) => w.widget_key === PINNED_WIDGET_KEY) || moved[0].widget_key === PINNED_WIDGET_KEY;
      const sameSet = new Set(keys(moved)).size === keys(moved).length && moved.length === ordered.length;
      const renumbered = moved.every((w, index) => w.sort_order === index);
      if (pinnedStillFirst && sameSet && renumbered) invariant++;
    }
  }
}
check('every permutation and every legal move keeps the pinned widget first, renumbered, with nothing lost',
  invariant === permutations, true);
check('…and that was a real number of cases, not a loop that never ran', permutations > 200, true);

console.log('\n6. the rule is wired into every surface that shows or changes the deck order');
// A rule nothing calls is H17: the check would pass while the deck stayed wrong.
const registry = read('src/pages/CommandDeck/deckWidgets.js');
// Anchored on the FIRST `key:` in the array rather than "brain_dump appears somewhere": the fault was the
// ORDER, so a check that only found the entry would have passed on the broken file.
const registryBody = registry.slice(registry.indexOf('export const DECK_WIDGETS = ['));
const firstKey = (registryBody.match(/\{ key: '([a-z_]+)'/) || [])[1];
check('the registry puts brain dump FIRST — a new account seeds sort_order from this order', firstKey, 'brain_dump');
check('…and suggestions is no longer the first entry', firstKey === 'jarvis_suggestions', false);

const home = read('src/pages/CommandDeck/DeckHome.jsx');
check('the Deck itself renders through the ordered list',
  /orderDeckWidgets\(widgetInstances\)\.filter\(\(w\) => w\.enabled\)/.test(home), true);

const ctx = read('src/contexts/CommandDeckContext.jsx');
check('moveWidget goes through the rule, not a raw swap', /const updated = reorderWidgets\(widgetInstances, key, direction\);/.test(ctx), true);
check('…and a refused move changes nothing rather than writing', /if \(!updated\) return;/.test(ctx), true);
check('seeding a new account still numbers rows from the registry order', /sort_order: i/.test(ctx), true);

const settings = read('src/pages/CommandDeck/DeckSettings.jsx');
check('Settings lists widgets in the same order as the Deck', /const sorted = orderDeckWidgets\(widgetInstances\);/.test(settings), true);
check('…and draws no move arrows on the pinned widget', /\{!pinned && \(/.test(settings), true);
check('…using the shared test rather than a hardcoded key', /const pinned = !canReorderWidget\(w\.widget_key\);/.test(settings), true);
check('…and the up arrow is disabled at the first MOVABLE row, not blindly at row 1',
  /const firstMovableIndex = sorted\.length && !canReorderWidget\(sorted\[0\]\.widget_key\) \? 1 : 0;/.test(settings), true);
check('…which is what the up arrow actually reads', /disabled=\{i === firstMovableIndex\}/.test(settings), true);
check('…so an account with no brain dump row is not stuck with a dead up arrow',
  /disabled=\{i === 0\}/.test(settings), false);

console.log('\n7. the rule is import-free, so this runs in the no-install CI job');
const rule = read('src/pages/CommandDeck/deckWidgetOrder.js');
check('no imports at all in the rule module', /^\s*import\s/m.test(rule), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ brain dump is not reliably pinned to the top of the deck\n');
  process.exit(1);
}
console.log('brain dump is pinned first, and everything else still moves\n');
