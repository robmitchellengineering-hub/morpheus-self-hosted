// The published price and the meter must say the same thing.
//
// WHY THIS EXISTS. OPEN-WORK.md recorded, as a requirement, that a user on their own
// AI key (the "Gemini free path") pays nothing per call. Verified against the code on
// 2026-09-28, that is not true: `ai.js` does prefer a per-user key, but the credit
// block reserves against the account for any non-exempt user and is NEVER shown which
// key ran the call, and `billing_exempt` is only ever set by an admin
// (`routes/admin.routes.js`). A claim and a behaviour that disagree is a failure this
// repo has already shipped twice — "no free tier" was false, and "your data is not
// stored on Morpheus's servers" was false — so it is guarded rather than commented.
//
// It pins BOTH halves as they are today, and fails if either moves alone:
//   * the exemption rule, tested behaviourally through the import-free policy module;
//   * the absence of a free-path promise in anything a customer reads.
//
// WHEN THE RULE CHANGES — and `server/src/lib/creditPolicy.js` names the two options —
// update this file in the same commit, the way `expected-settings.json` must move with
// a settings change. A guard that has to be remembered is the hole it was built for.
//
// Run:  node scripts/verify-ai-cost-claims.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { shouldReserveCredits } from '../server/src/lib/creditPolicy.js';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const root = new URL('..', import.meta.url).pathname;
const read = (p) => readFileSync(join(root, p), 'utf8');

console.log('\n1. the exemption rule is about the ACCOUNT, and nothing else');
check('no user row → nothing to bill', shouldReserveCredits(null), false);
check('an admin is exempt', shouldReserveCredits({ role: 'admin' }), false);
check('…however the role was typed into the database', shouldReserveCredits({ role: '  Admin ' }), false);
check('an explicit free-usage grant is exempt', shouldReserveCredits({ billing_exempt: true }), false);
check('an ordinary user pays', shouldReserveCredits({ role: 'user' }), true);
check('a user row with no role pays', shouldReserveCredits({}), true);
check('billing_exempt: false is not exempt', shouldReserveCredits({ billing_exempt: false }), true);
// The rule is deliberately blind to the key the call will use — that is the open
// question in creditPolicy.js, and this asserts the blindness rather than a policy
// nobody has chosen yet.
check('the rule is not shown the AI key at all', shouldReserveCredits.length, 1);

console.log('\n2. that rule is the one the call actually uses');
const ai = read('server/src/ai.js');
check('ai.js reserves through the shared rule', ai.includes('shouldReserveCredits('), true);
check('…and no longer spells the rule out inline', !/billing_exempt === true;/.test(ai), true);

console.log('\n3. nothing a customer reads promises a free path the meter does not honour');
const FREE_CLAIM = /costs nothing per call|free path|your own (ai )?key[^.\n]{0,30}(is )?free|no cost per call/i;
const files = [];
const walk = (dir) => {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(p);
    else if (['.jsx', '.js', '.json', '.md'].includes(extname(e.name))) files.push(p);
  }
};
walk('src');
check('the scan found files to judge (parser sanity)', files.length > 50, true);
check('no user-facing file promises a free own-key path',
  files.filter((f) => FREE_CLAIM.test(read(f))).join(','), '');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('the price and the meter agree\n');
