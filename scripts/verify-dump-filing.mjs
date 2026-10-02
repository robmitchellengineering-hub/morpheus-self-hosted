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
import { summarizeFiling, captureFailureMessage } from '../src/pages/CommandDeck/dumpFiling.js';
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

console.log('\n5. an unclassified dump says so instead of reading as sorted');
check('nothing-classified explains itself',
  summarizeFiling({ labels: ['Knowledge'], fallbackReasons: ['nothing-classified'], originalText: 'x' }).message,
  'Filed to Knowledge — I could not classify it, so your words are in there whole');
check('incomplete explains a different thing',
  summarizeFiling({ labels: ['your tasks'], fallbackReasons: ['incomplete'], originalText: 'x' }).message,
  'Filed to your tasks — part of it would not classify, so the whole note was kept');
check('a clean split gets no clause',
  summarizeFiling({ labels: ['your tasks'], fallbackReasons: [], originalText: 'x' }).message,
  'Filed to your tasks');
check('the loop passes the reasons through',
  /summarizeFiling\(\{ labels, failedTexts, originalText: text, fallbackReasons \}\)/.test(readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8')), true);
check('…and collects them from the marked items',
  /if \(item\?\.fallback_reason\) fallbackReasons\.push\(item\.fallback_reason\)/.test(readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8')), true);

console.log('\n5. a capture that filed nothing says WHY, and says the words are safe');
// Rob, 2026-10-02: "just sits there doing nothing when i hit the plus button." Sixteen hours of
// production showed nothing written to any deck table, and the only signal a failed capture
// produced was a generic save flag rendered as a suffix elsewhere on the page. A silent failed
// capture is indistinguishable from a dead button, which is exactly how it was reported.
const timedOut = { code: 'CLIENT_TIMEOUT', status: 0 };
check('an expired sign-in says so, and names the next move',
  /sign-in has expired/.test(captureFailureMessage({ status: 401 })) && /[Ss]ign in again/.test(captureFailureMessage({ status: 401 })), true);
check('a timeout is not reported as a connection failure — different cause, different next move',
  /did not answer in time/.test(captureFailureMessage(timedOut)) && !/Could not reach/.test(captureFailureMessage(timedOut)), true);
check('a refused connection is a connection problem',
  /Could not reach Morpheus/.test(captureFailureMessage(new TypeError('Failed to fetch'))), true);
check('a server error is named as one, with the status',
  /server error 500/.test(captureFailureMessage({ status: 500, message: 'boom' })), true);
check('an unrecognised failure still reports rather than swallowing',
  /Nothing was filed \(418/.test(captureFailureMessage({ status: 418, message: 'teapot' })), true);
// The part that must never be left to be discovered: the words survived.
for (const [name, err] of [['timeout', timedOut], ['401', { status: 401 }], ['500', { status: 500 }], ['offline', new TypeError('Failed to fetch')], ['unknown', { status: 418 }]]) {
  check(`…and "${name}" promises the words are still in the box`,
    captureFailureMessage(err).endsWith('Your words are still in the box.'), true);
}

console.log('\n6. the wiring that makes a failure visible is present');
const ctxSrc = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
const widgetSrc = readFileSync(new URL('../src/pages/CommandDeck/widgets/brain_dump.jsx', import.meta.url), 'utf8');
check('the classify call is bounded well below the global 210s API timeout',
  /CLASSIFY_TIMEOUT_MS = 45_000/.test(ctxSrc) && /withTimeout\(base44\.functions\.invoke\('classifyDeckDumpItem'/.test(ctxSrc), true);
// The cap must not cut off the slow path that actually works: the model-enabled classify call
// measured 18-34s, and the 34s one is the last dump that filed successfully.
check('…and sits above the measured 34s slow path, so a slow success is not thrown away',
  Number((/CLASSIFY_TIMEOUT_MS = ([\d_]+)/.exec(ctxSrc) || [])[1]?.replace(/_/g, '')) > 34_000, true);
check('the outer catch binds the error and turns it into the operator-facing message',
  /catch \(err\) \{[\s\S]{0,400}setDumpError\(captureFailureMessage\(err\)\)/.test(ctxSrc), true);
check('a new press clears the previous failure',
  /setDumpInput\(''\);\n\s*setDumpError\(null\);/.test(ctxSrc), true);
check('the context actually exports it', /quickFileMsg, dumpError,/.test(ctxSrc), true);
check('the widget renders it as an alert, not as a quiet suffix',
  /\{dumpError && \(/.test(widgetSrc) && /role="alert"/.test(widgetSrc), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
