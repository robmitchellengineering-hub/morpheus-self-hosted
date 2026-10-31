#!/usr/bin/env node
// licence-chain-e2e.mjs — the whole licence chain, driven end to end, without Stripe and without a network.
//
// The issuer's unit tests prove the mint. The SDK's tests prove the gate. Neither proves they MEET — and the meeting point is where a
// licence product actually fails. This drives both: a paid event mints a licence and an email, the licence installs into a clean HOME,
// the gate opens with it, and it stops opening when it expires or is revoked. It also asserts the boundaries the product promises: 7
// days of grace after a failed payment, 48 hours of grace before a revocation blocks, and a seat meaning one machine and one runner.
//
// It runs the real SDK CLI in a throwaway HOME, so the operator's licence and state are never touched. When no CLI is present the run is
// NOT VERIFIED (exit 2) — a chain nobody drove is not a chain that works.
//
// HOUSE RULE, learned by breaking it: a fixture server runs in ITS OWN PROCESS (scripts/fixture-issuer.mjs) and readiness is a port file,
// not a timer. A server started inside this file cannot answer a child launched with spawnSync, because that call blocks this process's
// event loop — which made two checks pass or fail between runs for no reason the output could show.
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { generateKeyPairSync } from 'node:crypto';
import { licenceForEvent, LICENCE_DAYS, GRACE_DAYS } from '../server/src/lib/valiantLicence.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = process.env.VALIANT_CLI || [
  '/Users/mac/code/valiant-verification-sdk/bin/valiant.mjs',
  join(HERE, '..', '..', 'valiant-verification-sdk', 'bin', 'valiant.mjs'),
].find((p) => existsSync(p));

let wrong = 0;
const check = (name, ok, detail = '') => {
  if (!ok) wrong++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

if (!CLI || !existsSync(CLI)) {
  console.log('  NOT VERIFIED  no valiant CLI found — set VALIANT_CLI, or install the SDK, to drive this chain');
  process.exit(2);
}

// A throwaway issuer key: the point is the CHAIN, not this key. The SDK is told to trust it through VALIANT_LICENCE_KEY.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });

const work = mkdtempSync(join(tmpdir(), 'lic-e2e-'));
const home = join(work, 'home');
const repo = join(work, 'repo');
mkdirSync(join(home, '.valiant'), { recursive: true });
mkdirSync(repo);
execFileSync('git', ['init', '-q', '.'], { cwd: repo });
writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'e2e', scripts: { test: 'node t.mjs' } }));
writeFileSync(join(repo, 'lib.js'), 'export const A = 1;\n');
writeFileSync(join(repo, 't.mjs'), "import{readFileSync}from'node:fs';process.exit(readFileSync('lib.js','utf8').includes('A = 1')?0:1);\n");

const env = { ...process.env, HOME: home, VALIANT_LICENCE_KEY: pubPem };
const valiant = (args, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: 'utf8', env: { ...env, ...extraEnv }, timeout: 180_000 });
  return { code: r.status === null ? 2 : r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const license = (token) => writeFileSync(join(home, '.valiant', 'licence'), `${token}\n`);
const paid = (q = 1) => ({ id: 'evt_e2e', type: 'invoice.paid', data: { object: { customer: 'cus_e2e', lines: { data: [{ quantity: q }] } } } });
const failed = (q = 1) => ({ id: 'evt_fail', type: 'invoice.payment_failed', data: { object: { customer: 'cus_e2e', lines: { data: [{ quantity: q }] } } } });
const forget = (name) => rmSync(join(home, '.valiant', name), { force: true });

// An adopted repo, or `gate` refuses before licensing is ever consulted.
{
  const init = valiant(['init']);
  if (init.code !== 0) { console.log(`  NOT VERIFIED  could not adopt the fixture repo: ${init.out.split('\n')[0]}`); process.exit(2); }
}

// ── 1. a paid purchase becomes a licence and an email that opens a gate ──────────────────────────────────────────────
{
  const r = licenceForEvent(paid(), { keyPem, to: 'buyer@example.com' });
  check('a paid event mints a licence and an email', r.minted === true && r.mail?.ok === true);
  check(`the licence is ${LICENCE_DAYS} days`, Math.round((r.claims.exp - r.claims.iat) / 86_400) === LICENCE_DAYS);
  check('the email carries the token, so the buyer can install it', typeof r.mail?.mail?.text === 'string' && r.mail.mail.text.includes(r.claims.jti));
  license(r.licence);
  forget('seats.json');
  const g = valiant(['gate']);
  check('…and the gate opens with it installed', g.code === 0, g.out.split('\n').slice(-2).join(' | '));
  const st = valiant(['licence', '--status']);
  check('…and status names the plan and expiry', /(solo|team|enterprise)/i.test(st.out) && /expir/i.test(st.out), st.out.trim().split('\n')[0]);
}

// ── 2. expiry closes the gate on its own, with no network ───────────────────────────────────────────────────────────
{
  const r = licenceForEvent(paid(), { keyPem, now: Date.now() - (LICENCE_DAYS + 3) * 86_400_000 });
  license(r.licence);
  forget('seats.json');
  const g = valiant(['gate']);
  check('an expired licence closes the gate (exit 2)', g.code === 2, `exit ${g.code}`);
  check('…and says why', /expired/i.test(g.out), g.out.trim().split('\n').slice(-2).join(' | '));
}

// ── 3. a failed payment buys exactly GRACE_DAYS, not a month ────────────────────────────────────────────────────────
{
  const r = licenceForEvent(failed(), { keyPem });
  check(`a failed payment mints ${GRACE_DAYS} days of grace`, r.minted === true && Math.round((r.claims.exp - r.claims.iat) / 86_400) === GRACE_DAYS);
  check('…labelled as grace', r.claims.grace === true);
  license(r.licence);
  forget('seats.json');
  check('…and the gate stays open during it', valiant(['gate']).code === 0);
}

// ── 4. revocation: 48 hours of grace, then closed — with no network ──────────────────────────────────────────────────
{
  const r = licenceForEvent(paid(), { keyPem });
  license(r.licence);
  forget('seats.json');
  writeFileSync(join(home, '.valiant', 'revoked.txt'), `${r.claims.jti}\n`);
  forget('revocations-seen.json');
  const during = valiant(['gate']);
  check('a revoked licence still gates inside the grace window', during.code === 0, `exit ${during.code}`);
  check('…and warns in the output', /REVOKED/i.test(during.out));
  const seen = JSON.parse(readFileSync(join(home, '.valiant', 'revocations-seen.json'), 'utf8'));
  seen.seen[r.claims.jti] = new Date(Date.now() - 49 * 3_600_000).toISOString();
  writeFileSync(join(home, '.valiant', 'revocations-seen.json'), JSON.stringify(seen));
  const after = valiant(['gate']);
  check('…after 48 hours the gate closes (exit 2)', after.code === 2, `exit ${after.code}`);
  check('…and says the grace ran out', /grace has run out/i.test(after.out), after.out.trim().split('\n').slice(-2).join(' | '));
  forget('revoked.txt');
  forget('revocations-seen.json');
}

// ── 5. seats: one machine and one CI runner per seat, stated in the claim ────────────────────────────────────────────
{
  const one = licenceForEvent(paid(1), { keyPem }).claims;
  const five = licenceForEvent(paid(5), { keyPem }).claims;
  check('one seat states one machine and one runner', one.seats === 1 && one.runners === 1);
  check('five seats state five of each', five.seats === 5 && five.runners === 5);
  const bound = licenceForEvent(paid(1), { keyPem });
  license(bound.licence);
  forget('seats.json');
  check('the first machine claims the seat', valiant(['gate']).code === 0);
  const claimed = JSON.parse(readFileSync(join(home, '.valiant', 'seats.json'), 'utf8'));
  check('…and the claim is recorded, so the count is visible', JSON.stringify(claimed).includes(bound.claims.jti));
  // The honest boundary: offline, a second machine cannot know the seat is taken. One claim per machine, N machines per licence, and the
  // online check is what enforces the count. Asserting that a second offline machine is refused would be asserting a promise the design
  // does not make.
  const otherHome = join(work, 'home2');
  mkdirSync(join(otherHome, '.valiant'), { recursive: true });
  writeFileSync(join(otherHome, '.valiant', 'licence'), `${bound.licence}\n`);
  const second = spawnSync(process.execPath, [CLI, 'gate'], { cwd: repo, encoding: 'utf8', env: { ...env, HOME: otherHome }, timeout: 180_000 });
  check('a second machine makes its own claim — the count is what limits it', (second.status ?? 2) === 0, `exit ${second.status}`);
}

// ── 6. the email a buyer receives is usable as instructions ─────────────────────────────────────────────────────────
{
  const r = licenceForEvent(paid(), { keyPem, to: 'buyer@example.com' });
  const text = `${r.mail.mail.subject}\n${r.mail.mail.text}`;
  check('the email says how to install it', /licence --file|licence <vvs1/i.test(text));
  check('…and what it covers', /30 days|monthly/i.test(text));
}

// ── 7. failure paths fail CLOSED, each with a stated reason ─────────────────────────────────────────────────────────
{
  const { normalizeCheckBody, peekClaims } = await import('../server/src/lib/licenceCheckShape.js');
  check('a check body with no licence is refused with a reason', normalizeCheckBody({}).ok === false && /no licence/i.test(normalizeCheckBody({}).why));
  check('…and a licence with no claims is not read as valid', peekClaims('not-a-token').ok === false || peekClaims('not-a-token').claims == null);
  license(licenceForEvent(paid(), { keyPem }).licence);
  forget('seats.json');
  const online = valiant(['licence', '--online'], { VALIANT_LICENCE_URL: 'http://127.0.0.1:9/licenceCheck' });
  check('an unreachable issuer does not produce a green check', online.code !== 0, `exit ${online.code}`);
  check('…and says the check could not be made', /could not|unreachable|not be checked|offline/i.test(online.out), online.out.trim().split('\n')[0]);
}

// ── 8. the revocation list, served by the issuer and picked up with no file copying ─────────────────────────────────
{
  const { mintRevocationList } = await import('/Users/mac/code/valiant-verification-sdk/src/revocation.mjs');
  const { mintLicence } = await import('/Users/mac/code/valiant-verification-sdk/src/stripe-renew.mjs');
  const r = licenceForEvent(paid(), { keyPem });
  license(r.licence);
  forget('seats.json');
  forget('revoked.txt');
  forget('revocations-seen.json');
  // The kid is not optional once a build carries a keyring — production stamps it, so the test must mint what production mints.
  const list = mintRevocationList({ keyPem, jtis: [r.claims.jti], now: Date.now(), kid: 'vvs-2026-10', mint: mintLicence });
  check('the issuer signs a revocation list', list.ok === true && String(list.token).startsWith('vvs1.'), list.why ?? '');

  const portFile = join(work, 'issuer.port');
  const srv = spawn(process.execPath, [join(HERE, 'fixture-issuer.mjs'), list.token, portFile], { stdio: ['ignore', 'ignore', 'inherit'] });
  let port = null;
  for (let i = 0; i < 200 && !port; i++) {
    if (existsSync(portFile)) { const v = readFileSync(portFile, 'utf8').trim(); if (/^\d+$/.test(v)) port = v; }
    if (!port) await new Promise((res) => setTimeout(res, 25));
  }
  try {
    check('the fixture issuer is listening', !!port, `no port file at ${portFile}`);
    const sync = valiant(['licence', '--sync'], { VALIANT_SYNC_URL: `http://127.0.0.1:${port}/revocations` });
    check('the SDK fetches the list from the issuer', sync.code === 0, sync.out.trim().split('\n')[0]);
    const g = valiant(['gate']);
    check('…and the revocation is known without any file being copied', /REVOKED/i.test(g.out), g.out.trim().split('\n').slice(-2).join(' | '));
  } finally {
    srv.kill('SIGTERM');
  }
}

rmSync(work, { recursive: true, force: true });
console.log(`\n${wrong === 0 ? 'the chain holds: purchase → licence → install → gate → expiry → grace → revocation → seats → failure paths' : `${wrong} case(s) wrong — the chain is broken somewhere`}\n`);
process.exit(wrong === 0 ? 0 : 1);
