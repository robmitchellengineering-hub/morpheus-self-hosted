// Licence signing — the issuer's half, server-side.
//
// The SDK verifies a licence entirely offline with an Ed25519 public key that ships in the package.
// This is the other half: claims in, a `vvs1.<payload>.<signature>` token out. It is deliberately a
// pure module with no database and no HTTP, so it can be proven without a running server — the row
// storage and the endpoint that calls it are separate, and both are easy; the signature is the part
// where a mistake ships a licence nobody can verify.
//
// THE KEY. `VVS_ISSUER_KEY_PEM` — an Ed25519 private key in PKCS#8 PEM. It is NOT in the repo and must
// never be: whoever holds it can mint licences, and the matching public half is baked into the SDK.
// Absent key = refusal, never a fallback to a throwaway key, because a licence signed by a key the
// shipped build does not carry looks issued and verifies nowhere.
import { createPrivateKey, sign, randomBytes } from "node:crypto";

export const PLANS = { solo: 1, team: 5 };

/** The claims an SDK build reads. Keep this shape in step with `licence-public.pem`'s verifier. */
export function buildClaims({ accountId, plan, seats, days, kid = "vvs-2026-10", now = Date.now() }) {
  if (!accountId || typeof accountId !== "string") throw Object.assign(new Error("accountId required"), { status: 400 });
  if (!(plan in PLANS)) throw Object.assign(new Error(`unknown plan "${plan}" — one of ${Object.keys(PLANS).join(", ")}`), { status: 400 });
  const n = Number(days);
  if (!Number.isFinite(n) || n <= 0) throw Object.assign(new Error("days must be a positive number"), { status: 400 });
  const seatCount = Number.isFinite(Number(seats)) && Number(seats) > 0 ? Number(seats) : PLANS[plan];
  const iat = Math.floor(now / 1000);
  return {
    v: 1,
    sub: accountId,
    plan,
    seats: seatCount,
    iat,
    exp: iat + Math.round(n * 86400),
    kid,
    jti: `lic_${randomBytes(6).toString("hex")}`,
  };
}

const b64url = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Sign claims into a licence token. Throws when the key is absent or unusable. */
// TWO NAMES HAVE BEEN USED FOR THE SAME SECRET, and that is how a deployment ends up with "no issuer key" while somebody is certain
// they set it. `VVS_ISSUER_KEY_PEM` is the documented name; `VALIANT_ISSUER_KEY` is what the Stripe webhook reads. Both are accepted
// here so that setting either one is enough — a licence must not fail to sign because of a spelling.
export const ISSUER_KEY_ENV = 'VVS_ISSUER_KEY_PEM';

export function issuerKeyPem() {
  return process.env.VVS_ISSUER_KEY_PEM || process.env.VALIANT_ISSUER_KEY || null;
}

export function signLicence(claims, privateKeyPem = issuerKeyPem()) {
  if (!privateKeyPem) {
    throw Object.assign(
      new Error("No licence signing key on this deployment — set VVS_ISSUER_KEY_PEM (or VALIANT_ISSUER_KEY). A licence signed by a throwaway key would verify nowhere."),
      { status: 503 },
    );
  }
  const key = createPrivateKey(privateKeyPem);
  const payloadPart = b64url(Buffer.from(JSON.stringify(claims), "utf8"));
  const sig = sign(null, Buffer.from(payloadPart.replace(/-/g, "+").replace(/_/g, "/"), "base64"), key);
  return `vvs1.${payloadPart}.${b64url(sig)}`;
}

/**
 * Rebuild the exact claims a stored Licence row represents, so its token can be re-derived on demand.
 *
 * WHY THIS EXISTS. `buildClaims()` MINTS a new jti and a new expiry — correct when issuing, catastrophic when
 * returning an existing licence, because the caller would receive a token that does not match the row it is
 * recorded against (a new jti that revoking the row would not touch). Found by reading the signature instead
 * of assuming it: buildClaims ignores jti/iat/exp entirely.
 */
export function claimsFromRow(row) {
  return {
    v: 1,
    sub: row.created_by_id,
    plan: row.plan,
    seats: row.seats,
    iat: Math.floor(new Date(row.issued_at).getTime() / 1000),
    exp: Math.floor(new Date(row.expires_at).getTime() / 1000),
    kid: row.kid,
    jti: row.jti,
  };
}

/**
 * WHAT THE DEPLOYMENT ACTUALLY HAS, without printing it. "No issuer key" and "a key that cannot be parsed" are different faults with
 * different fixes, and an endpoint that reports the first for both sends somebody to check a variable that is already set (Rob,
 * 2026-11-02: "that was done we have that api and the key").
 *
 * The public-key fingerprint is safe to report: the public half ships in the SDK, so it is not a secret — and it answers the question
 * that matters, "is production signing with the key our customers verify against?".
 */
export function issuerKeyStatus() {
  const sources = [
    ['VVS_ISSUER_KEY_PEM', process.env.VVS_ISSUER_KEY_PEM],
    ['VALIANT_ISSUER_KEY', process.env.VALIANT_ISSUER_KEY],
  ];
  const found = sources.find(([, v]) => v && String(v).trim());
  if (!found) return { configured: false, source: null, parses: false, fingerprint: null };
  const [source, value] = found;
  try {
    const key = createPrivateKey(String(value));
    const pub = createPublicKey(key).export({ type: 'spki', format: 'pem' });
    const fingerprint = createHash('sha256').update(String(pub).trim()).digest('hex').slice(0, 16);
    return { configured: true, source, parses: true, fingerprint };
  } catch (e) {
    // Named, not printed: a PEM pasted with literal \n is the commonest form of this fault, and it is worth saying so.
    const hint = String(value).includes('\\n') ? 'the value contains a literal \\n — paste the PEM with real newlines' : e.message;
    return { configured: true, source, parses: false, fingerprint: null, why: hint };
  }
}
