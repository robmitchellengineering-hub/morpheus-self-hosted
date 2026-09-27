// Runtime verification for the two bounded blocks in Jarvis's prompt.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-deck-prompt-bounds.mjs
//
// The rule both bounds obey: bound the SIZE, never the meaning. The last exchange stays verbatim
// (a summary of "what did we just say" answers a different question), older turns are dropped
// newest-first, and when anything is left out the block SAYS so — a capped list must never read as
// the whole picture. Same for the inbox: the true open count is always stated.
import { buildConversationBlock, excerpt, CONVERSATION_MAX_CHARS, INBOX_IN_PROMPT } from '../server/src/lib/promptBounds.js';
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the last exchange is always verbatim; older turns are bounded and named');
check('a short history is passed through with no note',
  buildConversationBlock([{ role: 'user', content: 'hi' }, { role: 'jarvis', content: 'hello' }], { firstName: 'Rob' }),
  'Rob: hi\nJarvis: hello');
const bulky = [
  { role: 'user', content: 'a'.repeat(4000) },
  { role: 'jarvis', content: 'b'.repeat(4000) },
  { role: 'user', content: 'the question' },
  { role: 'jarvis', content: 'the answer' },
];
// A tight budget, so the two 4,000-character turns cannot fit once sliced.
const bounded = buildConversationBlock(bulky, { firstName: 'Rob', maxChars: 600, perMessageChars: 500 });
check('the last two turns survive whole', bounded.endsWith('Rob: the question\nJarvis: the answer'), true);
check('older turns are left out, and the block says how many',
  bounded.startsWith('(…1 older turn left out to bound the prompt)'), true);
// Three turns, so the oldest is NOT one of the last two and is therefore sliced rather than kept.
check('an older turn that is too long is sliced, visibly',
  buildConversationBlock([{ role: 'jarvis', content: 'x'.repeat(3000) }, { role: 'user', content: 'q' }, { role: 'jarvis', content: 'a' }], { firstName: 'Rob', perMessageChars: 200 }).includes('…[truncated]'), true);
check('…and with only two turns, both are the last two and both stay whole',
  buildConversationBlock([{ role: 'jarvis', content: 'x'.repeat(3000) }, { role: 'user', content: 'q' }], { firstName: 'Rob', perMessageChars: 200 }).includes('…[truncated]'), false);
check('an empty history is still a sentence, not a blank',
  buildConversationBlock([], { firstName: 'Rob' }), '(no prior conversation)');
check('the budget is a real number', CONVERSATION_MAX_CHARS > 0, true);

console.log('\n2. an excerpt is marked, never silent');
check('short text passes through, whitespace collapsed', excerpt('  a\n\n b  '), 'a b');
check('long text is cut and marked', excerpt('x'.repeat(300)).length, 201);
check('the mark is on the end', excerpt('x'.repeat(300)).endsWith('…'), true);

console.log('\n3. the snapshot and the prompt actually use them');
const snapshot = readFileSync(new URL('../server/src/lib/deckSnapshot.js', import.meta.url), 'utf8');
const chat = readFileSync(new URL('../server/src/functions/chatWithJarvis.js', import.meta.url), 'utf8');
check('the inbox query is bounded', /deckInboxItem\.findMany\(\{ where: \{ \.\.\.where, stage: \{ not: 'done' \} \}, orderBy: \{ created_date: 'desc' \}, take: INBOX_IN_PROMPT \}\)/.test(snapshot), true);
check('…and the true open count is fetched separately', /deckInboxItem\.count\(\{ where: \{ \.\.\.where, stage: \{ not: 'done' \} \} \}\)/.test(snapshot), true);
check('…and the rendered line states it, and whether the list is capped',
  /INBOX \(\$\{inboxOpenTotal\} not yet done\$\{openInbox\.length < inboxOpenTotal \? `, newest \$\{openInbox\.length\} shown` : ''\}\)/.test(snapshot), true);
check('…and each body is excerpted', /excerpt\(i\.message\)/.test(snapshot), true);
check('the inbox is capped at a real number', INBOX_IN_PROMPT > 0, true);
check('the reply uses the bounded conversation block', /buildConversationBlock\(history, \{ firstName \}\)/.test(chat), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
