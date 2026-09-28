// The published price and the meter must say the same thing.
//
// WHY THIS EXISTS. OPEN-WORK.md recorded, as a requirement, that a user on their own
// AI key (the "Gemini free path") pays nothing per call. Verified against the code on
// 2026-09-28, that is not true: `ai.js` does prefer a per-user key, but the credit
// block reserves against the account for any non-exempt user and is NEVER shown which
// key ran the call, and `billing_exempt` is only ever set by an admin
// (`routes/admin.routes.js`).
//
// DECIDED AND IMPLEMENTED — ROB, 2026-09-28. Charging own-key calls is INTENDED: a complete free
// path cannot be covered at current prices, so costs have to be met. The rate is **1 credit a call**
// (`OWN_KEY_CALL_CREDITS`), FLAT rather than token-priced: measured, serving an own-key call costs
// roughly $0.0002–0.001 (container CPU, ~440KB egress, one database row), so one credit ($0.005)
// covers that 5–25× over and is ~16× cheaper than a platform-key call (~16.3 credits). At production
// volume (4,637 calls/month) it recovers ~$23 against a ~$10/month hosting floor.
//
// The change that made it true: `ai.js` reserves the flat charge for a call on the operator's own key
// and does NOT run the token-based true-up afterwards (there are no tokens for us to price).
// `reality.mjs`'s intent line moved in the same change — "a genuinely free path" became "a genuinely
// cheap path" — which is the whole point of this file: the claim and the meter may not disagree.
//
// It pins BOTH halves as they are today, and fails if either moves alone:
//   * the exemption rule, tested behaviourally through the import-free policy module;
//   * the absence of a free-path promise in anything a customer reads.
//
// Run:  node scripts/verify-ai-cost-claims.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, extname } from 'node:path';
import { shouldReserveCredits, isOwnKeyProvider, OWN_KEY_CALL_CREDITS } from '../server/src/lib/creditPolicy.js';

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


console.log('\n3b. the own-key rate: 1 credit, flat, and the intent says so');
check('the rate is a decision with a number in it', OWN_KEY_CALL_CREDITS, 1);
check('only tier 1 counts as an own key', isOwnKeyProvider('custom'), true);
check('a platform call is not an own-key call',
  ['platform', 'platform-fallback', '', undefined, null].some(isOwnKeyProvider), false);
check('…and the check is not fooled by case or padding',
  [isOwnKeyProvider(' Custom'), isOwnKeyProvider('custom '), isOwnKeyProvider('CUSTOM')].join(','), 'false,false,false');
const aiSrc = read('server/src/ai.js');
check('an own-key call reserves the flat charge',
  /if \(isOwnKeyProvider\(provider\)\)[\s\S]{0,700}reservedCredits = OWN_KEY_CALL_CREDITS;/.test(aiSrc), true);
check('…and is NOT re-priced against token counts afterwards',
  /!isExempt && isOwnKeyProvider\(provider\)[\s\S]{0,500}creditsCharged = reservedCredits \|\| OWN_KEY_CALL_CREDITS;/.test(aiSrc), true);
check('a platform call still estimates and trues up as before',
  /estimatePreCallCredits\(prompt, role, model, maxTokens\)/.test(aiSrc) && /reconcileAgainstActualUsage\(userId, model, reservedCredits/.test(aiSrc), true);
// The product's curated intent is customer-facing: it must not still promise free AI.
const reality = read('scripts/reality.mjs');
check('the intent line no longer promises a free path', /genuinely free/i.test(reality), false);
check('…and says what is actually true instead', /genuinely cheap path/.test(reality), true);
check('…naming the rate', /1 credit a call/.test(reality), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('the price and the meter agree\n');
