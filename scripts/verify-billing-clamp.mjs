// Runtime verification for the billing clamp.
//
// Dependency-free, so it runs in CI's no-install guards job alongside
// verify-drift.mjs. Run:  node scripts/verify-billing-clamp.mjs
//
// WHY THIS EXISTS
//
// The product claims a "hard stop before overspend". Pre-call reservation is
// that stop, but the post-call true-up incremented the balance by a negative
// difference unconditionally — so a call whose actual cost exceeded its
// reservation could push an account below zero. Production had a real account
// sitting at -3.7712 credits, which makes the claim false and is confusing to
// the user. The invariant asserted here is the one that claim depends on:
// a true-up may only take what the account actually holds.
import { splitOvershoot } from '../server/src/lib/billingClamp.js';

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

console.log('\nBilling clamp — runtime verification\n');

console.log('1. the named cases');
check('owed 5, holds 10 -> take 5, absorb nothing', splitOvershoot(5, 10), { take: 5, absorb: 0 });
check('owed 5, holds exactly 5 -> take 5, absorb nothing', splitOvershoot(5, 5), { take: 5, absorb: 0 });
check('owed 5, holds 3 -> take 3, absorb 2', splitOvershoot(5, 3), { take: 3, absorb: 2 });
check('owed 5, holds 0 -> take nothing, absorb all 5', splitOvershoot(5, 0), { take: 0, absorb: 5 });
check('owed 5, already negative (-3.77) -> absorb all 5', splitOvershoot(5, -3.7712), { take: 0, absorb: 5 });

console.log('\n2. degenerate input cannot produce a bad take');
check('owed 0', splitOvershoot(0, 10), { take: 0, absorb: 0 });
check('negative owed (a refund, not an overshoot)', splitOvershoot(-5, 10), { take: 0, absorb: 0 });
check('both zero', splitOvershoot(0, 0), { take: 0, absorb: 0 });

// The invariant itself, exhaustively — this is stronger than any list of cases,
// and it is the property the customer-facing claim depends on.
console.log('\n3. the invariant, swept over a grid');
let swept = 0;
let brokeNever = true;
let conservationBreaks = 0;
let overdraws = 0;
for (let owed = 0; owed <= 5000; owed += 25) {
  for (let available = -100; available <= 5000; available += 25) {
    const { take, absorb } = splitOvershoot(owed, available);
    swept++;
    // a) never takes more than the account holds, so the balance cannot go below zero
    if (take > Math.max(0, available)) overdraws++;
    // b) take + absorb accounts for the whole debt — nothing is created or lost
    if (Math.abs(take + absorb - owed) > 1e-9) conservationBreaks++;
  }
}
check(`swept ${swept} combinations without ever overdrawing the balance`, overdraws, 0);
check('and never created or lost credits (take + absorb === owed)', conservationBreaks, 0);
check('the sweep actually ran', swept > 10000, true);

console.log('\n4. the reconcile path uses it rather than incrementing blind');
const { readFileSync } = await import('node:fs');
const src = readFileSync(new URL('../server/src/lib/billing.js', import.meta.url), 'utf8');
const reconcile = src.slice(src.indexOf('export async function reconcileCredits'));
check('the overshoot branch consults splitOvershoot', /splitOvershoot\(owed, before\)/.test(reconcile), true);
check('the clamp is guarded so a concurrent top-up is not wiped',
  /credit_balance < \$2::numeric/.test(reconcile), true);
check('the atomic conditional take is still used for the covered case',
  /credit_balance: \{ gte: owed \}/.test(reconcile), true);
check('absorption is logged, not silently swallowed', /\[billing\] absorbed/.test(reconcile), true);
check('a positive difference still refunds (behaviour unchanged)',
  /credit_balance: \{ increment: diff \}/.test(reconcile), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
