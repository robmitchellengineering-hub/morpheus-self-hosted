// Runtime verification for the Gmail inquiry sync's two hard edges.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-gmail-sync.mjs
//
//   1. It must finish inside the browser's own request timeout. Classifying up to 150
//      messages serially took minutes against a 210s client timeout, so the operator
//      reliably saw "timed out" while the server carried on working — a failure message
//      over work that was actually proceeding.
//   2. It must not file the same email twice. The seen-marker write was
//      `.catch(() => {})`, so a write failure left the message unseen, and the next sync
//      re-classified it and created a SECOND DeckInboxItem — `external_id` is documented
//      as the dedup key but the table has no unique index to enforce it.
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
// Comments are masked: several of these files quote the old code in the comment that
// explains the fix, and a regex that matches its own explanation proves only that the
// explanation exists.
const mask = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

const sync = read('../server/src/functions/syncDeckGmailInbox.js');
const syncCode = mask(sync);
const client = read('../src/api/base44Client.js');
const context = read('../src/contexts/CommandDeckContext.jsx');
const contextCode = mask(context);

console.log('\n1. the sync stops before the browser gives up on it');
const budget = Number((syncCode.match(/const SYNC_BUDGET_MS = Number\(process\.env\.DECK_GMAIL_SYNC_BUDGET_MS \|\| (\d+)\)/) || [])[1] || 0);
const clientTimeout = Number((client.match(/const API_FETCH_TIMEOUT_MS = ([\d_]+)/) || [])[1]?.replace(/_/g, '') || 0);
check('both numbers were found', budget > 0 && clientTimeout > 0, true);
check(`the server budget (${budget}ms) is inside the client timeout (${clientTimeout}ms)`,
  budget > 0 && budget < clientTimeout, true);
check('the deadline is checked before each message, not after',
  /for \(const \{ id \} of unseen\) \{\s*if \(Date\.now\(\) >= deadline\)/.test(syncCode), true);
check('stopping early leaves the page loop as well',
  /if \(stoppedEarly\) break;\s*if \(!nextPageToken\) break;/.test(syncCode), true);
check('and the caller is told, so the UI can say "more to check"',
  /return \{ checked, created, skipped: [^}]*stoppedEarly \};/.test(syncCode), true);
check('the Deck reports an early stop instead of silence',
  /stoppedEarly\) parts\.push\('More to check — tap sync again\.'\)/.test(contextCode), true);

console.log('\n2. the same email cannot be filed twice');
check('the inbox item is looked up by message id before it is created',
  syncCode.indexOf('deckInboxItem.findFirst') > 0
  && syncCode.indexOf('deckInboxItem.findFirst') < syncCode.indexOf('deckInboxItem.create'), true);
check('the lookup keys on the account and the external id',
  /deckInboxItem\.findFirst\(\{\s*where: \{ created_by_id: user\.id, external_id: full\.id \}/.test(syncCode), true);
check('the created count is only incremented for a row that was actually written',
  /if \(!already\) \{[\s\S]{0,400}created\+\+;/.test(syncCode), true);
check('the seen-marker is no longer swallowed with an empty catch',
  /\.catch\(\(\) => \{\}\)/.test(syncCode), false);
check('…the concurrent-sync race it was hiding is still tolerated',
  /err\?\.code !== 'P2002'/.test(syncCode), true);
check('…and anything else is logged rather than silent',
  /could not mark message \$\{id\} seen/.test(syncCode), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
