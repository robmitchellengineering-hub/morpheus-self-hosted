// Runtime verification for what the brain dump says after filing, and what it puts back.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-dump-filing.mjs
//
// Two lies this file exists to prevent, both of which cost the operator data:
//   - a create failing mid-loop restored the WHOLE dump while the rows already written
//     stayed, so the retry duplicated everything that had succeeded;
//   - a swallowed life-stream failure was still counted in the green "Filed N items"
//     line, so a lost note read as filed.
import { summarizeFiling } from '../src/pages/CommandDeck/dumpFiling.js';
import { readFileSync } from 'node:fs';

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

console.log('\n1. everything landed — the message is what it always was');
check('one item', summarizeFiling({ labels: ['your tasks'], originalText: 'get milk' }),
  { message: 'Filed to your tasks', restore: '', landed: 1, total: 1 });
check('several items', summarizeFiling({ labels: ['your tasks', 'Strategy'], originalText: 'x' }),
  { message: 'Filed 2 items: your tasks, Strategy', restore: '', landed: 2, total: 2 });
check('repeated destinations are de-duplicated for display',
  summarizeFiling({ labels: ['your tasks', 'your tasks'], originalText: 'x' }).message,
  'Filed 2 items: your tasks');
check('nothing is put back when nothing failed',
  summarizeFiling({ labels: ['Knowledge'], originalText: 'the whole dump' }).restore, '');

console.log('\n2. a partial failure says so, and only the missing items come back');
check('the count is "of" the total, not the whole dump',
  summarizeFiling({ labels: ['your tasks', 'your tasks'], failedTexts: ['get milk'], originalText: 'the whole dump' }).message,
  'Filed 2 of 3: your tasks');
check('only what did not land goes back in the box',
  summarizeFiling({ labels: ['your tasks'], failedTexts: ['get milk', 'chase the quote'], originalText: 'the whole dump' }).restore,
  'get milk. chase the quote');
check('a life-stream failure is just another failed item',
  summarizeFiling({ labels: ['your tasks'], failedTexts: ['I am stressed about money'], originalText: 'x' }).landed, 1);

console.log('\n3. nothing landed — the whole dump comes back, and no success line is claimed');
check('all failed', summarizeFiling({ labels: [], failedTexts: ['get milk'], originalText: 'get milk and pay the rego' }),
  { message: null, restore: 'get milk and pay the rego', landed: 0, total: 1 });
check('nothing to file at all', summarizeFiling({ labels: [], failedTexts: [], originalText: 'x' }),
  { message: null, restore: 'x', landed: 0, total: 0 });

console.log('\n4. the loop that feeds it keeps its promise');
// Comments are masked: the explanatory comments beside this code quote the old
// behaviour, and a regex that matches its own explanation proves only that the
// explanation exists.
const src = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
check('each item is filed inside its own try/catch',
  (code.match(/failedTexts\.push\(itemText\)/g) || []).length, 2);
check('the success line is the one the ledger produced',
  /flagQuickFile\(outcome\.message\)/.test(code), true);
check('what did not land is put back',
  /setDumpInput\(outcome\.restore\)/.test(code), true);
check('the outer catch restores the whole dump only when nothing landed',
  /if \(!labels\.length\) setDumpInput\(text\);/.test(code), true);
check('the ledger is declared outside the try, so that check can see it',
  code.indexOf('const labels = [];') < code.indexOf('const outcome = summarizeFiling'), true);
check('a life-stream note reports whether it saved',
  /if \(!\(await addLifeNote\(item\.life_stream_key, itemText\)\)\)/.test(code), true);
check('…and addLifeNote returns a boolean rather than swallowing the failure',
  /catch \{ flagSaveErr\(\); return false; \}/.test(code) && /return true;/.test(code), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
