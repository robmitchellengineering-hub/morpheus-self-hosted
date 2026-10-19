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
// 2026-10-03: the rendering moved to lib/deckSnapshotText.js (import-free). `code` is the
// query half that stays here; `text` is where the rendered lines are asserted.
const src = readFileSync(new URL('../server/src/lib/deckSnapshot.js', import.meta.url), 'utf8');
const code = src.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/^[ \t]*\/\/.*$/gm, ' ');
const text = readFileSync(new URL('../server/src/lib/deckSnapshotText.js', import.meta.url), 'utf8');

console.log('\n1. the consignment figures come from an aggregate, not from the rows');
check('the whole table is no longer fetched',
  /prisma\.deckConsignmentItem\.findMany/.test(code), false);
check('the count asks for unsold only',
  /prisma\.deckConsignmentItem\.count\(\{ where: \{ \.\.\.where, sold: false \} \}\)/.test(code), true);
check('the value is summed in the database',
  /prisma\.deckConsignmentItem\.aggregate\(\{ where: \{ \.\.\.where, sold: false \}, _sum: \{ price: true \} \}\)/.test(code), true);
check('…and the rendered line still shows both numbers',
  /CONSIGNMENT: \$\{consignment\.unsoldCount\} unsold items worth \$\$\{consignment\.value\} on the floor/.test(text), true);

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
  /REPAIRS QUEUE: \$\{repairs\.total\} open\$\{truncationNote\(repairs\.rows\.length, repairs\.total\)\}/.test(text), true);
check('a job with a quote and a promised date says so',
  /r\.quote \? ` quote \$\$\{r\.quote\}`/.test(text) && /promised \$\{day\(r\.promised_date\)\}/.test(text), true);
check('what is owed is the sale price minus the STORED fee, both summed in the database',
  /deckConsignmentItem\.aggregate\(\{\s*where: \{ \.\.\.where, sold: true, paid_out: false, sold_price: \{ not: null \}, fee: \{ not: null \} \},\s*_sum: \{ sold_price: true, fee: true \},\s*\}\)/.test(code), true);
// The one arithmetic error this line can make is reporting our own commission as money owed to a
// consignor — `fee` is the shop's cut. Pinned as a subtraction so a future edit cannot quietly go
// back to summing it.
check('…and it is a subtraction, not the fee itself',
  /owedToConsignors: \(owedAgg\._sum\.sold_price \|\| 0\) - \(owedAgg\._sum\.fee \|\| 0\),/.test(code), true);
check('…and stated with the count of items it covers',
  /\$\{consignment\.owedToConsignors\} owed to consignors on \$\{consignment\.owedCount\}/.test(text), true);
check('rows missing a price or a fee are counted, not silently treated as zero (H13)',
  /deckConsignmentItem\.count\(\{\s*where: \{\s*\.\.\.where,\s*sold: true,\s*paid_out: false,\s*OR: \[\{ sold_price: null \}, \{ fee: null \}\],\s*\},\s*\}\)/.test(code), true);
check('…and the line says the total is short when they exist',
  /\$\{consignment\.owedIncomplete\} with no sale price or fee recorded, so that amount is short/.test(text), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
