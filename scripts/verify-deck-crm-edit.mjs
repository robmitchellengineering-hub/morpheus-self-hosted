// Runtime verification that the consignment and repair records can actually be EDITED, and that the
// money they carry is written honestly.
//
// Dependency-free (source assertions only), so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-crm-edit.mjs
//
// Why this exists: `person_id`, `fee`, `sold_price`, `sold_date`, `paid_out` on
// `DeckConsignmentItem` and `person_id`, `quote`, `promised_date`, `completed_date`, `paid` on
// `DeckRepairJob` were added on 2026-09-27, and the Jarvis snapshot was taught to read them — but
// nothing WROTE them, so the CRM was a set of columns no user could fill in. This file pins the
// write path that closes that, and the three things that can go wrong in it:
//
//   1. `fee` drifting from the sale price it was agreed on (derived in one place, stored anyway).
//   2. A date-only field written as a raw Date object — every row comes back JSON-serialized, so
//      the renderer's string `.slice(0, 10)` throws and the whole page blanks. That is not
//      hypothetical: it happened on 2026-09-17 to murbah's booking_date.
//   3. A sold item with no recorded price printing a number anyway. "not recorded" and "$0" are
//      different answers, and this line is what Rob quotes back to a consignor (H13).
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const ctx = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
const ui = readFileSync(new URL('../src/pages/CommandDeck/widgets/signal_chain.jsx', import.meta.url), 'utf8');

console.log('\n1. a date-only field is written as an ISO string, never as a Date');
// The renderers do `(value || '').slice(0, 10)`; a Date object has no .slice and blanks the page.
check('there is one shared helper for it', /const toIsoDate = \(dateStr\) => \(dateStr \? new Date\(`\$\{dateStr\}T00:00:00\.000Z`\)\.toISOString\(\) : null\);/.test(ctx), true);
check('the repair promised date goes through it',
  /promised_date: toIsoDate\(rForm\.promised_date\)/.test(ctx)
  && /if \('promised_date' in next\) next\.promised_date = toIsoDate\(next\.promised_date\);/.test(ctx), true);
check('…and murbah\'s booking date still does, through the same helper', /const date = toIsoDate\(dateStr\);/.test(ctx), true);
check('no date field is written as a raw Date object',
  /promised_date: new Date\(/.test(ctx), false);
check('the renderer reads it as a string', /\(r\.promised_date \|\| ''\)\.slice\(0, 10\)/.test(ui), true);

console.log('\n2. the sale price and the commission cannot disagree');
check('the commission is derived from the account\'s own fee tiers, not invented',
  /import \{[\s\S]*commissionFor[\s\S]*\} from '@\/pages\/CommandDeck\/deckConstants';/.test(ctx), true);
check('creating an already-sold item writes price, date, fee and payout together',
  /sold_price: soldPrice,\s*sold_date: soldPrice !== null \? new Date\(\)\.toISOString\(\) : null,\s*fee: soldPrice !== null \? commissionFor\(soldPrice, feeTiers\) : null,\s*paid_out: soldPrice !== null \? !!cForm\.paid_out : false,/.test(ctx), true);
check('editing the price recomputes the fee in the same patch',
  /if \('sold_price' in next\) \{\s*const p = [^\n]*\n\s*next\.sold_price = p;\s*next\.fee = p === null \? null : commissionFor\(p, feeTiers\);/.test(ctx), true);
check('…and there is exactly one such derivation for an edit',
  (ctx.match(/next\.fee = p === null \? null : commissionFor\(p, feeTiers\);/g) || []).length, 1);
check('un-selling clears the payout state rather than leaving a paid-but-unsold row',
  /\{ sold: false, sold_date: null, paid_out: false \}/.test(ctx), true);
check('marking it sold stamps a sale date', /sold: true, sold_date: c\.sold_date \|\| new Date\(\)\.toISOString\(\)/.test(ctx), true);

console.log('\n3. a sold item with no recorded price does not print one');
check('the row says the price is missing', /'sold — no sale price recorded'/.test(ui), true);
check('…and says so separately when the fee is missing', /commission not recorded/.test(ui), true);
check('the stored fee is what is shown, not a recomputation',
  /const toConsignor = i\.sold_price - i\.fee;/.test(ui) && /our cut \$\{money\(i\.fee\)\}/.test(ui), true);
check('a repair with no quote says so instead of $0', /'no quote'/.test(ui) && /'no promised date'/.test(ui), true);

console.log('\n4. both records are editable from the tracker, and reachable');
check('the context exports the two update handlers',
  /addConsignment, toggleSold, updateConsignment, removeConsignment,/.test(ctx)
  && /addRepair, updateRepair, cycleRepairStage, removeRepair,/.test(ctx), true);
check('…and both write through the entity layer',
  /const updateConsignment = async \(id, patch\) =>/.test(ctx) && /DeckConsignmentItem\.update\(id, next\)/.test(ctx)
  && /const updateRepair = async \(id, patch\) =>/.test(ctx) && /DeckRepairJob\.update\(id, next\)/.test(ctx), true);
check('the widget passes both into the panels',
  /onUpdate=\{updateConsignment\}/.test(ui) && /onUpdate=\{updateRepair\}/.test(ui), true);
check('each row has an edit affordance', (ui.match(/<Pencil size=\{11\} color=\{C\.brass\} \/>/g) || []).length, 2);
check('the quote and promised date are also enterable at intake',
  /placeholder="Quote \$"/.test(ui) && /value=\{form\.promised_date\}/.test(ui), true);
check('…and so is an already-completed sale',
  /placeholder="Sold price \$"/.test(ui) && /value=\{form\.sold_price\}/.test(ui), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
