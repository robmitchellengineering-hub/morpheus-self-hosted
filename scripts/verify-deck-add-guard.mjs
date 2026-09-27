// Runtime verification that a deck add cannot be submitted twice, and that a busy add says so.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-add-guard.mjs
//
// Why this exists (Rob, 2026-09-28): "i was able to hot the button twice in repairs and it
// entered the entry twice ... it just greys out ... it needs to be obvious something is happening
// and you need to wait". Two halves of one missing thing. Until this, ONLY the brain dump had a
// re-entrancy guard; every other add was `if (!input.trim()) return` followed by a network call,
// which two presses in the same tick BOTH pass — React state is not visible to a second press in
// the same tick, so only a ref stops it. And a control that greys with no explanation reads as a
// dead one, so the guard's pending state has to reach the screen.
//
// The failure mode this pins is silent duplication of the operator's own data, which no type
// check, lint rule or build can see: both creates succeed and two identical rows exist.
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const ctx = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/pages/CommandDeck/widgets/signal_chain.jsx', import.meta.url), 'utf8');
const tasks = readFileSync(new URL('../src/pages/CommandDeck/widgets/tasks.jsx', import.meta.url), 'utf8');
const inbox = readFileSync(new URL('../src/pages/CommandDeck/widgets/inbox.jsx', import.meta.url), 'utf8');
const deckUi = readFileSync(new URL('../src/pages/CommandDeck/DeckUI.jsx', import.meta.url), 'utf8');

console.log('\n1. one guard, and it is a ref (state cannot see a same-tick second press)');
check('the in-flight set is a ref, keyed per form',
  /const addInFlight = useRef\(new Set\(\)\);/.test(ctx), true);
check('a duplicate key is refused before anything runs',
  /if \(addInFlight\.current\.has\(key\)\) return Promise\.resolve\(false\);/.test(ctx), true);
check('the key is released in a finally, so a failure cannot wedge the form for good',
  /\.finally\(\(\) => \{\s*addInFlight\.current\.delete\(key\);/.test(ctx), true);
check('…and the pending flag is cleared with it',
  /delete next\[key\];/.test(ctx), true);
check('a throwing handler cannot become an unhandled rejection',
  /\(err\) => \{\s*console\.error\(`\[deck\] add "\$\{key\}" failed:`[\s\S]{0,80}return false;/.test(ctx), true);

console.log('\n2. every add that writes a row goes through it');
const GUARDED = {
  addDump: 'dump',
  addTask: 'task',
  addPerson: 'person',
  addConsignment: 'consignment',
  addRepair: 'repair',
  addStrategy: 'strategy',
  addKnowledge: 'knowledge',
  addInbox: 'inbox',
  addCalendarEvent: 'calendar',
};
// Keyed per JOB, not globally: adding files to one repair must not block another job's upload.
check('addFilesToJob is guarded, keyed per target',
  /const addFilesToJob = [^\n]*guardAdd\(`jobFiles:\$\{jobId\}`/.test(ctx), true);
for (const [fn, key] of Object.entries(GUARDED)) {
  check(`${fn} is guarded`,
    new RegExp(`const ${fn} = [^\\n]*guardAdd\\('${key}'`).test(ctx), true);
}
// The deliberate exception, asserted by name so the list of unguarded adds cannot quietly grow.
// addLifeNote RETURNS whether anything landed (the dump's partial-failure accounting reads it),
// and its field clears synchronously on submit, so a duplicate press has nothing to send.
check('addLifeNote is the only unguarded add, and it is not wrapped',
  /const addLifeNote = async \(streamKey, text\) => \{/.test(ctx)
  && !/addLifeNote = [^\n]*guardAdd/.test(ctx), true);
const unguarded = [...ctx.matchAll(/const (add\w+) = async \(/g)].map((m) => m[1]);
check('no other add was left unguarded', unguarded.join(', '), 'addLifeNote');

console.log('\n3. the pending state reaches the screen');
check('the note component exists and renders nothing unless busy',
  /export function PendingNote\(\{ show, text = 'Saving…', color = C\.walnutSoft \}\) \{\s*if \(!show\) return null;/.test(deckUi), true);
check('the dump reads the SAME guard (no second source of truth)',
  /dumpPending: !!addPending\.dump,/.test(ctx), true);
check('…and the old bespoke dump pair is gone', /dumpInFlight/.test(ctx), false);
for (const [file, name, key] of [
  [ui, 'signal_chain', 'consignment'],
  [ui, 'signal_chain', 'repair'],
  [tasks, 'tasks', 'task'],
  [inbox, 'inbox', 'inbox'],
]) {
  check(`${name}: the busy state disables the control`,
    new RegExp(`disabled=\\{[^}]*addPending\\.${key}\\}`).test(file)
    || new RegExp(`disabled=\\{adding\\}`).test(file), true);
  check(`${name}: a note says what it is waiting for (${key})`,
    /<PendingNote show=\{/.test(file), true);
}
check('the busy add row is not interactive while it works',
  (ui.match(/pointerEvents: adding \? 'none' : 'auto'/g) || []).length >= 2, true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
