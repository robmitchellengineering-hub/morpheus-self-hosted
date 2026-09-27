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
const KNOWN = ['deckInboxItem', 'deckLifeStream', 'deckMurbahOpportunity', 'deckPerson', 'deckRepairJob', 'deckTask'];
const unbounded = [...code.matchAll(/prisma\.(\w+)\.findMany\(\{\s*where\s*\}\)/g)]
  .map((m) => m[1]).sort();
check('no unexpected unbounded fetch was added', unbounded.join(', '), KNOWN.join(', '));
check('…and the bounded ones stayed bounded',
  (code.match(/findMany\(\{[^)]*take:/g) || []).length >= 5, true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
