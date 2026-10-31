#!/usr/bin/env node
// verify-licence-end-to-end.mjs — the whole licence chain, without Stripe and without a network.
//
// The unit tests prove the mint; the SDK's tests prove the gate. Neither proves they MEET: a licence this service signs has to install on
// a machine and open a gate, and stop opening it when it expires or is revoked. That meeting point is where a licence product actually
// fails — and it is invisible to both sides' own suites.
//
// It runs the real SDK CLI in a throwaway HOME, so nothing here touches the operator's licence or state. When the CLI is not installed,
// the run says so and is NOT VERIFIED — a chain nobody drove is not a chain that works.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { licenceForEvent, renewalMail, GRACE_DAYS, LICENCE_DAYS } from '../server/src/lib/valiantLicence.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.VALIANT_CLI
  || ['/Users/mac/code/valiant-verification-sdk/bin/valiant.mjs', join(HERE, '..', '..', 'valiant-verification-sdk', 'bin', 'valiant.mjs')].find((p) => existsSync(p));

let wrong = 0;
const check = (n, ok, detail = '') => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}${ok || !detail ? '' : `\n          ${detail}`}`); };

if (!CLI || !existsSync(CLI)) {
  console.log('  NOT VERIFIED  no valiant CLI found — set VALIANT_CLI, or install the SDK, to drive this chain');
  process.exit(2);
}

// A throwaway issuer key: the point is the CHAIN, not this key. The SDK is told to trust it via a keyring directory.
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

const work = mkdtempSync(join(tmpdir(), 'lic-e2e-'));
const home = join(work, 'home');
const repo = join(work, 'repo');
mkdirSync(join(home, '.valiant'), { recursive: true });
mkdirSync(repo, { recursive: true });
execFileSync('git', ['init', '-q', '.'], { cwd: repo });
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'e2e', scripts: { test: 'node t.mjs' } }));
writeFileSync(join(repo, 'lib.js'), 'export const A = 1;\n');
writeFileSync(join(repo, 't.mjs'), "import{readFileSync}from'node:fs';process.exit(readFileSync('lib.js','utf8').includes('A = 1')?0:1);\n");

const env = { ...process.env, HOME: home, VALIANT_LICENCE_KEY: pubPem, VALIANT_HOME: home };
// STDERR IS PART OF THE ANSWER. A passing gate still prints warnings to stderr (a revocation notice is exactly that), and an
// execFileSync wrapper drops it on exit 0 — so the first version of this harness could not see the very warning it asserted.
const valiant = (args, cwd = repo) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', env, timeout: 120_000 });
  return { code: r.status === null ? 2 : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const license = (token) => writeFileSync(join(home, '.valiant', 'licence'), `${token}\n`);
// AN ADOPTED REPO, or `gate` refuses before licensing is ever consulted — the first run of this script proved that by failing on
// "this repo has no valiant.json" and never reaching the licence. `init` writes the config, proves a guard and the mutations.
{
  const init = valiant(['init']);
  if (init.code !== 0) { console.log(`  NOT VERIFIED  could not adopt the fixture repo: ${init.out.split('\n')[0]}`); process.exit(2); }
}
const paid = (q = 1) => ({ id: 'evt_e2e', type: 'invoice.paid', data: { object: { customer: 'cus_e2e', lines: { data: [{ quantity: q }] } } } });

// ── a paid purchase becomes a licence that opens a gate
{
  const r = licenceForEvent(paid(), { keyPem, to: 'buyer@example.com' });
  check('a paid event mints a licence and an email', r.minted === true && r.mail?.ok === true);
  check(`the licence is ${LICENCE_DAYS} days`, Math.round((r.claims.exp - r.claims.iat) / 86_400) === LICENCE_DAYS);
  check('the email carries the token, so the buyer can install it', typeof r.mail?.mail?.text === 'string' && r.mail.mail.text.includes(r.claims.jti));
  license(r.licence);
  const g = valiant(['gate']);
  check('…and the gate opens with it installed', g.code === 0, g.out.split('\n').slice(-3).join(' | '));
  const st = valiant(['licence', '--status']);
  check('…and status names the plan and expiry', /(solo|team|enterprise)/i.test(st.out) && /expir/i.test(st.out), st.out.trim().split('\n')[0]);
}

// ── expiry closes the gate on its own, with no network
{
  const r = licenceForEvent(paid(), { keyPem, now: Date.now() - (LICENCE_DAYS + 3) * 86_400_000 });
  license(r.licence);
  const g = valiant(['gate']);
  check('an expired licence closes the gate (exit 2)', g.code === 2, `exit ${g.code}`);
  check('…and says why', /expired/i.test(g.out));
}

// ── a failed payment buys exactly GRACE_DAYS, not a month
{
  const failed = { id: 'evt_fail', type: 'invoice.payment_failed', data: { object: { customer: 'cus_e2e', lines: { data: [{ quantity: 1 }] } } } };
  const r = licenceForEvent(failed, { keyPem });
  check(`a failed payment mints ${GRACE_DAYS} days of grace`, r.minted === true && Math.round((r.claims.exp - r.claims.iat) / 86_400) === GRACE_DAYS);
  check('…labelled as grace', r.claims.grace === true);
  license(r.licence);
  check('…and the gate stays open during it', valiant(['gate']).code === 0);
}

// ── revocation: open for 48 hours, then closed — with no network
{
  const r = licenceForEvent(paid(), { keyPem });
  license(r.licence);
  writeFileSync(join(home, '.valiant', 'revoked.txt'), `${r.claims.jti}\n`);
  rmSync(join(home, '.valiant', 'revocations-seen.json'), { force: true });
  const during = valiant(['gate']);
  check('a revoked licence still gates inside the grace window', during.code === 0, `exit ${during.code}`);
  check('…and warns in the output', /REVOKED/i.test(during.out));
  // move the first-seen clock back past the window, exactly as the SDK records it
  const seen = JSON.parse(readFileSync(join(home, '.valiant', 'revocations-seen.json'), 'utf8'));
  seen.seen[r.claims.jti] = new Date(Date.now() - 49 * 3_600_000).toISOString();
  writeFileSync(join(home, '.valiant', 'revocations-seen.json'), JSON.stringify(seen));
  const after = valiant(['gate']);
  check('…after 48 hours the gate closes (exit 2)', after.code === 2, `exit ${after.code}`);
  check('…and says the grace ran out', /grace has run out/i.test(after.out));
  rmSync(join(home, '.valiant', 'revoked.txt'), { force: true });
  rmSync(join(home, '.valiant', 'revocations-seen.json'), { force: true });
}

// ── seats: one machine, and a CI runner, per seat
{
  const one = licenceForEvent(paid(1), { keyPem }).claims;
  const five = licenceForEvent(paid(5), { keyPem }).claims;
  check('one seat states one machine and one runner', one.seats === 1 && one.runners === 1);
  check('five seats state five of each', five.seats === 5 && five.runners === 5);
}

// ── the email a buyer receives is usable as instructions
{
  const r = licenceForEvent(paid(), { keyPem, to: 'buyer@example.com' });
  const text = `${r.mail.mail.subject}\n${r.mail.mail.text}`;
  check('the email says how to install it', /licence --file|licence <vvs1/i.test(text));
  check('…and what it covers', /30 days|monthly/i.test(text));
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${wrong === 0 ? 'the chain holds: purchase → licence → install → gate → expiry → grace → revocation' : `${wrong} case(s) wrong — the chain is broken somewhere`}\n`);
process.exit(wrong === 0 ? 0 : 1);
