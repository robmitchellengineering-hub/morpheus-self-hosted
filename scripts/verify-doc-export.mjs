// Runtime verification for document export — the parts that decide rather than draw.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-doc-export.mjs
//
// Rob's audit of the old base44 deck (DECK-OLD-VS-NEW.md §4): its DocumentSheet could emit a Google Doc,
// Sheet, PDF, Word and Excel file; the ported Deck can emit a Google Doc only. The PDF/Word drawing cannot
// be asserted without a browser, but every DECISION behind it can be — and the decisions are where a silent
// wrong answer lives: a filename that loses its extension, a cell with a comma in it breaking the columns,
// a separator guessed wrong.
import { readFileSync } from 'node:fs';
import { safeFilename, textToCsv, paragraphs, looksTabular } from '../src/pages/CommandDeck/exportDoc.js';

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

console.log('\n1. a filename survives the trip to a downloads folder');
check('spaces become hyphens', safeFilename('My Great Plan'), 'My-Great-Plan');
check('punctuation is stripped, not escaped', safeFilename('Plan: Q4 / 2026?'), 'Plan-Q4-2026');
check('runs collapse', safeFilename('a   ---   b'), 'a-b');
check('it never starts or ends on a hyphen', safeFilename('  - hello -  '), 'hello');
check('long names are capped', safeFilename('x'.repeat(200)).length, 80);
// The one that matters: a name of nothing but punctuation must not become ".pdf".
check('an empty result falls back', safeFilename('...'), 'morpheus-document');
check('…and so does a blank one', safeFilename('   '), 'morpheus-document');
check('…and so does null', safeFilename(null), 'morpheus-document');
check('the fallback is overridable', safeFilename('', 'deck-note'), 'deck-note');

console.log('\n2. a table becomes a CSV a spreadsheet opens in columns');
check('tabs are the separator Jarvis is asked for', textToCsv('a\tb\tc'), 'a,b,c');
check('a spaced pipe works too', textToCsv('a | b | c'), 'a,b,c');
check('a bare pipe works too', textToCsv('a|b|c'), 'a,b,c');
check('rows are CRLF — what Excel expects', textToCsv('a\tb\nc\td'), 'a,b\r\nc,d');
// The quoting rule: a comma inside a cell must not split the row.
check('a comma inside a cell is quoted', textToCsv('a\tb, still b'), 'a,"b, still b"');
check('a quote inside a cell is doubled', textToCsv('a\tsay "hi"'), 'a,"say ""hi"""');
check('a tab-separated row with a pipe is NOT re-split', textToCsv('a\tb|c'), 'a,b|c');
// Blank lines are formatting, not rows.
check('blank lines are dropped', textToCsv('a\tb\n\n\nc\td'), 'a,b\r\nc,d');
check('a single line is still one row', textToCsv('just a line'), 'just a line');
check('nothing at all is empty, not a throw', [textToCsv(''), textToCsv(null)], ['', '']);

console.log('\n3. paragraphs keep the shape the operator read');
check('a blank line breaks', paragraphs('one\n\ntwo'), ['one', 'two']);
check('a single newline does not — lists and wraps survive', paragraphs('one\ntwo'), ['one\ntwo']);
check('trailing blank lines vanish', paragraphs('one\n\n\n'), ['one']);
check('an empty reply has no paragraphs', paragraphs(''), []);

console.log('\n4. only a real table offers a spreadsheet');
check('two tab-separated lines are tabular', looksTabular('a\tb\nc\td'), true);
check('two piped lines are tabular', looksTabular('a | b\nc | d'), true);
check('prose is not', looksTabular('This is a sentence.\nAnd another one.'), false);
// One line can never be a table, however many separators it has.
check('a single line is never tabular', looksTabular('a | b | c'), false);
check('nothing is not tabular', [looksTabular(''), looksTabular(null)], [false, false]);

console.log('\n5. the export is actually reachable, and jspdf is already a dependency');
const pkg = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
const jarvis = readFileSync(new URL('../src/pages/CommandDeck/DeckJarvis.jsx', import.meta.url), 'utf8');
check('jspdf ships with the app, so PDF needs no new package', /"jspdf"/.test(pkg), true);
check('the helpers are used by the Jarvis surface', /exportDoc|safeFilename|textToCsv/.test(jarvis), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
