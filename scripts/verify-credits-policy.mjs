// Is "a credit is a unit of Morpheus service" true in the code, the copy and the gate?
//
// WHY THIS EXISTS. The credit machinery predates this policy: `User.credit_balance`,
// Stripe purchases in `CreditTransaction`, reserve → reconcile in `lib/billing.js`, and
// the flat-rate rule in `lib/creditPolicy.js`. What was missing was the COMMERCIAL
// rules around it — a cap, an expiry rule, a per-build ceiling — and the promise that
// no customer-facing page still sells a "free path" the meter does not honour.
//
// The failure this guard is written against is not a typo. It is a policy that exists
// in a document and not in the product: an expiry rule that quietly expires the free
// signup grant, a ceiling that is stored but never consulted by the reservation path,
// or a landing page that says "free forever on your own key" while the meter charges
// one credit a call. Each of those passes a syntax check and a build.
//
// IMPORT-FREE ON PURPOSE. This runs in CI's no-install guards job (hazard H4). The
// modules it reaches (`creditPolicy.js`, `creditExpiry.js`, `buildBudget.js`,
// `creditLiability.js`) are pure or use only `node:` builtins; it must never import
// `billing.js`, which reaches Prisma through `db.js`.
//
// Run:  node scripts/verify-credits-policy.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CREDIT_RATE_USD,
  CREDITS_PER_USD,
  CREDIT_BALANCE_CAP_ENV,
  CREDIT_EXPIRY_MONTHS_ENV,
  CREDIT_BUILD_CEILING_ENV,
  creditBalanceCap,
  creditExpiryMonths,
  buildCeilingCredits,
  wouldExceedBalanceCap,
  withinBuildCeiling,
} from '../server/src/lib/creditPolicy.js';
import { addMonths, expiredPurchasedCredits, round4 } from '../server/src/lib/creditExpiry.js';
import {
  buildBudgetKey,
  buildConsentKey,
  buildConsentAmount,
  buildReservationAmount,
  parseBuildSpend,
} from '../server/src/lib/buildBudget.js';
import { deferredRevenueSummary, purchasedOutstanding } from '../server/src/lib/creditLiability.js';
import { MUTATIONS } from './guard-mutations.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const policyDoc = read('docs/CREDITS-POLICY.md');
const billing = read('server/src/lib/billing.js');
const checkout = read('server/src/functions/createTokenCheckout.js');
const webhook = read('server/src/functions/stripeWebhook.js');
const chat = read('server/src/functions/chatWithMorpheus.js');
const autonomous = read('server/src/functions/autonomousBuildStep.js');
const budgetStore = read('server/src/lib/buildBudgetStore.js');
const adminRoutes = read('server/src/routes/admin.routes.js');
const envExample = read('server/.env.example');
// The reservation function's own body, so a check cannot be satisfied by the
// function DEFINITION of a helper it is supposed to call (H19). If the function
// is missing, the slice is empty and every check below fails rather than passing
// on a regex that matched an import or a different caller.
const reservationStart = billing.indexOf('export async function reserveCredits');
const reservationEnd = billing.indexOf('export async function reconcileCredits');
const reservationPath = reservationStart >= 0 && reservationEnd > reservationStart
  ? billing.slice(reservationStart, reservationEnd)
  : '';
// Reconciliation is where the budget is trued up to the ACTUAL charge, so the
// "reservation counted" check below is not enough on its own.
const reconcileStart = billing.indexOf('export async function reconcileCredits');
const reconcileEnd = billing.indexOf('export async function reconcileAgainstActualUsage');
const reconcilePath = reconcileStart >= 0 && reconcileEnd > reconcileStart
  ? billing.slice(reconcileStart, reconcileEnd)
  : '';

// ═══ 1. THE FACE RATE IS ONE NUMBER, AND THE DOC SAYS THE SAME ONE ═══════════
console.log('\n1. the face rate in code and in the policy are the same number');
check('the decided rate is $0.005/credit', CREDIT_RATE_USD, 0.005);
check('…which is $5 per 1,000 credits', round4(CREDIT_RATE_USD * 1000), 5);
check('…and 200 credits per dollar', CREDITS_PER_USD, 200);

const docPerCredit = policyDoc.match(/\$([0-9.]+)\s*per\s*credit/i);
const docPerThousand = policyDoc.match(/\$([0-9.]+)\s*per\s*1,?000\s*credits/i);
check('the policy states a per-credit rate', Boolean(docPerCredit), true);
check('the per-credit rate matches the code', Number(docPerCredit?.[1]), CREDIT_RATE_USD);
check('the policy states the per-1,000 rate', Boolean(docPerThousand), true);
check('…and it matches the code', Number(docPerThousand?.[1]), CREDIT_RATE_USD * 1000);
check('billing.js does not define a second rate', /export\s+const\s+CREDIT_RATE_USD/.test(billing), false);
check('…it re-exports the one home', /export\s*\{\s*CREDIT_RATE_USD\s*\}\s*from\s*'\.\/creditPolicy\.js'/.test(billing), true);
check('the policy says repricing is only face rate or markup',
  /face rate/i.test(policyDoc) && /markup/i.test(policyDoc), true);
check('…and never retroactive', /no\s+repricing\s+is\s+ever\s+applied\s+retroactively/i.test(policyDoc), true);

// ═══ 2. THE THREE CONFIGURATION KNOBS EXIST, AND OFF MEANS OFF ══════════════
console.log('\n2. cap, expiry and ceiling are config-driven, and unset means off');
// Declared before their first use: a `const` read above its declaration is a
// temporal-dead-zone ReferenceError, and it would abort the guard rather than
// report a check (H18). Section 3 reuses the same fixed dates.
const jan = new Date(Date.UTC(2026, 0, 1));
const feb = new Date(Date.UTC(2026, 1, 1));
const jul = new Date(Date.UTC(2026, 6, 1));
const sep = new Date(Date.UTC(2026, 8, 1));
check('cap env name', CREDIT_BALANCE_CAP_ENV, 'CREDITS_BALANCE_CAP');
check('expiry env name', CREDIT_EXPIRY_MONTHS_ENV, 'CREDITS_EXPIRY_MONTHS');
check('ceiling env name', CREDIT_BUILD_CEILING_ENV, 'CREDITS_BUILD_CEILING');
for (const key of [CREDIT_BALANCE_CAP_ENV, CREDIT_EXPIRY_MONTHS_ENV, CREDIT_BUILD_CEILING_ENV]) {
  check(`.env.example documents ${key}`, envExample.includes(key), true);
  check(`the policy documents ${key}`, policyDoc.includes(key), true);
}
check('cap: a positive value is used', creditBalanceCap({ CREDITS_BALANCE_CAP: '1000' }), 1000);
check('cap: blank is off', creditBalanceCap({ CREDITS_BALANCE_CAP: '  ' }), null);
check('cap: zero is off, not a zero-credit account', creditBalanceCap({ CREDITS_BALANCE_CAP: '0' }), null);
check('cap: negative is off', creditBalanceCap({ CREDITS_BALANCE_CAP: '-1' }), null);
check('cap: garbage is off', creditBalanceCap({ CREDITS_BALANCE_CAP: 'lots' }), null);
check('cap: absent is off', creditBalanceCap({}), null);
check('expiry: a positive window is used', creditExpiryMonths({ CREDITS_EXPIRY_MONTHS: '12' }), 12);
check('expiry: zero is off', creditExpiryMonths({ CREDITS_EXPIRY_MONTHS: '0' }), null);
check('expiry: negative is off', creditExpiryMonths({ CREDITS_EXPIRY_MONTHS: '-6' }), null);
check('expiry: a fraction is not an instant window, it is off',
  creditExpiryMonths({ CREDITS_EXPIRY_MONTHS: '0.5' }), null);
check('…and the arithmetic refuses a sub-month window even when called directly',
  expiredPurchasedCredits({ purchases: [{ credits: 100, created_date: jan }], signupCredits: 200, months: 0.5, now: jan }).credits, 0);
check('ceiling: a positive N is used', buildCeilingCredits({ CREDITS_BUILD_CEILING: '250' }), 250);
check('ceiling: zero is off', buildCeilingCredits({ CREDITS_BUILD_CEILING: '0' }), null);

check('a purchase below the cap is allowed', wouldExceedBalanceCap(700, 200, 1000), false);
check('…a purchase that lands exactly on the cap is allowed', wouldExceedBalanceCap(800, 200, 1000), false);
check('…a purchase over the cap is refused', wouldExceedBalanceCap(900, 200, 1000), true);
check('…and no cap never refuses', wouldExceedBalanceCap(1_000_000, 1, null), false);
check('…an unreadable balance fails closed when a cap is set',
  wouldExceedBalanceCap(Number.NaN, 200, 1000), true);
check('…as does an unreadable cap', wouldExceedBalanceCap(900, 200, Number.NaN), true);

// The placeholders are Rob's decision, and the document has to say so rather
// than shipping a number somebody invented in a pull request.
check('every commercial placeholder is explicit and left to Rob',
  (policyDoc.match(/\*\*Placeholder value:\*\*\s*not set\. Rob decides\./g) || []).length, 3);
check('the policy has a decisions table', /Decisions Rob must make/i.test(policyDoc), true);

// ═══ 3. EXPIRY: PURCHASED CREDITS ONLY, SIGNUP GRANT EXEMPT ═════════════════
console.log('\n3. only purchased credits expire; the signup grant is exempt');

check('no configured window means no expiry',
  expiredPurchasedCredits({ purchases: [{ credits: 100, created_date: jan }], signupCredits: 200, months: null, now: sep }).credits, 0);
check('a signup grant with no purchase never expires',
  expiredPurchasedCredits({ purchases: [], signupCredits: 200, months: 1, now: sep }).credits, 0);
check('an unused purchased lot expires at its window',
  expiredPurchasedCredits({ purchases: [{ credits: 100, created_date: jan }], signupCredits: 200, months: 6, now: jul }).credits, 100);
check('…and the signup grant is still protected',
  expiredPurchasedCredits({ purchases: [{ credits: 100, created_date: jan }], signupCredits: 200, months: 6, now: jul }).remainingSignup, 200);
check('consumption is allocated to purchases first',
  expiredPurchasedCredits({
    purchases: [{ credits: 100, created_date: jan }, { credits: 100, created_date: feb }],
    signupCredits: 200,
    consumedCredits: 150,
    months: 6,
    now: sep,
  }).credits, 50);
check('…so the signup half is not consumed by the expiry',
  expiredPurchasedCredits({
    purchases: [{ credits: 100, created_date: jan }, { credits: 100, created_date: feb }],
    signupCredits: 200,
    consumedCredits: 150,
    months: 6,
    now: sep,
  }).remainingSignup, 200);
const firstExpiry = expiredPurchasedCredits({ purchases: [{ credits: 100, created_date: jan }], signupCredits: 200, months: 6, now: jul });
check('applying the same expiry twice does nothing',
  expiredPurchasedCredits({ purchases: [{ credits: 100, created_date: jan }], signupCredits: 200, expiredCredits: firstExpiry.credits, months: 6, now: jul }).credits, 0);
check('a month-end purchase clamps instead of jumping forward',
  addMonths(new Date(Date.UTC(2026, 0, 31)), 1).toISOString(), '2026-02-28T00:00:00.000Z');
check('…including a leap February',
  addMonths(new Date(Date.UTC(2024, 0, 31)), 1).toISOString(), '2024-02-29T00:00:00.000Z');
check('expiry writes a NEGATIVE ledger row with status "expired"',
  /status:\s*'expired'/.test(billing) && /credits:\s*-take/.test(billing), true);
check('…and decrements the balance in the same transaction',
  /credit_balance:\s*\{\s*decrement:\s*take\s*\}/.test(billing), true);
check('the reservation path applies expiry',
  /await\s+applyExpiredPurchasedCredits\(userId\);/.test(reservationPath), true);
check('the purchase-session path applies expiry before the cap',
  checkout.indexOf('applyExpiredPurchasedCredits(user.id)') >= 0
    && checkout.indexOf('applyExpiredPurchasedCredits(user.id)') < checkout.indexOf('const cap = creditBalanceCap()'), true);
check('the webhook applies expiry before granting',
  webhook.indexOf('applyExpiredPurchasedCredits(userId)') >= 0, true);
check('no schema column is required for expiry', /created_date/.test(billing), true);

// ═══ 4. THE CAP IS WIRED INTO THE PURCHASE PATH ═════════════════════════════
console.log('\n4. the balance cap is enforced when a purchase session is created');
check('createTokenCheckout reads the cap',
  /creditBalanceCap\(\)/.test(checkout), true);
check('…and refuses a purchase that would exceed it',
  /wouldExceedBalanceCap\(balance, block\.credits, cap\)/.test(checkout), true);
check('…with a stable machine-readable code',
  /CREDIT_BALANCE_CAP/.test(checkout), true);
check('…before the Stripe session is created',
  checkout.indexOf('wouldExceedBalanceCap') < checkout.indexOf("stripeFetch('/checkout/sessions'"), true);
check('the refusal is a 4xx, not a silent clamp',
  /status:\s*409/.test(checkout), true);

// ═══ 5. THE PER-BUILD CEILING IS KEYED BY PROJECT AND WIRED ═════════════════
console.log('\n5. the per-build ceiling is keyed by project and reached from the reservation path');
check('the budget key is project-scoped', buildBudgetKey('project-1'), 'build_budget_project-1');
check('consent is project-scoped too', buildConsentKey('project-1'), 'build_ceiling_consent_project-1');
check('a reservation below the ceiling is allowed', withinBuildCeiling(80, 10, 100), true);
check('…one that lands exactly on it is allowed', withinBuildCeiling(90, 10, 100), true);
check('…one that crosses it is refused', withinBuildCeiling(95, 10, 100), false);
check('…explicit consent raises the allowance', withinBuildCeiling(100, 10, 100, 10), true);
check('…no ceiling never refuses', withinBuildCeiling(1_000_000, 1, null), true);
check('…an unreadable number refuses rather than passing', withinBuildCeiling(Number.NaN, 1, 100), false);
check('an unreadable reservation is null, not zero', buildReservationAmount(Number.NaN), null);
check('…a negative reservation is null too', buildReservationAmount(-1), null);
check('…a real reservation is kept', buildReservationAmount('12.5'), 12.5);
check('a corrupt stored budget is null, not a fresh zero', parseBuildSpend('lots'), null);
check('…an empty stored budget is null, not a fresh zero', parseBuildSpend(''), null);
check('…a real stored budget is kept', parseBuildSpend('12.5'), 12.5);
check('the store fails closed on an unreadable reservation',
  /buildReservationAmount\(requestedCredits\)/.test(budgetStore) && /if \(requested == null\)/.test(budgetStore), true);
check('…and on an unreadable stored budget',
  /parseSpent\(row\.value\)/.test(budgetStore) && /if \(spent == null\)/.test(budgetStore), true);
check('reserveCredits reads the build from async context',
  /projectId\s*=\s*currentBuildProjectId\(\)/.test(reservationPath), true);
check('…counts the reservation in the ceiling',
  /reserveBuildCredits\(projectId,\s*estimatedCredits\)/.test(reservationPath), true);
check('…and releases it if the balance cannot cover the call',
  /releaseBuildCredits\(projectId,\s*estimatedCredits\)/.test(reservationPath), true);
check('reconciliation moves the budget to the ACTUAL charge, not the estimate',
  /const buildProjectId = currentBuildProjectId\(\)/.test(reconcilePath)
    && /adjustBuildCredits\(buildProjectId,\s*-diff\)/.test(reconcilePath), true);
check('…including the absorbed-overshoot path',
  /await settleBuild\(\);[\s\S]{0,200}return \{ refunded: 0, absorbed: absorb \}/.test(reconcilePath), true);
check('the store applies the shared ceiling rule', /if \(!buildCeilingAllows\(/.test(budgetStore), true);
check('the store locks the budget row before judging it', /FOR UPDATE/.test(budgetStore), true);
check('a chat build opens a fresh budget',
  /enterBuild\(projectId\)/.test(chat) && /beginBuild\(projectId\)/.test(chat), true);
check('…and clears it when the turn ends',
  /finishBuild\(projectId\)/.test(chat) && /exitBuild\(\)/.test(chat), true);
check('an autonomous step continues the project budget',
  /enterBuild\(projectId\)/.test(autonomous) && /continueBuild\(projectId\)/.test(autonomous), true);
check('…and clears it only when the build reports complete',
  /if \(finalComplete\) await finishBuild\(projectId\)/.test(autonomous), true);
check('the policy says the ceiling is keyed by project id',
  /keyed by \*\*project id\*\*|keyed by project id/i.test(policyDoc), true);
check('…and consent is an explicit per-project setting',
  /build_ceiling_consent_/i.test(policyDoc), true);
check('consent: a positive amount is accepted', buildConsentAmount('25'), 25);
check('…zero is a real revocation, not unreadable', buildConsentAmount(0), 0);
check('…a negative, blank or garbage amount is refused',
  [buildConsentAmount(-1), buildConsentAmount(''), buildConsentAmount('lots')], [null, null, null]);
check('an admin can grant explicit per-project consent',
  /router\.post\('\/build-ceiling-consent'/.test(adminRoutes)
    && /buildConsentKey\(project\.id\)/.test(adminRoutes)
    && /setPlatformSetting\(key, String\(amount\)/.test(adminRoutes), true);
check('…the consent write is audited', /action:\s*'build_ceiling_consent'/.test(adminRoutes), true);
check('…and sits under the admin gate', /router\.use\(requireAuth,\s*blockWidget,\s*requireAdmin\)/.test(adminRoutes), true);

// ═══ 6. NO CUSTOMER-FACING COPY PROMISES A FREE PATH OR NO EXPIRY ═══════════
console.log('\n6. nothing a customer reads promises a free path or "no expiry"');
const COPY_FILES = [];
const walk = (dir) => {
  for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel);
    else if (['.js', '.jsx', '.json'].includes(extname(entry.name))) COPY_FILES.push(rel);
  }
};
walk('src');
// The static assets are customer-facing too. `public/` is what actually ships to
// Netlify, and `index.html` is the shell every route starts from.
walk('public');
COPY_FILES.push('index.html');
// And the generator that writes the page's title, JSON-LD and llms.txt. Scanning only
// the files it outputs would miss the line a search engine or AI tool actually quotes:
// seo-static.mjs carried "free forever on your own AI provider key" while every src/
// file had already been corrected.
COPY_FILES.push('scripts/seo-static.mjs');
check('the copy scan found files to judge (parser sanity)', COPY_FILES.length > 50, true);

const FREE_PATH_CLAIMS = [
  /\bfree\s+(?:forever|for\s+life|unlimited|unmetered)\b/i,
  /\bfree\s+(?:ai\s+)?path\b/i,
  /\bfree\s+(?:[a-z-]+\s+){0,3}(?:on|with)\s+(?:your|an?)\s+(?:own\s+)?(?:ai\s+)?(?:provider\s+)?key\b/i,
  /\b(?:your|an?|own)\s+(?:own\s+)?(?:ai\s+)?(?:provider\s+)?key\b[^.\n]{0,40}(?<!not\s)(?<!never\s)\bfree\b/i,
  /\bno\s+(?:cost|charge|fee)\b[^.\n]{0,30}\b(?:per\s+call|ai\s+call|for\s+ai|on\s+your\s+key)\b/i,
  /\bno\s+expir(?:y|e|es|ation)\b/i,
  /\bcredits?\s+(?:never|do\s+not|don'?t|will\s+not|won'?t)\s+expire\b/i,
];
const copyHits = [];
for (const file of COPY_FILES) {
  const source = read(file);
  for (const pattern of FREE_PATH_CLAIMS) {
    const match = source.match(pattern);
    if (match) copyHits.push(`${file}: ${match[0]}`);
  }
}
check('no user-facing file promises a free AI path or no expiry', copyHits, []);
// The generated metadata is the copy search engines and AI tools quote. It must state
// the closed own-key path in the same words the meter implements, not merely avoid the
// banned phrase — a file can stop saying "free forever" and still say nothing useful.
check('the generated SEO pricing line says an own-key call costs a credit',
  /own AI provider key, a call costs 1 credit/i.test(read('scripts/seo-static.mjs')), true);

// ═══ 7. TERMS: CREDIT = SERVICE; OWNERSHIP = OUTPUT ONLY ════════════════════
console.log('\n7. terms say a credit is a service unit and ownership is the output');
const terms = read('src/pages/Terms.jsx');
for (const [label, source] of [['Terms page', terms], ['credits policy', policyDoc]]) {
  check(`${label}: a credit is a unit of Morpheus service`, /credit is a unit of Morpheus service/i.test(source), true);
  check(`${label}: …not a quantity of tokens`, /not a quantity of (?:provider )?tokens/i.test(source), true);
  check(`${label}: ownership is scoped to the software produced`, /software Morpheus produces/i.test(source), true);
  check(`${label}: …and explicitly not credits`, /does\s+not\s+(?:\*\*)?(?:refer to|describe)(?:\*\*)?\s+credits/i.test(source), true);
}
check('the policy marks the wording as a draft', /draft terms wording/i.test(policyDoc), true);

// ═══ 8. THE DEFERRED-REVENUE REPORT STILL REPORTS THE RIGHT THINGS ══════════
console.log('\n8. the deferred-revenue report separates sold, consumed, liability and provider bill');
check('purchased outstanding is capped by the account balance',
  purchasedOutstanding({ balance: 500, purchased: 400, expired: 0, charged: 100 }), 300);
check('…and cannot exceed the balance',
  purchasedOutstanding({ balance: 200, purchased: 400, expired: 0, charged: 100 }), 200);
check('…and a spent account owes nothing',
  purchasedOutstanding({ balance: 0, purchased: 400, expired: 0, charged: 100 }), 0);
const summary = deferredRevenueSummary({
  soldCredits: 1000,
  soldUsd: 5,
  consumedCredits: 200,
  expiredCredits: 50,
  outstandingPurchasedCredits: 300,
  totalBalanceCredits: 500,
  providerCostUsd: 100,
  creditRateUsd: 0.005,
});
check('liability is unused purchased credits at the face rate', summary.outstandingLiabilityUsd, 1.5);
check('float is liability as a share of the provider bill', summary.floatShare, 0.015);
check('a zero provider bill has no float share, not Infinity',
  deferredRevenueSummary({ outstandingPurchasedCredits: 300, providerCostUsd: 0, creditRateUsd: 0.005 }).floatShare, null);
let refusedBadRate = false;
try {
  deferredRevenueSummary({ outstandingPurchasedCredits: 1, creditRateUsd: 0 });
} catch {
  refusedBadRate = true;
}
check('a missing face rate refuses to value a liability', refusedBadRate, true);

const report = read('scripts/credits-report.mjs');
check('the report reads paid sales', /status\s*=\s*'paid'/.test(report), true);
check('…consumed usage', /credits_charged/.test(report), true);
check('…account balances', /credit_balance/.test(report), true);
check('…provider cost', /cost_usd/.test(report), true);
check('…through the tested arithmetic', /deferredRevenueSummary/.test(report) && /purchasedOutstanding/.test(report), true);
check('…for a monthly window', /WINDOW_DAYS\s*=\s*30/.test(report), true);
check('…from production, never a local DATABASE_URL',
  /process\.env\.PROD_DATABASE_URL/.test(report) && !/process\.env\.DATABASE_URL/.test(report), true);
check('…and says "not verified" rather than passing without a credential',
  /process\.exit\(2\)/.test(report) && /NOT VERIFIED/.test(report), true);
check('…and redacts a connection string rather than printing it',
  /redacted/.test(report) && /postgres\(\?:ql\)\?/.test(report), true);

// ═══ 9. THE GATE ACTUALLY RUNS THIS GUARD ═══════════════════════════════════
console.log('\n9. this guard is registered where the gate and CI will run it');
const verifySrc = read('scripts/verify.mjs');
const hard = (verifySrc.match(/const HARD = \[([\s\S]*?)\]/) || [, ''])[1];
check('verify.mjs lists this guard', /'verify-credits-policy\.mjs'/.test(hard), true);
const manifest = JSON.parse(read('scripts/guards-list.json'));
check('the CI guards manifest lists this guard', manifest.guards.includes('verify-credits-policy.mjs'), true);
check('the manifest count matches its list', manifest.count, manifest.guards.length);
check('guard-mutations has a sabotage for this guard',
  MUTATIONS.some((m) => m.guard === 'verify-credits-policy.mjs'), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the credits policy is not true in the code, the copy and the gate together.\n');
  process.exit(1);
}
console.log('the credit is a service unit, the placeholders are explicit, and the gate runs the check\n');
