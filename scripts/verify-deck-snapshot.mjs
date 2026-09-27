// Runtime verification for what the Jarvis snapshot fetches, versus what it renders.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-snapshot.mjs
//
// Two things this pins:
//   1. the consignment table rendered as two numbers must be QUERIED as two numbers — it used
//      to findMany the whole unbounded table on every Jarvis message to compute a count and a
//      sum, and throw the rows away;
//   2. the set of unbounded collections is the known seven, so a NEW unbounded fetch cannot
//      appear silently in the prompt path. Each one costs prompt tokens proportional to the
//      operator's whole history, and the CRM work is about to grow two of them.
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// Comments masked: the comment explaining this quotes the old call.
const src = readFileSync(new URL('../server/src/lib/deckSnapshot.js', import.meta.url), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');

console.log('\n1. the consignment figures come from an aggregate, not from the rows');
check('the whole table is no longer fetched',
  /prisma\.deckConsignmentItem\.findMany/.test(code), false);
check('the count asks for unsold only',
  /prisma\.deckConsignmentItem\.count\(\{ where: \{ \.\.\.where, sold: false \} \}\)/.test(code), true);
check('the value is summed in the database',
  /prisma\.deckConsignmentItem\.aggregate\(\{ where: \{ \.\.\.where, sold: false \}, _sum: \{ price: true \} \}\)/.test(code), true);
check('…and the rendered line still shows both numbers',
  /CONSIGNMENT: \$\{unsoldConsign\} unsold items worth \$\$\{consignValue\} on the floor/.test(code), true);

console.log('\n2. the unbounded collections are exactly the known set');
// `findMany({ where })` — no take, no orderBy — is the unbounded shape. A collection that
// needs more than the newest N must say so here, deliberately, with a reason above.
// `deckInboxItem` left this list on 2026-09-27: it is now `take: INBOX_IN_PROMPT` with the true
// open count fetched separately and each body excerpted (verify-deck-prompt-bounds.mjs asserts
// that shape). Removing an entry here is the deliberate act this check exists to force.
// `deckRepairJob` also left this list on 2026-09-27: the queue is now `take: REPAIRS_IN_PROMPT`
// with the true open count fetched separately (asserted below). Removing an entry is the
// deliberate act this check exists to force.
const KNOWN = ['deckLifeStream', 'deckMurbahOpportunity', 'deckPerson', 'deckTask'];
const unbounded = [...code.matchAll(/prisma\.(\w+)\.findMany\(\{\s*where\s*\}\)/g)]
  .map((m) => m[1]).sort();
check('no unexpected unbounded fetch was added', unbounded.join(', '), KNOWN.join(', '));
check('…and the bounded ones stayed bounded',
  (code.match(/findMany\(\{[^)]*take:/g) || []).length >= 5, true);

console.log('\n3. the CRM view: bounded, and it answers the money question');
check('the repairs queue is bounded',
  /deckRepairJob\.findMany\(\{ where: \{ \.\.\.where, stage: \{ not: 'done' \} \}, orderBy: \{ created_date: 'desc' \}, take: REPAIRS_IN_PROMPT \}\)/.test(code), true);
check('…and its true open count is fetched separately',
  /deckRepairJob\.count\(\{ where: \{ \.\.\.where, stage: \{ not: 'done' \} \} \}\)/.test(code), true);
check('…and the line states the count, and the cap when it applies',
  /REPAIRS QUEUE: \$\{repairsOpenTotal\} open/.test(code) && /newest \$\{openRepairs\.length\} shown/.test(code), true);
check('a job with a quote and a promised date says so',
  /r\.quote \? ` quote \$\$\{r\.quote\}`/.test(code) && /promised \$\{shortDate\(r\.promised_date\)\}/.test(code), true);
check('what is owed to consignors is summed from the STORED fee, not recomputed',
  /deckConsignmentItem\.aggregate\(\{ where: \{ \.\.\.where, sold: true, paid_out: false \}, _sum: \{ fee: true \} \}\)/.test(code), true);
check('…and stated with the count of items it covers',
  /\$\{owedToConsignors\} owed to consignors on \$\{owedCount\}/.test(code), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
