// Runtime verification for Jarvis's reply-length budget, the bounded repair pass, and the
// long-form path that must survive both.
//
// Dependency-free (a pure module, plus source assertions on the handler that needs Prisma), so it
// runs in CI's no-install guards job.
// Run:  node scripts/verify-jarvis-reply-length.mjs
//
// WHY THIS EXISTS (2026-10-03, measured — Rob's own complaint)
//
// Rob chatted with Jarvis, got an answer, and then wrote: "that was still a bit long how much
// money do you think there is waiting in the emails". The reply to THAT came back 743 output
// tokens — roughly 550 words — in 9.0 s, against a persona that already said "Match your reply's
// length to the question … keep it short enough to speak aloud: usually one to four sentences."
// The instruction was present and the model ignored it, so the fix is the reply's SHAPE (an
// explicit role, a `{ reply: string }` schema, one bounded repair pass) and NOT a smaller
// MAX_REPLY_TOKENS — a smaller cap turns verbosity into OUTPUT_TRUNCATED (H6), which is why
// MODEL-DECISIONS.md records three separate instances of that mistake.
//
// Four claims, each with a way to fail:
//
//   1. THE BUDGET IS NAMED DATA AND THE BOUNDARY IS EXACT — at the target no repair, one
//      character over it a repair, and the target sits under CONVERSATION_PER_MESSAGE_CHARS so a
//      compliant reply can never be sliced in the next turn's conversation block.
//   2. THE REPAIR IS LOSSLESS-OR-NOTHING — a truncated, junk, empty or no-shorter rewrite keeps
//      the ORIGINAL reply, and an empty original is never manufactured into one.
//   3. THE LONG-FORM PATH IS PRESERVED — an explicit report/plan/breakdown request is exempt
//      from the budget and its reply is never repaired.
//   4. THE HANDLER WIRES THE SHAPE, not a chop — the reply call names its role and takes
//      REPLY_SCHEMA, the one repair pass runs on the cheap prose role through `repairDecision`,
//      a truncation of the schema call falls back to prose rather than losing the answer, and
//      the reply's size (and whether the repair fired) is logged, lengths only.
import { readFileSync } from 'node:fs';

import { CONVERSATION_PER_MESSAGE_CHARS } from '../server/src/lib/promptBounds.js';
import {
  CONVERSATIONAL_REPLY_TARGET_CHARS,
  REPLY_SCHEMA,
  REPAIR_SCHEMA,
  buildRepairPrompt,
  extractReply,
  isLongFormRequest,
  replyCharCount,
  repairDecision,
  shouldRepairReply,
} from '../server/src/lib/jarvisReplyBudget.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
// Whole-line `//` comments and block comments masked before any source assertion, so a regex
// cannot be satisfied by the comment that explains the fix (H19).
const maskComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const occurrences = (haystack, needle) => haystack.split(needle).length - 1;

const budgetSrc = read('server/src/lib/jarvisReplyBudget.js');
const chatSrc = maskComments(read('server/src/functions/chatWithJarvis.js'));

console.log('\n1. the budget is named data, and the boundary is exact');
check('the target is a positive, named number',
  Number.isInteger(CONVERSATIONAL_REPLY_TARGET_CHARS) && CONVERSATIONAL_REPLY_TARGET_CHARS > 0, true);
check('a reply AT the target is left alone',
  shouldRepairReply('x'.repeat(CONVERSATIONAL_REPLY_TARGET_CHARS)), false);
check('…and the fixture really is exactly at the target (H19: check the fixture)',
  'x'.repeat(CONVERSATIONAL_REPLY_TARGET_CHARS).length, CONVERSATIONAL_REPLY_TARGET_CHARS);
check('one character OVER the target is repaired',
  shouldRepairReply('x'.repeat(CONVERSATIONAL_REPLY_TARGET_CHARS + 1)), true);
check('a reply the size Rob complained about is repaired',
  shouldRepairReply('word '.repeat(660)), true);
check('an empty reply is not "repaired" — emptiness is refused upstream, not rewritten',
  [shouldRepairReply(''), shouldRepairReply('   '), shouldRepairReply(null), shouldRepairReply(undefined)],
  [false, false, false, false]);
check('replyCharCount measures the trimmed length', replyCharCount('  abc  '), 3);
check('the target is under the conversation block\'s per-message slice, so a compliant reply is never sliced',
  CONVERSATIONAL_REPLY_TARGET_CHARS < CONVERSATION_PER_MESSAGE_CHARS, true);
check('the schema carries the length rule, so it is in the contract on every call',
  REPLY_SCHEMA.properties.reply.description.includes(`about ${CONVERSATIONAL_REPLY_TARGET_CHARS} characters`), true);
check('…and says plainly that a genuine long-form ask may go longer',
  /Only go longer when the user actually asked for a report, plan, breakdown/.test(REPLY_SCHEMA.properties.reply.description), true);
check('the schema is the { reply: string } shape on both calls',
  [REPLY_SCHEMA.required, REPAIR_SCHEMA.required, REPLY_SCHEMA.properties.reply.type, REPAIR_SCHEMA.properties.reply.type],
  [['reply'], ['reply'], 'string', 'string']);

console.log('\n2. the repair is lossless-or-nothing — the original always survives a failure');
const original = 'A long reply. '.repeat(60).trim();
check('a shorter, usable rewrite IS accepted',
  repairDecision({ original, result: { reply: 'A short reply.' } }),
  { repaired: true, reply: 'A short reply.', reason: 'repaired' });
check('a TRUNCATED rewrite keeps the original even when the payload looks complete',
  repairDecision({ original, result: { reply: 'A short reply.' }, truncated: true }),
  { repaired: false, reply: original, reason: 'truncated' });
check('a junk rewrite keeps the original',
  repairDecision({ original, result: 'not json at all' }).reply, original);
check('an absent rewrite keeps the original',
  repairDecision({ original, result: undefined }).reply, original);
check('a reply field of the wrong type keeps the original',
  repairDecision({ original, result: { reply: 42 } }).reply, original);
check('an empty or whitespace rewrite keeps the original',
  [repairDecision({ original, result: { reply: '' } }).reason, repairDecision({ original, result: { reply: '   ' } }).reason],
  ['unusable', 'unusable']);
check('a rewrite that is not shorter keeps the original — the pass can only help',
  repairDecision({ original, result: { reply: original } }),
  { repaired: false, reply: original, reason: 'no-shorter' });
check('…and a LONGER rewrite keeps the original too',
  repairDecision({ original, result: { reply: `${original} more` } }).reason, 'no-shorter');
check('an empty original is never manufactured into a reply',
  repairDecision({ original: '', result: { reply: 'invented' } }),
  { repaired: false, reply: '', reason: 'no-shorter' });
check('a plain-string result is tolerated — the prose fallback reaches the same decision',
  extractReply('the answer'), 'the answer');
check('…and is trimmed, so trailing whitespace cannot defeat the empty check', extractReply('  ok  '), 'ok');
check('an unusable result extracts to empty', [extractReply({}), extractReply(null), extractReply([1])], ['', '', '']);

console.log('\n3. the long-form path is preserved — a report is still a report');
for (const [message, expected] of [
  ['give me a full report on the emails', true],
  ['make me a plan for the week', true],
  ['break that down for me', true],
  ['walk me through it step by step', true],
  ['explain in detail', true],
  ['write up what happened', true],
  ['compare the two options', true],
  ['summarise everything from yesterday', true],
  ['list what is outstanding', true],
  // Rob's own offending turn — a quick question, so the budget DOES apply.
  ['that was still a bit long how much money do you think there is waiting in the emails', false],
  ['how much money is waiting in the emails', false],
  ['say hello to my sister', false],
]) {
  check(`"${message.slice(0, 48)}" → longForm=${expected}`, isLongFormRequest(message), expected);
}
check('a long-form turn is never repaired, however long the reply',
  shouldRepairReply(original, { longForm: true }), false);
check('…while the same reply on a conversational turn is', shouldRepairReply(original, { longForm: false }), true);
check('the module header says where the longer path is preserved',
  /CONVERSATIONAL TURNS ONLY/.test(budgetSrc) && /THE LONG PATH IS PRESERVED/.test(budgetSrc), true);
check('the repair prompt names the limit and the fact-preservation rule it is accepted on',
  new RegExp(`at most ${CONVERSATIONAL_REPLY_TARGET_CHARS} characters`).test(buildRepairPrompt({ reply: 'x' })) && /Keep EVERY fact/.test(buildRepairPrompt({ reply: 'x' })), true);
check('the repair prompt carries the reply it is rewriting',
  buildRepairPrompt({ reply: 'the actual reply' }).includes('the actual reply'), true);

console.log('\n4. the handler wires the SHAPE, not a chop');
check('the reply call names the persona role (planner = pro @ 0.7, the default it already ran on)',
  /schema: REPLY_SCHEMA, role: 'planner'/.test(chatSrc), true);
check('…and passes the reply schema', /schema: REPLY_SCHEMA/.test(chatSrc), true);
check('…and the token cap is NOT lowered to force the length',
  /MAX_REPLY_TOKENS = 6000/.test(chatSrc), true);
check('the one repair pass runs on the cheap prose role',
  /schema: REPAIR_SCHEMA,\s*role: 'draft'/.test(chatSrc), true);
check('…and is decided, not guessed — repairDecision owns it',
  /const decision = repairDecision\(\{ original: reply, result: repairResult, truncated: repairTruncated \}\)/.test(chatSrc), true);
check('…and only a REPAIRED decision replaces the reply',
  /if \(decision\.repaired\) \{\n\s*reply = decision\.reply;/.test(chatSrc), true);
check('…so a failed repair keeps the original', /reply repair failed — keeping the original reply/.test(chatSrc), true);
check('…and a repair that was kept-out is named in the log', /reply repair kept the original/.test(chatSrc), true);
check('the reply is never chopped with a slice', /\.slice\(0,\s*CONVERSATIONAL_REPLY_TARGET_CHARS\)/.test(chatSrc), false);
check('the pass is asked exactly once, not in a loop',
  occurrences(chatSrc, 'shouldRepairReply(reply, { longForm })') === 1
    && !/while\s*\(|for\s*\(/.test(chatSrc.slice(chatSrc.indexOf('let repaired = false;'), chatSrc.indexOf('reply chars:'))), true);
check('the handler decides long-form from the user\'s own message',
  /const longForm = isLongFormRequest\(message\)/.test(chatSrc), true);
check('a SCHEMA truncation falls back to prose rather than losing the answer (H6)',
  /if \(!\/\^OUTPUT_TRUNCATED\/\.test\(err\?\.message \|\| ''\)\) throw err;/.test(chatSrc)
    && /retrying as plain prose so a long answer is not lost/.test(chatSrc), true);
check('an empty reply is still refused, before anything is stored',
  /if \(!String\(reply \|\| ''\)\.trim\(\)\)/.test(chatSrc) && /Jarvis returned an empty reply — nothing was stored/.test(chatSrc), true);

console.log('\n5. the reply\'s size is visible, lengths only');
const sizeLog = (chatSrc.match(/`\[chatWithJarvis\] reply chars:[\s\S]*?`/) || [''])[0];
check('the handler logs the reply\'s size', sizeLog.length > 0, true);
check('…and whether the repair fired', /\$\{repaired\}/.test(sizeLog), true);
check('…and the target it was measured against', /\$\{CONVERSATIONAL_REPLY_TARGET_CHARS\}/.test(sizeLog), true);
check('…and whether the turn was long-form, so the exemption is visible too', /\$\{longForm\}/.test(sizeLog), true);
check('…and it is a LENGTH only, never the reply content', /\$\{reply\.length\}/.test(sizeLog), true);
check('…and it does not log the reply text itself', /\$\{reply\}/.test(sizeLog), false);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
