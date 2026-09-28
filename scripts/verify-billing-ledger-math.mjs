// The billing ledger's arithmetic, tested without a database.
//
// WHY THIS IS SEPARATE FROM THE CHECKER. `scripts/verify-billing-ledger.mjs` needs production
// credentials, so CI cannot run it, and a check CI cannot run is a check that only ever happens when
// someone remembers. The MATHS is where a reconciliation check goes wrong (a precision rule, an
// absorption case mistaken for drift), so the maths lives in an import-free module and is asserted
// here, in the guards job, on every pull request.
//
// The fixtures are REAL numbers measured from production on 2026-09-28, not invented ones — a
// synthetic fixture proves the formula agrees with itself; a measured one proves it agrees with the
// meter that actually ran.
//
// Run:  node scripts/verify-billing-ledger-math.mjs
import { checkChargeRow, classifyBalance, expectedCharge, impliedBalance, round4, SIGNUP_CREDITS } from '../server/src/lib/billingLedger.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the retail formula is the one production actually charged');
// The sampled production row: gemini-3.5-flash-lite, 814 in / 7288 out, billed at the fallback rate
// ($1.00/$5.00 per M) with the 2x markup. The ledger says 14.9016 credits; this must say the same.
const sampled = { inputTokens: 814, outputTokens: 7288, inputPerM: 1, outputPerM: 5, markup: 2, ownKey: false };
check('a measured production row reproduces to 4 decimals', expectedCharge(sampled), 14.9016);
check('…and is judged to match', checkChargeRow({ creditsCharged: 14.9016, ...sampled }).ok, true);
// The other measured row: 12637 in / 40 out → 5.1348, the admin charge of 2026-09-01.
check('the second measured row reproduces too',
  expectedCharge({ inputTokens: 12637, outputTokens: 40, inputPerM: 1, outputPerM: 5, markup: 2 }), 5.1348);
// A deepseek row at the pinned peak rate (what most production traffic is).
check('a deepseek-pro row prices at the pinned peak rate',
  expectedCharge({ inputTokens: 1000000, outputTokens: 1000000, inputPerM: 1.32, outputPerM: 3.96, markup: 2 }), 2112);

console.log('\n2. the own-key rule is flat, and is not priced by tokens');
check('an own-key call is exactly 1 credit, whatever the tokens',
  [expectedCharge({ ...sampled, ownKey: true }), expectedCharge({ inputTokens: 500000, outputTokens: 500000, ownKey: true })].join(','), '1,1');

console.log('\n3. a discrepancy has to be real to be reported');
check('half a hundredth of a credit is float noise, not a discrepancy',
  checkChargeRow({ creditsCharged: 14.903, ...sampled }).ok, true);
check('a whole credit is a discrepancy', checkChargeRow({ creditsCharged: 15.9, ...sampled }).ok, false);
check('…and it reports the gap', checkChargeRow({ creditsCharged: 15.9, ...sampled }).gap, 0.9984);

console.log('\n4. balances: equal, absorbed, or drift — and the three are not the same');
check('the signup grant is 200, as the column default says', SIGNUP_CREDITS, 200);
// Measured: Rob's balance is 194.8652 with no purchases and 5.1348 charged.
check('a measured production balance is implied exactly', impliedBalance({ purchased: 0, charged: 5.1348 }), 194.8652);
check('…and classifies as balanced', classifyBalance({ balance: 194.8652, implied: 194.8652 }).state, 'balanced');
// Measured: the account that exhausted holds 0 against an implied −3.7712.
check('a floor-at-zero account is ABSORBED, not drift',
  classifyBalance({ balance: 0, implied: -3.7712 }).state, 'absorbed');
check('…and reports what the platform absorbed',
  classifyBalance({ balance: 0, implied: -3.7712 }).absorbed, 3.7712);
check('an unexplained gap IS drift', classifyBalance({ balance: 50, implied: 45 }).state, 'drift');
check('…and names the delta, signed', classifyBalance({ balance: 50, implied: 45 }).delta, -5);
check('a zero balance with an implied zero is balanced, not absorbed',
  classifyBalance({ balance: 0, implied: 0 }).state, 'balanced');

console.log('\n5. precision: credits are Decimal(14,4) and comparisons use that');
check('round4 trims float noise', round4(14.901600000001), 14.9016);
check('round4 handles negatives', round4(-3.77124999), -3.7712);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('the ledger arithmetic holds\n');
