// Runtime verification for the inbox reply draft's failure path.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-draft.mjs
//
// The draft used to fail in two ways that both left the operator guessing: an empty 200
// came back as a successful `{ reply: '' }` — a blank box, indistinguishable from "Jarvis
// had nothing to say" — and a failure cleared the box and raised the generic
// "couldn't save last change — try again", which points at storage rather than at the AI
// call that actually failed.
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

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
// Comments are masked: the comment explaining the fix quotes the old behaviour, and a
// regex that matches its own explanation proves only that the explanation exists.
const mask = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const server = mask(read('../server/src/functions/suggestDeckReply.js'));
const context = mask(read('../src/contexts/CommandDeckContext.jsx'));
const widget = read('../src/pages/CommandDeck/widgets/inbox.jsx');

console.log('\n1. the server does not hand back an empty draft as a success');
check('an empty reply throws rather than returning { reply: "" }',
  /if \(!draft\) \{[\s\S]{0,400}throw new Error\('Jarvis returned an empty draft/.test(server), true);
check('…and the trim cannot throw on a null result',
  /String\(reply \|\| ''\)\.trim\(\)/.test(server), true);
check('the success path still returns the draft',
  /return \{ reply: draft \};/.test(server), true);

console.log('\n2. the panel says what actually failed');
check('a failure no longer reports a save error',
  /catch \(err\) \{[\s\S]{0,500}setReplyDraftErr\(err\?\.message/.test(context), true);
// Sliced rather than regexed between two known markers: a greedy match across the whole
// file would prove nothing about THIS function.
const startAt = context.indexOf('const startReplyDraft');
const endAt = context.indexOf('const cancelReplyDraft');
const draftFn = startAt >= 0 && endAt > startAt ? context.slice(startAt, endAt) : '';
check('the draft function was found', draftFn.length > 0, true);
check('…and it no longer calls flagSaveErr, which blamed a save for an AI failure',
  /flagSaveErr/.test(draftFn), false);
check('an empty draft from a stale server is called out too',
  /empty draft — ask again/.test(context), true);
check('the message is cleared when a new attempt starts',
  /setReplyDraftErr\(null\);\s*setReplyBusy\(true\)/.test(context), true);
check('…and when the draft is cancelled',
  /cancelReplyDraft = \(\) => \{[\s\S]{0,200}setReplyDraftErr\(null\)/.test(context), true);
check('the context exposes it to the widget',
  /replyBusy, replyDraftErr, startReplyDraft/.test(context), true);

console.log('\n3. the widget shows it instead of an unexplained blank box');
check('the widget reads it from the context',
  /replyBusy, replyDraftErr, startReplyDraft/.test(widget), true);
check('…and renders it beside the empty box',
  /\{replyDraftErr && \(/.test(widget), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
