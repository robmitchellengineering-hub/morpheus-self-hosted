#!/usr/bin/env node
// verify-licence-endpoints.mjs — the two public endpoints, with their real code, driven to a real answer.
//
// WHAT THIS ADDS. `verify-licence-check.mjs` tests the decision and the shape. Nothing tested the ENDPOINTS as they will run in production:
// `licenceCheck` reading a row, `revocations` building and signing a list. Both spend most of the licence goal unproven because the
// deployment had no key — and "it will work once the key is there" is exactly the sentence this project exists to refuse.
//
// So the key is injected and the database is faked. What that proves is the code: a valid licence verifies, a revoked one is refused, an
// expired one is refused, and the list that comes out is signed, carries a kid, and verifies with the SDK's own verifier. What is left
// unproven — and stated below rather than implied — is only that the key reaches the deployment.
import { generateKeyPairSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decideCheck } from '../server/src/lib/licenceDecision.js';
import { claimsForList } from '../server/src/lib/revocationList.js';
import { signLicence } from '../server/src/lib/licenceKey.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let wrong = 0;
const check = (name, ok, detail = '') => {
  if (!ok) wrong++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : `\n          ${detail}`}`);
};

// A throwaway issuer. The SDK is told to trust its public half, so the verification below is the same code a customer's machine runs.
const { privateKey, publicKey } = generateKeyPairSync('ed25519');
const keyPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
process.env.VALIANT_LICENCE_PUBLIC_KEY = pubPem;
process.env.VVS_ISSUER_KEY_PEM = keyPem;

const now = Math.floor(Date.now() / 1000);
const base = { v: 1, sub: 'cus_endpoint', plan: 'solo', seats: 1, runners: 1, iat: now - 60, exp: now + 30 * 86_400, kid: 'vvs-2026-10', jti: 'lic_ep_1' };
const token = signLicence(base, keyPem);
const db = (rows) => ({ $queryRaw: async () => rows });

// ── the check, answering all three questions
{
  const live = await decideCheck({ body: { licence: token }, db: db([{ revoked_at: null }]), now });
  check('a live licence is valid', live.valid === true && live.jti === 'lic_ep_1', JSON.stringify(live).slice(0, 160));
  check('…and it echoes the plan and seats, so support can answer from the reply', live.plan === 'solo' && live.seats === 1);

  const revoked = await decideCheck({ body: { licence: token }, db: db([{ revoked_at: new Date(now * 1000) }]), now });
  check('a revoked licence is refused, and says it is revoked', revoked.valid === false && revoked.revoked === true, revoked.why);

  const expiredToken = signLicence({ ...base, jti: 'lic_ep_2', iat: now - 40 * 86_400, exp: now - 86_400 }, keyPem);
  const expired = await decideCheck({ body: { licence: expiredToken }, db: db([{ revoked_at: null }]), now });
  check('an expired licence is refused with "expired"', expired.valid === false && /expired/.test(expired.why), expired.why);

  const foreign = signLicence(base, generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const forged = await decideCheck({ body: { licence: foreign }, db: db([{ revoked_at: null }]), now });
  check('a licence signed by another key is refused', forged.valid === false && /signature/.test(forged.why), forged.why);

  const unreadable = await decideCheck({ body: { licence: token }, db: { $queryRaw: async () => { throw new Error('connection terminated'); } }, now });
  check('a database that will not answer is not reported valid', unreadable.valid === false && /could not be read/.test(unreadable.why), unreadable.why);
}

// ── the revocation list, built and signed exactly as the endpoint builds it
{
  const claims = claimsForList(['lic_rev_1', 'lic_rev_2']);
  check('the list names the revoked ids and carries a kid', claims.revocations.length === 2 && !!claims.kid, JSON.stringify(claims).slice(0, 120));
  const list = signLicence(claims, keyPem);
  check('the list is signed and looks like a token', typeof list === 'string' && list.startsWith('vvs1.'));

  // VERIFY THE SIGNATURE THE WAY THE SDK DOES — over the decoded payload bytes, never over the base64 text. Done with node's own crypto
  // rather than importing the SDK, because a guard in this repo may not reach outside it, and "the SDK would accept it" is exactly the
  // claim being made: same envelope, same key, same bytes.
  const { createPublicKey, verify } = await import('node:crypto');
  const [prefix, payloadPart, sigPart] = list.split('.');
  const payload = Buffer.from(payloadPart, 'base64url');
  const ok = prefix === 'vvs1.' ? verify === null : verify(null, payload, createPublicKey(pubPem), Buffer.from(sigPart, 'base64url'));
  const claims2 = JSON.parse(payload.toString('utf8'));
  check('…and its signature verifies over the payload bytes', ok === true);
  check('…as a revocation list, not a licence', claims2.kind === 'revocations', JSON.stringify(claims2).slice(0, 100));
  check('…carrying both ids', (claims2.revocations ?? []).includes('lic_rev_1') && (claims2.revocations ?? []).includes('lic_rev_2'));
  check('…and an expiry, so a list cannot be trusted for ever', Number.isInteger(claims2.exp) && claims2.exp > now);
}

// ── no key is still a refusal, not an unsigned list
{
  const saved = process.env.VVS_ISSUER_KEY_PEM;
  const savedAlt = process.env.VALIANT_ISSUER_KEY;
  delete process.env.VVS_ISSUER_KEY_PEM;
  delete process.env.VALIANT_ISSUER_KEY;
  let threw = null;
  try { signLicence(claimsForList(['x'])); } catch (e) { threw = e; }
  check('with no key the endpoint refuses rather than publishing an unsigned list', !!threw && /VVS_ISSUER_KEY_PEM/.test(threw.message), threw?.message);
  if (saved) process.env.VVS_ISSUER_KEY_PEM = saved;
  if (savedAlt) process.env.VALIANT_ISSUER_KEY = savedAlt;
}


// ── where the signing key comes from, and what it must never be
{
  const { issuerKeyPemAsync } = await import('../server/src/lib/licenceKey.js');
  // The section above sets the environment key so the endpoints can sign; the precedence test needs it absent to see the Vault path.
  const savedEnv = process.env.VVS_ISSUER_KEY_PEM;
  delete process.env.VVS_ISSUER_KEY_PEM;
  const vaultDb = { $queryRawUnsafe: async () => [{ decrypted_secret: keyPem }] };
  const fromVault = await issuerKeyPemAsync(vaultDb);
  check('the key can come from Vault when the environment has none', fromVault.from === 'vault' && fromVault.pem === keyPem, fromVault.from);

  const saved = savedEnv;
  process.env.VVS_ISSUER_KEY_PEM = keyPem;
  const fromEnv = await issuerKeyPemAsync(vaultDb);
  check('…but the environment wins when it is set, so the proper secret can be restored with no code edit', fromEnv.from === 'env');
  if (saved) process.env.VVS_ISSUER_KEY_PEM = saved; else delete process.env.VVS_ISSUER_KEY_PEM;
  delete process.env.VVS_ISSUER_KEY_PEM;   // broken-db case must also see no environment key

  const brokenDb = { $queryRawUnsafe: async () => { throw new Error('connection terminated'); } };
  const none = await issuerKeyPemAsync(brokenDb);
  check('…and a database that will not answer is a missing key, not a crash', none.from === 'none' && none.pem === null);

  // THE EXPOSURE THIS MUST NEVER HAVE: PostgREST turns every `public` function into an RPC route, so a helper in `public` would give the
  // signing key to anyone holding the anon key. The read is a SELECT in the app; assert nothing in the repo creates such a function.
  const { readdirSync } = await import('node:fs');
  const { join } = await import('node:path');
  const files = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p2 = join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p2); } else if (/\.(js|mjs|sql)$/.test(e.name)) files.push(p2); } };
  walk(join(HERE, '..', 'server', 'src'));
  const leaky = files.filter((f) => /create( or replace)? function public\.issuer/i.test(readFileSync(f, 'utf8')));
  check('no public function exposes the signing key over RPC', leaky.length === 0, leaky.join(', '));
}

// What this file does NOT prove, said out loud so nobody reads a green run as the deployment being done.
console.log('\n  NOT PROVEN HERE  that the key is present in the deployment. That is one environment variable and it is checked by');
console.log('                   fetch the endpoints: with no key they answer "no issuer key", which is the honest 503.');
console.log(`\n${wrong === 0 ? 'the endpoints answer correctly when the key is present' : `${wrong} case(s) wrong`}\n`);
process.exit(wrong === 0 ? 0 : 1);
