// Runtime verification for the settings-driven consignment fee structure.
//
// 2026-09-28, Rob: "Consignment is a set fee structure but i can change it in settings." Until
// then the 30%-to-$2000-then-20% rule was hardcoded in deckConstants.commissionFor, and
// signal_chain.jsx printed its own copy of the rate. The fee is STORED on each item at the moment
// of sale (deck_consignment_items.fee, summed by lib/deckSnapshot.js to say what a consignor is
// owed), so the rule can change but money already recorded cannot. Six things can now go wrong,
// and this file is the thing that fails when they do:
//
//   1. A SECOND derivation of the fee appears, so a stored commission and a displayed one can
//      come from different rules.
//   2. The default changes, so an account that never opened Settings stops getting 30/2000/20.
//   3. The setting does not actually reach the derivation — the field is saved and then ignored.
//   4. A display label goes back to a hardcoded "20%"/"30%" and contradicts the setting.
//   5. A stored fee gets recomputed when the rule changes — the money Rob quotes a consignor.
//   6. The migration that lets any of it persist is missing, or is not additive (H8).
//
// Plus 7: the H11 window this change deliberately opens. The fee columns ship in schema.prisma
// while the hand-run SQL lands later, and entities.js used to read DeckBusinessProfile with no
// `select` — i.e. every column, so an unmigrated column would take the WHOLE Deck down rather than
// the setting reading as absent. The fallback is asserted here because no other gate can see it.
//
// Dependency-free: it imports the pure fee module and the pure prod-SQL classifier and reads
// sources otherwise, so it runs in CI's no-install guards job.
// Run:  node scripts/verify-deck-fee-tiers.mjs
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewSql } from '../server/src/lib/prodSqlGuard.js';
import {
  deckProfileWriteResult, hasDeckProfileFeeFields, DECK_PROFILE_FEE_DROPPED,
} from '../server/src/lib/deckProfileColumns.js';
import {
  DEFAULT_FEE_TIERS, commissionFor, feeTiersFromProfile, feeRateLabel, consignorProceeds,
  parseFeeTierInput, normalizeFeeTiers,
} from '../src/pages/CommandDeck/feeTiers.js';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

function sourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(join(REPO, dir), { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(rel));
    else if (/\.(js|jsx)$/.test(entry.name)) out.push(rel);
  }
  return out;
}

console.log('\n1. there is exactly one fee derivation');
const feeModule = read('src/pages/CommandDeck/feeTiers.js');
const deckConstants = read('src/pages/CommandDeck/deckConstants.js');
check('the pure fee module defines it once', (feeModule.match(/export function commissionFor\(/g) || []).length, 1);
check('deckConstants no longer defines it', /export function commissionFor/.test(deckConstants), false);
check('deckConstants re-exports the one definition',
  /export \{[\s\S]*commissionFor[\s\S]*\} from '\.\/feeTiers';/.test(deckConstants), true);
const definers = [...sourceFiles('src'), ...sourceFiles('server/src')]
  .filter((p) => /function\s+commissionFor\s*\(/.test(read(p)))
  .map((p) => relative(REPO, join(REPO, p)));
check('no other file defines a fee derivation', definers, ['src/pages/CommandDeck/feeTiers.js']);

console.log('\n2. the default is still 30% to $2000, 20% above');
check('(price) with no tiers argument still works', commissionFor(1000), 300);
check('up to and including the threshold, the under rate applies', commissionFor(2000), 600);
check('the rate switches just above the threshold', Math.abs(commissionFor(2000.01) - 400.002) < 1e-6, true);
check('above the threshold, the over rate applies', commissionFor(5000), 1000);
check('the default constant is the documented one', DEFAULT_FEE_TIERS, { threshold: 2000, rateUnder: 30, rateOver: 20 });
check('no tiers at all resolves to the default', normalizeFeeTiers(null), DEFAULT_FEE_TIERS);
check('a profile with NULL columns resolves to the default',
  feeTiersFromProfile({ fee_threshold: null, fee_rate_under: null, fee_rate_over: null }), DEFAULT_FEE_TIERS);

console.log('\n3. the settings value reaches the one derivation');
check('feeTiersFromProfile reads the three columns',
  feeTiersFromProfile({ fee_threshold: 5000, fee_rate_under: 10, fee_rate_over: 5 }),
  { threshold: 5000, rateUnder: 10, rateOver: 5 });
check('a saved structure changes the fee above its threshold',
  commissionFor(6000, feeTiersFromProfile({ fee_threshold: 5000, fee_rate_under: 10, fee_rate_over: 5 })), 300);
check('…and below it',
  commissionFor(1000, feeTiersFromProfile({ fee_threshold: 5000, fee_rate_under: 10, fee_rate_over: 5 })), 100);
check('a stored zero rate is honored, not read as "use the default"',
  commissionFor(1000, feeTiersFromProfile({ fee_threshold: 2000, fee_rate_under: 0, fee_rate_over: 0 })), 0);
const ctx = read('src/contexts/CommandDeckContext.jsx');
check('the context derives the tiers once from businessProfile',
  /const feeTiers = useMemo\(\(\) => feeTiersFromProfile\(businessProfile\), \[businessProfile\]\);/.test(ctx), true);
check('both fee write sites pass them to the one derivation',
  /fee: soldPrice !== null \? commissionFor\(soldPrice, feeTiers\) : null,/.test(ctx)
  && /next\.fee = p === null \? null : commissionFor\(p, feeTiers\);/.test(ctx), true);
check('every commissionFor call in the context is one of those two',
  (ctx.match(/commissionFor\(/g) || []).length, 2);
check('the context hands the tiers to the display call sites',
  /businessProfile, businessProfileBusy, saveBusinessProfile, feeTiers,/.test(ctx), true);

console.log('\n4. no display label can contradict the setting');
const ui = read('src/pages/CommandDeck/widgets/signal_chain.jsx');
check('the hardcoded 20/30 label is gone',
  /Number\(form\.price\) > 2000 \? '20%' : '30%'/.test(ui), false);
check('the rate label comes from the tiers', /feeRateLabel\(form\.price, feeTiers\)/.test(ui), true);
check('the intake-cut preview comes from the tiers', /commissionFor\(formSoldPrice, feeTiers\)/.test(ui), true);
check('the on-the-floor preview comes from the tiers', /commissionFor\(i\.price, feeTiers\)/.test(ui), true);
check('the label reflects custom tiers below the threshold',
  feeRateLabel(1000, { threshold: 2000, rateUnder: 25, rateOver: 12 }), '25%');
check('…and above it', feeRateLabel(3000, { threshold: 2000, rateUnder: 25, rateOver: 12 }), '12%');
check('the consignor figure is the sale price minus that cut',
  consignorProceeds(3000, { threshold: 2000, rateUnder: 25, rateOver: 12 }), 2640);

console.log('\n5. a stored fee is never recomputed when the rule changes');
const soldLabel = (ui.match(/function soldLabel\(i\) \{[\s\S]*?\n\}/) || [''])[0];
check('the sold label derives nothing', /commissionFor/.test(soldLabel), false);
check('…it reads the STORED fee', /i\.fee/.test(soldLabel) && /i\.sold_price - i\.fee/.test(soldLabel), true);
const snapshot = read('server/src/lib/deckSnapshot.js');
check('the snapshot sums the stored fee, not a re-derivation',
  /_sum: \{ sold_price: true, fee: true \}/.test(snapshot), true);
check('…and never calls the fee rule', /commissionFor\s*\(/.test(snapshot), false);

console.log('\n6. the migration ships with the schema change, and is additive');
const MIGRATION = 'server/prisma/selfdev-deck-fee-tiers.sql';
check('the migration file exists', existsSync(join(REPO, MIGRATION)), true);
const sql = read(MIGRATION);
check('it is additive-only (the production-SQL classifier agrees)', reviewSql(sql).ok, true);
for (const column of ['fee_threshold', 'fee_rate_under', 'fee_rate_over']) {
  check(`it adds ${column} idempotently`,
    new RegExp(`alter table deck_business_profiles add column if not exists ${column}\\b`, 'i').test(sql), true);
}
check('it never rewrites data or drops anything',
  /\b(update|delete|insert|drop|truncate|alter column|rename)\b/i.test(sql.replace(/^--.*$/gm, '')), false);
const schema = read('server/prisma/schema.prisma');
check('schema.prisma declares all three columns on DeckBusinessProfile',
  /model DeckBusinessProfile \{[\s\S]*?fee_threshold\s+Float\?[\s\S]*?fee_rate_under\s+Float\?[\s\S]*?fee_rate_over\s+Float\?[\s\S]*?\n\}/.test(schema), true);

console.log('\n7. an unapplied migration cannot take the Deck down (H11)');
const entities = read('server/src/entities.js');
const profileColumns = read('server/src/lib/deckProfileColumns.js');
check('every DeckBusinessProfile list/filter/get names its columns',
  /readDeckProfile\(\(select\) => delegate\(name\)\.findMany\(\{ \.\.\.query, select \}\)\)/.test(entities)
  && /readDeckProfile\(\(select\) => delegate\(name\)\.findMany\(\{ \.\.\.args, select \}\)\)/.test(entities)
  && /readDeckProfile\(\(select\) => run\(\{ select \}\)\)/.test(entities), true);
check('…and steps down to the pre-migration columns when Prisma says a column is missing',
  /isMissingDeckProfileColumn\(err\)/.test(entities) && /deckProfileSelect\(\{ withFee: false \}\)/.test(entities), true);
check('a profile create/update also survives the missing column',
  /writeDeckProfile\(write, rest\)/.test(entities) && /withoutDeckProfileFeeFields\(data\)/.test(entities), true);
check('the AI-context read is protected too',
  /select: deckProfileSelect\(\)/.test(read('server/src/lib/deckBusinessProfile.js')), true);
check('the fallback is the OLD column set, not an empty one',
  /DECK_PROFILE_BASE_SELECT = \{[\s\S]*business_context: true/.test(profileColumns), true);
check('the three fee columns are named in exactly one list',
  (profileColumns.match(/'fee_threshold'/g) || []).length, 1);

console.log('\n7b. a dropped fee write is VISIBLE, not a silent success');
// The read fallback (above) is the safe degradation. The write fallback is the dangerous one: the
// server strips the fee fields to let the rest of the save succeed, so without a marker the
// operator gets a plain "Saved" over a fee structure that was never stored. These pin the marker
// and the sentence that makes it visible.
const settings = read('src/pages/CommandDeck/DeckSettings.jsx');
check('the marker key is what the API sends', DECK_PROFILE_FEE_DROPPED, 'fee_fields_dropped');
check('a write that dropped the fee fields is flagged',
  deckProfileWriteResult({ id: 'x', shop_name: 'a' }, { shop_name: 'a', fee_rate_under: 25 }, { droppedFeeFields: true }),
  { id: 'x', shop_name: 'a', fee_fields_dropped: true });
check('a write that carried NO fee fields is not flagged',
  deckProfileWriteResult({ id: 'x' }, { shop_name: 'a' }, { droppedFeeFields: true }), { id: 'x' });
check('a write that kept its fee fields is not flagged',
  deckProfileWriteResult({ id: 'x' }, { fee_rate_under: 25 }, {}), { id: 'x' });
check('a fee field sent as null still counts as "the form asked to store it"',
  hasDeckProfileFeeFields({ fee_threshold: null }), true);
check('an ordinary profile save carries no fee field',
  hasDeckProfileFeeFields({ shop_name: 'a', business_context: 'b' }), false);
check('the marker is set by the fallback write path only',
  /deckProfileWriteResult\(row, data, \{ droppedFeeFields: true \}\)/.test(entities), true);
check('the context reads the marker and keeps it OUT of the profile state',
  /feeFieldsDropped = saved\?\.fee_fields_dropped === true;/.test(ctx)
  && /delete row\.fee_fields_dropped;/.test(ctx), true);
check('Settings says what actually happened, in plain words, naming the action',
  /Saved, except the fee structure — that needs a database update before it can be stored\./.test(settings), true);
check('…and does not print a bare "✓ Saved" over it',
  /\{saved && !feeDropped &&/.test(settings), true);

console.log('\n8. nonsense is rejected rather than stored');
check('a rate over 100% is refused', parseFeeTierInput({ fee_rate_under: '150' }).ok, false);
check('a negative rate is refused', parseFeeTierInput({ fee_rate_over: '-1' }).ok, false);
check('a negative threshold is refused', parseFeeTierInput({ fee_threshold: '-1' }).ok, false);
check('a non-number is refused', parseFeeTierInput({ fee_rate_over: 'abc' }).ok, false);
check('blank means "use the default" and is allowed',
  parseFeeTierInput({ fee_threshold: '', fee_rate_under: '', fee_rate_over: '' }).fields,
  { fee_threshold: null, fee_rate_under: null, fee_rate_over: null });
check('valid input becomes numbers for the Float columns',
  parseFeeTierInput({ fee_threshold: '2000', fee_rate_under: '30', fee_rate_over: '20' }).fields,
  { fee_threshold: 2000, fee_rate_under: 30, fee_rate_over: 20 });
check('a rate of 0 is accepted and stored as 0 — not treated as blank',
  parseFeeTierInput({ fee_rate_under: '0' }).fields.fee_rate_under, 0);
check('rates are percentages: 0.3 means 0.3%, not a third',
  parseFeeTierInput({ fee_rate_under: '0.3' }).fields.fee_rate_under, 0.3);
check('the Settings field shows the unit in its label',
  /Our cut up to it \(%\)/.test(settings) && /Our cut above it \(%\)/.test(settings), true);
check('the Settings live preview uses the same derivation',
  /commissionFor\(sample, previewTiers\)/.test(settings) && /consignorProceeds\(sample, previewTiers\)/.test(settings), true);
check('Save is blocked while the input is invalid', /!parsed\.ok/.test(settings), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
