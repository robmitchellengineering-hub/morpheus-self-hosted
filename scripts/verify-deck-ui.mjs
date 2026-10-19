// Runtime verification that the deck's editing surfaces are reachable, and that a control row fits
// the tile it is in on a phone.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-ui.mjs
//
// Two reports from Rob, 2026-09-28, and neither was a missing feature:
//
//  1. "I need to be able to edit peoples email name and phone number in tasks." The editor had
//     existed since #172 — name, phone and email, saved as you type — behind a toggle labelled
//     "Manage people", which names no field and reads as group administration rather than "edit
//     this person's phone number". A capability nobody can find is not a capability, so the label
//     is pinned here along with the second way in (the pencil on an owner's row).
//  2. "The calender buttons are haning off the tile on mobile." The add row could not wrap, and a
//     flex item will not shrink below its content's intrinsic width without `minWidth: 0` — with a
//     date input's large intrinsic width, the row ran off the card. Both halves are pinned.
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const tasks = readFileSync(new URL('../src/pages/CommandDeck/widgets/tasks.jsx', import.meta.url), 'utf8');
const calendar = readFileSync(new URL('../src/pages/CommandDeck/widgets/calendar.jsx', import.meta.url), 'utf8');
const deckUi = readFileSync(new URL('../src/pages/CommandDeck/DeckUI.jsx', import.meta.url), 'utf8');
const deckCtx = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');

console.log('\n1. the person editor says what it edits, and is reachable where the person is');
check('the toggle names the three fields, not "Manage people"',
  /People — edit name, phone, email/.test(tasks) && !/>\s*Manage people\s*</.test(tasks), true);
check('the name field is editable', /value=\{p\.name\}[\s\S]{0,80}updatePersonName\(p\.id/.test(tasks), true);
check('the phone field is editable, with the phone keypad', /type="tel"[\s\S]{0,160}updatePersonPhone\(p\.id/.test(tasks), true);
check('the email field is editable, with the email keyboard', /type="email"[\s\S]{0,160}updatePersonEmail\(p\.id/.test(tasks), true);
check('it says the edits save themselves', /Changes save as you type/.test(tasks), true);
check('there is a second way in, on the owner row itself',
  /Edit \$\{p\.name\}'s name, phone and email/.test(tasks) && /setManagePeople\(true\)/.test(tasks), true);
check('that pencil does not also toggle the owner open (it stops the click)',
  /e\.stopPropagation\(\); setManagePeople\(true\);/.test(tasks), true);

console.log('\n2. a control row cannot run off the tile');
// The floor: every deck field uses one of these two, so this is where the overflow is prevented.
check('the shared input styles can shrink below their intrinsic width',
  /flex: 1, minWidth: 0, boxSizing: 'border-box'/.test(deckUi)
  && /minWidth: 0, boxSizing: 'border-box'/.test(deckUi), true);
check('the calendar add row wraps', /flexWrap: 'wrap', marginBottom: '0\.7rem' \}\}>/.test(calendar), true);
check('…and the date input may shrink rather than push the button out',
  /flex: '1 1 130px', minWidth: 0/.test(calendar), true);
check('…and the mic field wrapper may shrink too',
  /wrapperStyle=\{\{ minWidth: 0, flex: '1 1 160px' \}\}/.test(calendar), true);

console.log('\n3. a dismissed widget-build card stays dismissed');
// Rob, 2026-09-29: "the hung state is still in settings." The card was not hung — the build had
// finished — but the X only cleared component state while the effect re-reads the NEWEST row on every
// mount, so the card returned on every reload. A dismissal nobody can make stick reads exactly like a
// stuck build, which is why this is pinned rather than left to a comment.
//
// That rule has since moved OUT of the context and into `src/lib/deckWidgetBuildCard.js`, which also
// gives a finished card a 24-hour expiry (Rob, 2026-10-04: "we still have that failed widget in my
// settings"). So these assertions check the context DELEGATES, and the suppression and expiry rules
// themselves are pinned — with their own instances and boundary cases — in
// `scripts/verify-deck-widget-build.mjs`, sections 7 and 8.
check('the dismissed build id is remembered, not just dropped from state',
  /localStorage\.setItem\(DISMISSED_WIDGET_BUILD_KEY/.test(deckCtx), true);
check('…and read back before the newest row is shown',
  /localStorage\.getItem\(DISMISSED_WIDGET_BUILD_KEY\)/.test(deckCtx), true);
check('the show/hide decision is delegated to the one shared rule',
  /shouldShowWidgetBuildCard\(latest, \{ dismissedId \}\)/.test(deckCtx), true);
check('…and the context no longer decides it inline (the rule owns it now)',
  /settled && latest\.id === dismissedId \? null : latest/.test(deckCtx), false);
check('…and an unfinished build still shows and keeps polling',
  /if \(latest && !settled\)/.test(deckCtx), true);
check('the key is namespaced to the deck, not a bare word',
  /'morpheus\.deck\.dismissedWidgetBuild'/.test(deckCtx), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
