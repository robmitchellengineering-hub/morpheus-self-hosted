// "Morpheus Cloud defaults" — the fallback tier used when THIS deployment's
// operator hasn't configured their own connector credentials.
//
// Every connector in this app resolves in the same three tiers, poorest to
// best-scoped:
//   1. Per-account override   (UserSettings row — AI/TTS only, see ai.js)
//   2. This deployment's env  (server/.env — GITHUB_CLIENT_ID, LLM_API_KEY, ...)
//   3. Morpheus Cloud default (this file — a shared broker/gateway operated
//      by the Morpheus project so a fresh self-host works out of the box
//      with zero API keys, then graduates to the operator's own credentials
//      whenever they're ready)
//
// MORPHEUS_BROKER_URL points at a deployment of `hosted-broker/` (see that
// directory's README) — a small, separate service that holds the *shared*
// OAuth app secrets and upstream AI key so this repo never needs to. Set it
// once; every connector below falls back to it automatically. Leave it
// unset (or point it at your own broker deployment) to disable cloud
// defaults entirely and require operator-supplied credentials everywhere.
//
// The placeholder below is not a live service — replace it via the
// MORPHEUS_BROKER_URL env var once a broker is actually deployed (see
// hosted-broker/README.md for deploy steps). Until then, every fallback in
// this file is inert and connectors simply require local configuration.
const DEFAULT_BROKER_URL = 'https://broker.morpheus.invalid';

export function brokerUrl() {
  const url = process.env.MORPHEUS_BROKER_URL;
  if (!url || url === DEFAULT_BROKER_URL) return null; // unconfigured = feature disabled, not "use the placeholder"
  return url.replace(/\/+$/, '');
}

export function brokerConfigured() {
  return Boolean(brokerUrl());
}

// AI gateway: reuses the broker host by default (one service, several
// routes) but can be pointed at a dedicated gateway via MORPHEUS_AI_GATEWAY_URL
// if the operator wants to split them.
//
// TWO WAYS TO AUTHENTICATE, and which one applies decides whether the default is actually billed:
//
//   * MORPHEUS_AI_GATEWAY_TOKEN — the original shared deployment token. It identifies a DEPLOYMENT,
//     so the gateway cannot tell whose account is spending. That is the unmetered stopgap the
//     broker's README calls one.
//   * no static token, but this deployment has its own broker signing secret — a token is minted FOR
//     THE ACCOUNT MAKING THE CALL, from this server's own POST /api/broker/token, and cached until
//     shortly before it expires. This is what makes the paid default paid: the gateway resolves the
//     token to an account and reserves that account's credits before the call runs.
//
// The second is preferred when available, which is why ai.js's tier-3 branch no longer requires a
// static key to be present.
const GATEWAY_TOKEN_SKEW_MS = 60 * 60 * 1000; // re-mint an hour before expiry rather than mid-call
const gatewayTokenCache = new Map(); // userId -> { token, expiresAtMs }

/** The instance calling ITSELF over loopback, which is where a gateway token is minted. */
function localOrigin() {
  const port = process.env.PORT || 4000;
  return process.env.MORPHEUS_SELF_URL || `http://127.0.0.1:${port}`;
}

export function accountGatewayTokensAvailable() {
  return Boolean(process.env.BROKER_GATEWAY_SIGNING_SECRET);
}

/**
 * A gateway token for this account, minted by this deployment and cached until it is nearly expired.
 * Throws when it cannot be obtained — an unmetered call is not an acceptable fallback for a billed
 * gateway, so the caller must fail rather than send a call the broker will refuse anyway.
 */
export async function gatewayTokenForAccount(userId) {
  if (!userId) throw new Error('the Morpheus Cloud gateway bills an account, and this call named none');
  const cached = gatewayTokenCache.get(userId);
  if (cached && cached.expiresAtMs - GATEWAY_TOKEN_SKEW_MS > Date.now()) return cached.token;
  // Bounded, because this lives for the process's lifetime: drop entries that are past expiry, so a
  // long-running deployment accumulates expiring tokens rather than accounts.
  if (gatewayTokenCache.size > 500) {
    const now = Date.now();
    for (const [id, entry] of gatewayTokenCache) if (entry.expiresAtMs < now) gatewayTokenCache.delete(id);
  }

  const res = await fetch(`${localOrigin()}/api/broker/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ accountId: userId }),
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok || !payload?.token) {
    throw new Error(`could not mint a Morpheus Cloud gateway token: ${payload?.error || `HTTP ${res.status}`}`);
  }
  gatewayTokenCache.set(userId, { token: payload.token, expiresAtMs: new Date(payload.expiresAt).getTime() });
  return payload.token;
}

export function aiGatewayDefault() {
  const dedicated = process.env.MORPHEUS_AI_GATEWAY_URL;
  const base = dedicated || brokerUrl();
  if (!base) return null;
  const minted = accountGatewayTokensAvailable();
  return {
    baseUrl: `${base.replace(/\/+$/, '')}/v1`,
    // A per-deployment identifier, NOT a real upstream API key — the gateway maps this to its own
    // metered upstream key server-side. Set it only for the unmetered stopgap; with a signing secret
    // configured this is null and the token is minted per account instead.
    apiKey: process.env.MORPHEUS_AI_GATEWAY_TOKEN || null,
    metered: minted,
    mintForAccount: minted ? gatewayTokenForAccount : null,
  };
}
