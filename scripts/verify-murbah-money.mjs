// Runtime verification for the Murbah ledger — the money field and the Calendar range arithmetic.
//
// Dependency-free, so it runs in CI's no-install guards job. Run:
//   node scripts/verify-murbah-money.mjs
//
// Two claims, both of which fail silently in the place Rob actually reads:
//   - a half-typed price must not become NaN, or a coerced 0 he never typed;
//   - an all-day Calendar event ends EXCLUSIVELY while a booking range is inclusive, so an off-by-one
//     shifts every booking by a day with nothing to show for it.
import { readFileSync } from 'node:fs';
import { normalizePrice } from '../src/pages/CommandDeck/murbahMoney.js';
import { exclusiveEndDate, bookingDescription } from '../server/src/lib/murbahBooking.js';

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

console.log('\n1. a price is a number, or nothing — never a coerced zero');
check('an empty box is NO price', normalizePrice(''), { ok: true, value: null });
check('…and so is whitespace', normalizePrice('   '), { ok: true, value: null });
check('…and so is null/undefined', [normalizePrice(null), normalizePrice(undefined)], [{ ok: true, value: null }, { ok: true, value: null }]);
check('a whole number', normalizePrice('450'), { ok: true, value: 450 });
check('a decimal', normalizePrice('1250.50'), { ok: true, value: 1250.5 });
check('zero is a price, and is not the same as none', normalizePrice('0'), { ok: true, value: 0 });
// The three that make this function exist: mid-keystroke input must be REFUSED, not stored.
check('"1e" mid-typing is refused, not stored as NaN', normalizePrice('1e').ok, false);
check('"-" mid-typing is refused', normalizePrice('-').ok, false);
check('"abc" is refused', normalizePrice('abc').ok, false);
check('a negative price is refused, like the input\'s own min', normalizePrice('-5').ok, false);
check('Infinity is refused', normalizePrice('Infinity').ok, false);

console.log('\n2. an all-day event ends the day AFTER the last day of the range');
check('a single-day booking still ends the next day', exclusiveEndDate('2026-10-05T00:00:00.000Z', null), '2026-10-06');
check('…which is what it did before the range existed', exclusiveEndDate('2026-10-05T00:00:00.000Z', undefined), '2026-10-06');
check('a range ending on the 7th ends on the 8th', exclusiveEndDate('2026-10-05T00:00:00.000Z', '2026-10-07T00:00:00.000Z'), '2026-10-08');
// The edge that a naive +86400000 gets wrong, and the reason this uses setUTCDate.
check('a month boundary rolls over', exclusiveEndDate('2026-10-31T00:00:00.000Z', null), '2026-11-01');
check('…including a year boundary', exclusiveEndDate('2026-12-31T00:00:00.000Z', null), '2027-01-01');
check('…and a leap day', exclusiveEndDate('2028-02-28T00:00:00.000Z', null), '2028-02-29');
check('no date at all is null, not an Invalid Date', exclusiveEndDate(null, null), null);

console.log('\n3. the money is always stated, so silence is never read as unpaid');
const d = bookingDescription({ price: 450, deposit_paid: true, paid: false, note: 'picking up the amp' });
check('the price is named', /Price: 450/.test(d), true);
check('the deposit is stated either way', /Deposit paid: yes/.test(d), true);
check('the balance is stated either way', /Paid in full: no/.test(d), true);
check('the note survives, after the money', d.endsWith('picking up the amp'), true);
check('with no price agreed, the line is simply absent', /Price:/.test(bookingDescription({ deposit_paid: false, paid: false })), false);
// The claim: an unanswered flag must never be ambiguous.
check('no flags given still states both as no', bookingDescription({}).includes('Deposit paid: no') && bookingDescription({}).includes('Paid in full: no'), true);
check('a note alone is kept', bookingDescription({ note: 'just a note' }), 'Deposit paid: no\nPaid in full: no\n\njust a note');

console.log('\n4. the wiring that makes the above real is present');
const ctx = readFileSync(new URL('../src/contexts/CommandDeckContext.jsx', import.meta.url), 'utf8');
const sync = readFileSync(new URL('../server/src/functions/syncMurbahBooking.js', import.meta.url), 'utf8');
check('the ledger uses the guarded normaliser', /normalizePrice\(clean\.price\)/.test(ctx), true);
check('…and refuses rather than storing a bad keystroke', /if \(!ok\) return;/.test(ctx), true);
check('the sync uses the guarded range arithmetic', /exclusiveEndDate\(startDate, opp\.end_date\)/.test(sync), true);
check('…and the guarded description', /description: bookingDescription\(opp\)/.test(sync), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
