// licenceCheckShape.js — what the online licence check accepts, with no database and no crypto near it.
//
// Rob, 2026-11-02: "licence verification needs to be done online". The SDK now asks this deployment whether a licence is still
// good, which means a public endpoint that takes a token from anyone. So the parsing is bounded and total: one string, a shape
// we recognise, and a refusal that names the reason. Keeping it dependency-free lets the guard that proves it run in the
// no-install job.
export const PREFIX = "vvs1.";
export const MAX_TOKEN = 8192;

const b64urlToText = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

/** @returns {{ok: boolean, why?: string, token?: string}} */
export function normalizeCheckBody(body) {
  const token = typeof body?.licence === "string" ? body.licence.trim() : "";
  if (!token) return { ok: false, why: "no licence given" };
  if (token.length > MAX_TOKEN) return { ok: false, why: `licence longer than ${MAX_TOKEN} bytes` };
  if (!token.startsWith(PREFIX)) return { ok: false, why: `not a licence: expected ${PREFIX}<payload>.<signature>` };
  if (token.split(".").length !== 3) return { ok: false, why: "not a licence: expected three dot-separated parts" };
  return { ok: true, token };
}

/** The claims, read WITHOUT trusting them — the caller must verify the signature before acting on any of this. */
export function peekClaims(token) {
  try {
    const c = JSON.parse(b64urlToText(String(token).split(".")[1]));
    return { ok: true, claims: c };
  } catch { return { ok: false, why: "the licence payload is not readable JSON" }; }
}

/** What the SDK is told. Deliberately small: enough to refuse, and enough to say why. */
export function checkReply({ valid, claims = null, revoked = false, why = null }) {
  return {
    v: 1,
    valid: !!valid,
    revoked: !!revoked,
    ...(why ? { why } : {}),
    ...(claims ? { jti: claims.jti ?? null, plan: claims.plan ?? null, seats: claims.seats ?? null, runners: claims.runners ?? null, exp: claims.exp ?? null } : {}),
  };
}
