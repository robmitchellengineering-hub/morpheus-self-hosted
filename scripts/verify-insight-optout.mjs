// Runtime verification for the proactive-insight per-account opt-out.
//
// Dependency-free, so it runs in CI's no-install guards job alongside
// verify-drift.mjs. Run:  node scripts/verify-insight-optout.mjs
//
// Two things are checked, and the second is the one that actually rots:
//
//   1. the gate itself — absence must mean ENABLED, and junk must never be
//      able to switch the feature off for anyone
//   2. that the widget the gate keys off still exists in the frontend registry,
//      still defaults ON, and still carries the copy that makes the opt-out
//      discoverable. server/src/lib/deckInsightGate.js cannot import from src/,
//      so this file is the only thing holding the two ends together.
import { INSIGHT_WIDGET_KEY, INSIGHT_WIDGET_DEFAULT_ENABLED, isInsightOptedOut, optedOutUserIds } from '../server/src/lib/deckInsightGate.js';
import { DECK_WIDGETS } from '../src/pages/CommandDeck/deckWidgets.js';

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const row = (over = {}) => ({ widget_key: INSIGHT_WIDGET_KEY, enabled: true, ...over });

console.log('\nProactive-insight opt-out — runtime verification\n');

console.log('1. the account has to actually say no');
check('switched off -> opted out', isInsightOptedOut([row({ enabled: false })]), true);
check('switched on -> not opted out', isInsightOptedOut([row({ enabled: true })]), false);

console.log('\n2. absence means ENABLED — the failure that would opt everyone out');
check('no rows at all -> not opted out', isInsightOptedOut([]), false);
check('null -> not opted out', isInsightOptedOut(null), false);
check('undefined -> not opted out', isInsightOptedOut(undefined), false);
check('not an array -> not opted out', isInsightOptedOut({ widget_key: INSIGHT_WIDGET_KEY, enabled: false }), false);
check('only OTHER widgets present -> not opted out',
  isInsightOptedOut([{ widget_key: 'brain_dump', enabled: false }, { widget_key: 'tasks', enabled: false }]), false);
check('the widget exists but the account never touched it (row enabled) -> not opted out',
  isInsightOptedOut([row()]), false);

console.log('\n3. junk cannot switch the feature off');
check('null entry', isInsightOptedOut([null]), false);
check('entry with no key', isInsightOptedOut([{ enabled: false }]), false);
check('entry with no enabled field', isInsightOptedOut([{ widget_key: INSIGHT_WIDGET_KEY }]), false);
check('enabled is a string "false", not a boolean', isInsightOptedOut([row({ enabled: 'false' })]), false);
check('enabled is 0', isInsightOptedOut([row({ enabled: 0 })]), false);
check('a disabled row does not leak across to another key',
  isInsightOptedOut([{ widget_key: 'not_the_insight_widget', enabled: false }]), false);

console.log('\n4. a duplicate disabled row still wins (some, not every)');
check('two rows for the key, one disabled -> opted out',
  isInsightOptedOut([row({ enabled: true }), row({ enabled: false })]), true);

console.log('\n5. the batched set used by the scheduler');
const IDS = ['a', 'b', 'c'];
check('picks out only the opted-out candidates',
  [...optedOutUserIds([
    { created_by_id: 'a', widget_key: INSIGHT_WIDGET_KEY, enabled: false },
    { created_by_id: 'b', widget_key: INSIGHT_WIDGET_KEY, enabled: true },
  ], IDS)],
  ['a']);
check('ignores ids that were not candidates (a stale or foreign row)',
  [...optedOutUserIds([{ created_by_id: 'zzz', widget_key: INSIGHT_WIDGET_KEY, enabled: false }], IDS)],
  []);
check('ignores a disabled row for a different widget',
  [...optedOutUserIds([{ created_by_id: 'a', widget_key: 'tasks', enabled: false }], IDS)],
  []);
check('duplicate disabled rows collapse to one id',
  [...optedOutUserIds([
    { created_by_id: 'a', widget_key: INSIGHT_WIDGET_KEY, enabled: false },
    { created_by_id: 'a', widget_key: INSIGHT_WIDGET_KEY, enabled: false },
  ], IDS)],
  ['a']);
check('no rows -> empty set', [...optedOutUserIds([], IDS)], []);
check('junk -> empty set', [...optedOutUserIds(null, IDS)], []);
check('no candidate ids -> empty set',
  [...optedOutUserIds([{ created_by_id: 'a', widget_key: INSIGHT_WIDGET_KEY, enabled: false }], [])],
  []);

console.log('\n6. the frontend end of the contract still exists (server cannot import from src/)');
const entry = DECK_WIDGETS.find((w) => w.key === INSIGHT_WIDGET_KEY);
check('a widget with the gate\'s key is registered in deckWidgets.js', !!entry, true);
check('it defaults to the same enabled state the gate assumes',
  entry?.defaultEnabled, INSIGHT_WIDGET_DEFAULT_ENABLED);
check('it is listed exactly once',
  DECK_WIDGETS.filter((w) => w.key === INSIGHT_WIDGET_KEY).length, 1);

console.log('\n7. the opt-out is discoverable — an invisible control is not an opt-out');
check('the widget carries explanatory copy', typeof entry?.note === 'string' && entry.note.trim().length > 0, true);
check('the copy names what switching it off actually does', /proactive insight/i.test(entry?.note || ''), true);

// Read the settings card directly: a `note` nobody renders is the same as no
// note at all, and the JSX is the only place that can be checked.
const { readFileSync } = await import('node:fs');
const settingsSrc = readFileSync(new URL('../src/pages/CommandDeck/DeckSettings.jsx', import.meta.url), 'utf8');
check('DeckSettings.jsx renders the note it is given', /meta\.note\s*&&/.test(settingsSrc), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
