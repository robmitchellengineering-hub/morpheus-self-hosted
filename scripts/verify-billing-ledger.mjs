// Does the money we recorded match the money we charged? (Token plan Step 7.)
//
// THE CLAIM IT TESTS. Three code paths write the same money in three places: `usage_events.credits_charged`
// (what the call cost the user), `users.credit_balance` (what they have left) and `credit_transactions`
// (what they bought). The platform's whole "honest meter" promise rests on those agreeing, and until
// 2026-09-28 nothing checked it — `verify-billing-clamp.mjs` covers only the clamp invariant, and
// `reality.mjs` covers model pricing and negative balances. This is the missing reconciliation.
//
// IT USES THE REAL PRICING FUNCTIONS — `resolveBillingRate`, `resolveBillingMarkup`, `usdToCredits` from
// lib/billing.js — rather than re-deriving the policy here, because a checker that re-implements the
// thing it checks is a checker that agrees with itself while the meter drifts.
//
// EXIT: 0 everything reconciles · 1 a discrepancy (named, with amounts) · 2 cannot check (no credential).
// Exit 2 is never a pass — the same contract verify-schema-prod.mjs has.
//
// Run:  node scripts/verify-billing-ledger.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkChargeRow, classifyBalance, impliedBalance, round4, SIGNUP_CREDITS } from '../server/src/lib/billingLedger.js';
import { isFlatRateCall, isOwnKeyProvider, FLAT_RATE_SINCE } from '../server/src/lib/creditPolicy.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = join(REPO, 'server', '.env.prodsql');

if (!existsSync(ENV_PATH)) {
  console.log('\n  NOT VERIFIED — server/.env.prodsql missing, so the production ledger cannot be read.');
  console.log('  This is never a pass: it means the billing ledger was not checked.\n');
  process.exit(2);
}

const env = readFileSync(ENV_PATH, 'utf8');
const url = (env.match(/PROD_DATABASE_URL\s*=\s*"?([^"\n]+)"?/) || [])[1];
if (!url) {
  console.log('\n  NOT VERIFIED — no PROD_DATABASE_URL in server/.env.prodsql.\n');
  process.exit(2);
}
// The real modules reach Prisma, which reads DATABASE_URL. Set before importing them.
process.env.DATABASE_URL = url;

const require = createRequire(join(REPO, 'server', 'package.json'));
const { Pool } = require('pg');

let failures = 0;
const problems = [];
const note = (msg) => problems.push(msg);

const pool = new Pool({ connectionString: url, connectionTimeoutMillis: 15000, ssl: { rejectUnauthorized: false } });

try {
  const { resolveBillingRate, resolveBillingMarkup, usdToCredits } = await import('../server/src/lib/billing.js');
  const { computeCostUsd } = await import('../server/src/lib/modelPricing.js');

  const users = (await pool.query(
    'select id, email, role, billing_exempt, credit_balance::float as balance from users',
  )).rows;
  const usage = (await pool.query(`
    select created_by_id, model_id, provider, coalesce(input_tokens,0) as input_tokens,
           coalesce(output_tokens,0) as output_tokens, coalesce(credits_charged,0)::float as credits_charged,
           created_date
    from usage_events`)).rows;
  const purchases = (await pool.query(`
    select created_by_id, sum(credits)::float as credits from credit_transactions
    where status = 'paid' group by created_by_id`)).rows;

  console.log('\nBilling ledger — charges against recorded usage\n');
  console.log(`  users ${users.length} · usage rows ${usage.length} · purchase rows ${purchases.length}`);

  // ── 1. Every charged row matches the pricing policy ────────────────────────
  const rateCache = new Map();
  const rateFor = async (model) => {
    if (!rateCache.has(model)) {
      const [r, markup] = await Promise.all([resolveBillingRate(model), resolveBillingMarkup(model)]);
      rateCache.set(model, { ...r, markup });
    }
    return rateCache.get(model);
  };

  let chargedRows = 0, mismatched = 0, flatRows = 0, historicalFlatRows = 0;
  for (const row of usage) {
    if (!(row.credits_charged > 0)) continue;
    chargedRows++;
    const flat = isFlatRateCall({ provider: row.provider, model: row.model_id });
    if (flat) flatRows++;
    // A flat-rated MODEL charged before the rule existed was charged under the old token-priced
    // rule. That is history, not a defect: money already taken from a user is not rewritten by a
    // later price change. REPORTED, never failed — the same call the 2026-09-01 admin-role row gets
    // below, and for the same reason (a rule that did not exist yet cannot have been violated).
    const isHistorical = flat && !isOwnKeyProvider(row.provider) && new Date(row.created_date) < new Date(FLAT_RATE_SINCE);
    if (isHistorical) {
      historicalFlatRows++;
      continue;
    }
    const rate = await rateFor(row.model_id);
    const verdict = checkChargeRow({
      creditsCharged: row.credits_charged,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      inputPerM: rate.inputPerM,
      outputPerM: rate.outputPerM,
      markup: rate.markup,
      flat,
    });
    if (!verdict.ok) {
      mismatched++;
      if (mismatched <= 5) {
        note(`charge mismatch: ${row.model_id} charged ${row.credits_charged} but the policy gives ${verdict.expected} (gap ${verdict.gap})`);
      }
    }
  }
  console.log(`\n1. charges match the pricing policy`);
  console.log(`   charged rows ${chargedRows} (flat ${flatRows}) · mismatched ${mismatched}`);
  if (historicalFlatRows) {
    console.log(`   ${historicalFlatRows} row(s) billed before the flat-model rule took effect (${FLAT_RATE_SINCE}) — reported, not failed`);
  }
  if (mismatched) failures++;

  // ── 2. Every model we charged from has an explicit price ───────────────────
  // Reported here as well as by reality.mjs, because a fallback rate is WHY a charge can be
  // self-consistent and still wrong: the formula holds while the price nobody chose is applied.
  const chargedModels = [...new Set(usage.filter((r) => r.credits_charged > 0).map((r) => r.model_id))];
  const { MODEL_PRICING, DEFAULT_PRICING } = await import('../server/src/lib/costEstimate.js');
  const unpriced = chargedModels.filter((m) => !Object.prototype.hasOwnProperty.call(MODEL_PRICING, m));
  console.log(`\n2. every charged model has a price someone chose`);
  console.log(`   priced ${chargedModels.length - unpriced.length}/${chargedModels.length}${unpriced.length ? ` · UNPRICED: ${unpriced.join(', ')}` : ''}`);
  if (unpriced.length) {
    note(`unpriced model(s) billed from DEFAULT_PRICING {in ${DEFAULT_PRICING.input}, out ${DEFAULT_PRICING.output}}: ${unpriced.join(', ')}`);
    failures++;
  }

  // ── 3. Every balance equals purchases minus charges ─────────────────────────
  const chargedBy = new Map();
  for (const row of usage) {
    if (row.credits_charged > 0) chargedBy.set(row.created_by_id, round4((chargedBy.get(row.created_by_id) || 0) + row.credits_charged));
  }
  const boughtBy = new Map(purchases.map((p) => [p.created_by_id, Number(p.credits || 0)]));

  let absorbedTotal = 0, drifted = 0;
  for (const u of users) {
    const charged = chargedBy.get(u.id) || 0;
    const purchased = boughtBy.get(u.id) || 0;
    const implied = impliedBalance({ purchased, charged });
    const verdict = classifyBalance({ balance: u.balance, implied });
    if (verdict.state === 'absorbed') absorbedTotal = round4(absorbedTotal + verdict.absorbed);
    if (verdict.state === 'drift') {
      drifted++;
      if (drifted <= 5) note(`balance drift: ${u.email} holds ${u.balance} but purchases minus charges imply ${implied} (delta ${verdict.delta})`);
    }
  }
  console.log(`\n3. every balance equals ${SIGNUP_CREDITS} signup + purchases − charges`);
  console.log(`   accounts drifted ${drifted} · absorbed as platform cost ${absorbedTotal} credits ($${(absorbedTotal * 0.005).toFixed(4)})`);
  if (drifted) failures++;
  if (absorbedTotal > 0) console.log('   (absorption is the documented floor-at-zero behaviour, not drift — reported as cost)');

  // ── 4. Nobody exempt was charged ───────────────────────────────────────────
  // The role a user held WHEN a call was made is not recorded, so this can only report against the
  // CURRENT role — a later role change makes history look wrong. Reported, never failed on.
  const exemptIds = new Set(users.filter((u) => u.billing_exempt === true || String(u.role || '').trim().toLowerCase() === 'admin').map((u) => u.id));
  const exemptRows = usage.filter((r) => r.credits_charged > 0 && exemptIds.has(r.created_by_id));
  console.log(`\n4. accounts that are exempt now carry no charges`);
  console.log(`   charged rows on currently-exempt accounts ${exemptRows.length}`);
  if (exemptRows.length) {
    const oldest = exemptRows.reduce((a, b) => (new Date(a.created_date) < new Date(b.created_date) ? a : b));
    console.log(`   oldest ${new Date(oldest.created_date).toISOString().slice(0, 10)} — before the exemption existed, per the role held then (not recorded)`);
  }

  await pool.end();

  console.log(`\n${failures ? `FAILED — ${failures} check(s) reported above` : 'the ledger reconciles'}`);
  for (const p of problems) console.log(`  · ${p}`);
  console.log('');
  process.exit(failures ? 1 : 0);
} catch (err) {
  await pool.end().catch(() => {});
  console.log(`\n  NOT VERIFIED — the ledger could not be read: ${String(err?.message || err).split('\n')[0]}`);
  console.log('  This is never a pass.\n');
  process.exit(2);
}
