// licenceVerify.js — verify a licence token against the public key the SDK also ships.
//
// The public half is committed in this repo as licence-public.pem (the same file the SDK verifies with), so a token this
// endpoint accepts is a token the SDK accepts. The private key never comes near this: verification only needs the public one.
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * THE KEYRING, so a rotation does not invalidate licences already sold. One directory, one file per kid, the same shape the SDK uses —
 * a licence naming a kid picks that key, and a licence naming a kid we do not carry is refused with "update the tool" rather than
 * "invalid signature", which is the message that saves a support round trip.
 *
 * The single committed `licence-public.pem` is still read as the fallback for a build with no keyring.
 */
function keyring() {
  const dir = join(HERE, '..', '..', 'licence-keys');
  const ring = {};
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.pem')) continue;
      try { ring[f.slice(0, -4)] = readFileSync(join(dir, f), 'utf8'); } catch { /* unreadable key is not a key */ }
    }
  } catch { /* no keyring */ }
  return ring;
}

function publicKey() {
  const fromEnv = process.env.VALIANT_LICENCE_PUBLIC_KEY;
  if (fromEnv) return fromEnv;
  const ring = keyring();
  if (Object.keys(ring).length) return ring;   // a map: verifyToken picks by kid
  // The PUBLIC key is committed: it is public by definition, and a check that depends on an environment variable is a check
  // that silently refuses every licence on a deployment where nobody set it.
  for (const rel of ['../../licence-public.pem']) {
    const p = join(HERE, rel);
    if (existsSync(p)) return readFileSync(p, 'utf8');
  }
  return null;
}

/**
 * @returns {{ok: boolean, why?: string, claims?: object}}
 */
export function verifyToken(token, now = Math.floor(Date.now() / 1000)) {
  const pem = publicKey();
  if (!pem) return { ok: false, why: 'no public key configured — the check cannot answer, and a licence must not be called valid without one' };
  const [prefix, payloadPart, sigPart] = String(token).split('.');
  if (prefix !== 'vvs1') return { ok: false, why: `unknown licence version "${prefix}"` };
  let claims;
  try { claims = JSON.parse(Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')); }
  catch { return { ok: false, why: 'the payload is not readable JSON' }; }
  const claimsKeyId = claims?.kid ?? null;
  // A map means a keyring: pick the key the licence names, and say so plainly when we do not carry it.
  let keyPem = pem;
  if (pem && typeof pem === 'object') {
    if (!claimsKeyId) return { ok: false, why: 'this check carries several signing keys but the licence names no key id' };
    keyPem = pem[claimsKeyId];
    if (!keyPem) return { ok: false, why: `licence was signed with key "${claimsKeyId}", which this deployment does not carry — update the tool` };
  }
  const key = createPublicKey(keyPem);
  // THE ISSUER SIGNS THE DECODED PAYLOAD BYTES, not the base64 text (`signLicence` in licenceKey.js decodes before signing).
  // Verifying the string instead of its bytes made every real licence look forged — measured, not reasoned about.
  const payloadBytes = Buffer.from(payloadPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const good = verify(null, payloadBytes, key, Buffer.from(sigPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
  if (!good) return { ok: false, why: 'the signature does not match — the token was edited or came from another issuer' };
  if (Number.isInteger(claims.exp) && now > claims.exp) {
    return { ok: false, why: `licence expired ${Math.round((now - claims.exp) / 86400)} day(s) ago`, claims };
  }
  return { ok: true, claims };
}
