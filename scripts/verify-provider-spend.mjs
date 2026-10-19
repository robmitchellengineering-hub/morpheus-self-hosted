// Verification for real provider spend — the number that replaces an estimate.
//
// The failure being fixed is not that the platform had no cost figure; it had a
// confident one that was wrong by about 2x. So these checks are about the two
// ways that can go wrong again:
//
//   1. THE ARITHMETIC of a balance delta, including the case that must not be
//      mistaken for spend (a top-up), and the case that must not be dressed up
//      as a measurement at all (fewer than two readings).
//   2. THE WORDING. A modelled figure wearing the word "cost" is the whole bug;
//      `describeSpend` is the only place the sentence lives, so it is pinned.
//
// Run: node scripts/verify-provider-spend.mjs

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spendBetween, estimateVsActual, describeSpend } from '../server/src/lib/providerSpend.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (rel) => readFileSync(path.join(REPO, rel), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const r = (balanceUsd, iso) => ({ balanceUsd, readAt: iso });

console.log('\nprovider spend — verification\n');

// ── 1. One reading is not a measurement ─────────────────────────────────────
console.log('1. it refuses to invent a number from nothing');
check('no readings at all', spendBetween([]).available, false);
check('a single reading is not a delta', spendBetween([r(20, '2026-09-24T00:00:00Z')]).available, false);
check('and it says why', /two balance readings/.test(spendBetween([]).reason), true);
check('readings without a usable balance are ignored',
  spendBetween([r(null, '2026-09-24T00:00:00Z'), r(undefined, '2026-09-24T01:00:00Z')]).available, false);
check('a non-array is not a crash', spendBetween(null).available, false);

// ── 2. The delta, which is the real spend ───────────────────────────────────
console.log('\n2. the delta between readings IS the spend');
const two = spendBetween([r(20.81, '2026-09-24T00:00:00Z'), r(18.00, '2026-09-24T12:00:00Z')]);
check('available', two.available, true);
check('spend is first minus last', two.spendUsd, 2.81);
check('samples counted', two.samples, 2);
check('the window is reported', [two.from, two.to], ['2026-09-24T00:00:00.000Z', '2026-09-24T12:00:00.000Z']);
check('the more recent reading wins regardless of array order',
  spendBetween([r(18.00, '2026-09-24T12:00:00Z'), r(20.81, '2026-09-24T00:00:00Z')]).spendUsd, 2.81);
check('it rounds to cents, not floats',
  spendBetween([r(20.8111, '2026-09-24T00:00:00Z'), r(20.0, '2026-09-24T01:00:00Z')]).spendUsd, 0.81);
check('a flat balance is zero spend, not unavailable',
  spendBetween([r(10, '2026-09-24T00:00:00Z'), r(10, '2026-09-24T01:00:00Z')]).spendUsd, 0);

// ── 3. A top-up is not negative spend ───────────────────────────────────────
console.log('\n3. a credit is not mistaken for a refund of usage');
const topped = spendBetween([r(5.00, '2026-09-24T00:00:00Z'), r(25.00, '2026-09-24T01:00:00Z')]);
check('spend floors at zero', topped.spendUsd, 0);
check('the top-up is reported separately', topped.creditedUsd, 20);

// ── 4. How wrong the estimate is ────────────────────────────────────────────
console.log('\n4. the estimate is compared, not trusted');
// 172.75 / 86.375 is exactly 2, so this asserts the arithmetic rather than the rounding.
const over = estimateVsActual(172.75, spendBetween([r(120, '2026-08-25T00:00:00Z'), r(33.625, '2026-09-24T00:00:00Z')]));
check('comparable', over.comparable, true);
check('the ratio says the estimate overstates', over.ratio, 2);
check('both numbers are returned, so neither is hidden', [over.estimateUsd, over.spendUsd], [172.75, 86.38]);
check('an understating estimate is reported too (the dangerous direction)',
  estimateVsActual(10, spendBetween([r(100, '2026-09-01T00:00:00Z'), r(50, '2026-09-24T00:00:00Z')])).ratio, 0.2);
check('with nothing measured it is not comparable',
  estimateVsActual(50, { available: false, reason: 'no readings' }).comparable, false);
check('and it says why', estimateVsActual(50, { available: false, reason: 'no readings' }).reason, 'no readings');

// ── 5. The wording ──────────────────────────────────────────────────────────
console.log('\n5. one sentence, and it never calls the estimate a cost');
const said = describeSpend(two);
check('it uses the word Actual', /^Actual provider spend/.test(said), true);
check('it gives the measured number', said.includes('$2.81'), true);
check('it never says cost', /cost/i.test(said), false);
check('unavailable says unavailable, not zero',
  describeSpend({ available: false, reason: 'no readings' }), 'Actual provider spend: unavailable — no readings.');
check('a top-up is mentioned', /topped up/.test(describeSpend(topped)), true);

// ── 6. It is wired where the balance is already read ────────────────────────
console.log('\n6. recorded where the balance is already fetched, exposed beside the estimate');
const balance = read('server/src/lib/deepseekBalance.js');
check('the balance poll records a reading', /recordBalanceReading\(DEEPSEEK, totalUsd\)/.test(balance), true);
check('recording is best-effort, never a failure of the safeguard',
  read('server/src/lib/providerSpendState.js').includes('reading not recorded'), true);
check('the poll records before it alerts', balance.indexOf('recordBalanceReading') < balance.indexOf('await alert({'), true);

const admin = read('server/src/routes/admin.routes.js');
check('the admin payload carries the measured spend', admin.includes('actualProviderSpend30d,'), true);
check('and labels the estimate as an estimate', admin.includes("costBasis: 'estimated-from-static-rate-table'"), true);
check('the read is scoped to one provider', read('server/src/lib/providerSpendState.js').includes('where provider = $1'), true);

const SQL = 'server/prisma/selfdev-add-provider-balance.sql';
check('the migration exists', existsSync(path.join(REPO, SQL)), true);
const sql = read(SQL).toLowerCase().split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
check('it creates if not exists', /create table if not exists/.test(sql), true);
check('it is idempotent on the index too', /create index if not exists/.test(sql), true);
check('it drops nothing', /\bdrop\b/.test(sql), false);

console.log(`\n${failures === 0 ? '✓' : '✗'} ${checks - failures}/${checks} checks passed\n`);
process.exit(failures === 0 ? 0 : 1);
