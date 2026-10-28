// Deferred-revenue report — credits sold, consumed, expired and still owed.
//
// WHAT THIS ANSWERS, and why it is not the same as "revenue". A prepaid credit
// balance is a stored-value liability, not income: the money is collected, but
// the service has not been delivered yet. This report separates the two:
//
//   sold       paid CreditTransaction rows (cash collected, credits issued)
//   consumed   UsageEvent.credits_charged (service delivered)
//   expired    status='expired' rows (purchased credits the policy retired)
//   liability  unused PURCHASED credits, valued at the published face rate
//   float      that liability as a share of the provider bill for the window
//
// The 200-credit signup grant is deliberately NOT liability: nobody paid for it.
// `server/src/lib/creditLiability.js` holds the arithmetic and is import-free so
// `scripts/verify-credits-policy.mjs` can test it without a database or install.
//
// READ-ONLY. Exit 0 = report produced; exit 2 = cannot read production (missing
// credential or query failure) — never a pass, the same contract as
// verify-schema-prod.mjs and verify-billing-ledger.mjs.
//
// Run:  node scripts/credits-report.mjs
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CREDIT_RATE_USD } from '../server/src/lib/creditPolicy.js';
import { deferredRevenueSummary, purchasedOutstanding } from '../server/src/lib/creditLiability.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(REPO, 'server', '.env.prodsql');
const WINDOW_DAYS = 30;

// A driver error can quote the connection string. Never print a credential.
const redact = (value) => String(value ?? '').replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://[redacted]');

function notVerified(message) {
  console.log(`\n  NOT VERIFIED — ${redact(message)}`);
  console.log('  This is never a pass: the deferred-revenue report was not produced.\n');
  process.exit(2);
}

// Production only. Falling back to DATABASE_URL would let a local dev database
// produce a report that looks like the real liability, which is worse than no
// report; the same contract as verify-billing-ledger.mjs.
let url = process.env.PROD_DATABASE_URL || '';
if (!url && existsSync(ENV_PATH)) {
  const env = readFileSync(ENV_PATH, 'utf8');
  url = (env.match(/PROD_DATABASE_URL\s*=\s*"?([^"\n]+)"?/) || [])[1] || '';
}
if (!url) {
  notVerified('no PROD_DATABASE_URL in server/.env.prodsql or the environment.');
}

let Pool;
try {
  const require = createRequire(join(REPO, 'server', 'package.json'));
  ({ Pool } = require('pg'));
} catch (err) {
  notVerified(`the pg driver is not installed (${String(err?.message || err).split('\n')[0]}).`);
}

const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } });
const money = (n) => `$${Number(n || 0).toFixed(4)}`;
const credits = (n) => Number(n || 0).toFixed(4);

try {
  const sales = (await pool.query(`
    select
      coalesce(sum(case when status = 'paid' then credits else 0 end), 0)::float as sold_credits_all,
      coalesce(sum(case when status = 'paid' then amount_usd else 0 end), 0)::float as sold_usd_all,
      coalesce(sum(case when status = 'paid' and created_date >= now() - interval '${WINDOW_DAYS} days' then credits else 0 end), 0)::float as sold_credits_window,
      coalesce(sum(case when status = 'paid' and created_date >= now() - interval '${WINDOW_DAYS} days' then amount_usd else 0 end), 0)::float as sold_usd_window,
      coalesce(sum(case when status = 'expired' then -credits else 0 end), 0)::float as expired_credits_all,
      coalesce(sum(case when status = 'expired' and created_date >= now() - interval '${WINDOW_DAYS} days' then -credits else 0 end), 0)::float as expired_credits_window
    from credit_transactions
  `)).rows[0];

  // The provider bill is OUR bill. A `provider = 'custom'` call ran on the
  // customer's own key, so its `cost_usd` is what that customer paid their
  // provider — including it here would overstate our monthly bill and understate
  // the float. Consumption still counts every call; only the cost is filtered.
  const usage = (await pool.query(`
    select
      coalesce(sum(credits_charged), 0)::float as consumed_credits_all,
      coalesce(sum(case when created_date >= now() - interval '${WINDOW_DAYS} days' then credits_charged else 0 end), 0)::float as consumed_credits_window,
      coalesce(sum(cost_usd) filter (where provider <> 'custom'), 0)::float as provider_cost_all,
      coalesce(sum(cost_usd) filter (where provider <> 'custom' and created_date >= now() - interval '${WINDOW_DAYS} days'), 0)::float as provider_cost_window
    from usage_events
  `)).rows[0];

  // One row per account, so the liability is computed from the same rule the
  // expiry path uses rather than from a second, subtly different query.
  const accounts = (await pool.query(`
    select u.id,
           greatest(coalesce(u.credit_balance, 0), 0)::float as balance,
           coalesce(p.purchased, 0)::float as purchased,
           coalesce(p.expired, 0)::float as expired,
           coalesce(c.charged, 0)::float as charged
    from users u
    left join (
      select created_by_id,
             sum(case when status = 'paid' then credits else 0 end) as purchased,
             sum(case when status = 'expired' then -credits else 0 end) as expired
      from credit_transactions
      group by created_by_id
    ) p on p.created_by_id = u.id
    left join (
      select created_by_id, sum(credits_charged) as charged
      from usage_events
      group by created_by_id
    ) c on c.created_by_id = u.id
  `)).rows;

  const outstandingPurchasedCredits = accounts.reduce(
    (sum, account) => sum + purchasedOutstanding(account),
    0,
  );
  const totalBalanceCredits = accounts.reduce(
    (sum, account) => sum + Math.max(0, Number(account.balance || 0)),
    0,
  );

  const summary = deferredRevenueSummary({
    soldCredits: sales.sold_credits_window,
    soldUsd: sales.sold_usd_window,
    consumedCredits: usage.consumed_credits_window,
    expiredCredits: sales.expired_credits_window,
    outstandingPurchasedCredits,
    totalBalanceCredits,
    providerCostUsd: usage.provider_cost_window,
    creditRateUsd: CREDIT_RATE_USD,
  });

  const float = summary.floatShare == null
    ? 'n/a (no provider spend in the window)'
    : `${(summary.floatShare * 100).toFixed(2)}% of the ${WINDOW_DAYS}-day provider bill (${summary.floatShare.toFixed(2)}×)`;

  console.log('\nMorpheus credits — deferred revenue\n');
  console.log(`  window: trailing ${WINDOW_DAYS} days · face rate: $${CREDIT_RATE_USD}/credit · accounts: ${accounts.length}`);

  console.log('\n1. sold vs consumed in the window');
  console.log(`   sold       ${credits(summary.soldCredits).padStart(14)} credits   ${money(summary.soldUsd)} collected`);
  console.log(`   consumed   ${credits(summary.consumedCredits).padStart(14)} credits`);
  console.log(`   expired    ${credits(summary.expiredCredits).padStart(14)} credits`);
  console.log('   all time:');
  console.log(`   sold       ${credits(sales.sold_credits_all).padStart(14)} credits   ${money(sales.sold_usd_all)} collected`);
  console.log(`   consumed   ${credits(usage.consumed_credits_all).padStart(14)} credits`);
  console.log(`   expired    ${credits(sales.expired_credits_all).padStart(14)} credits`);

  console.log('\n2. outstanding liability (unused PURCHASED credits, at the face rate)');
  console.log(`   purchased still unused   ${credits(summary.outstandingPurchasedCredits).padStart(14)} credits   ${money(summary.outstandingLiabilityUsd)}`);
  console.log(`   all balances (signup included) ${credits(summary.totalBalanceCredits).padStart(11)} credits   ${money(summary.totalBalanceUsd)}`);
  console.log('   signup grants are not liability: nobody paid for them.');

  console.log('\n3. float as a share of the provider bill');
  console.log(`   provider cost (${WINDOW_DAYS}d)   ${money(summary.providerCostUsd)}`);
  console.log(`   outstanding liability / provider cost   ${float}`);
  console.log('   all-time provider cost: ' + money(usage.provider_cost_all));

  await pool.end();
  console.log('');
  process.exit(0);
} catch (err) {
  await pool.end().catch(() => {});
  notVerified(`the report could not be read: ${String(err?.message || err).split('\n')[0]}`);
}
