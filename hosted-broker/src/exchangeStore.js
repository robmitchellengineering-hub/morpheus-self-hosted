// One-time-code store for the OAuth broker handoff. A real access token
// never transits the browser: /github/callback and /google/callback stash
// {access_token, profile} here under a random one-time code and redirect
// the browser back to the instance with only that code; the instance's
// backend then redeems it server-to-server via /github/exchange or
// /google/exchange.
//
// In-memory + single process is fine for a single broker replica (a code
// only needs to survive ~seconds between redirect and redemption). If you
// horizontally scale the broker itself, swap this for Redis with the same
// interface — nothing else in server.js needs to change.
import crypto from 'crypto';

const store = new Map();
const TTL_MS = 2 * 60 * 1000;

export function put(value) {
  const code = crypto.randomBytes(24).toString('base64url');
  store.set(code, { value, expires: Date.now() + TTL_MS });
  return code;
}

export function take(code) {
  const entry = store.get(code);
  store.delete(code); // one-time use regardless of outcome
  if (!entry || entry.expires < Date.now()) return null;
  return entry.value;
}

// Sweep expired entries periodically so an abandoned flow doesn't leak.
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of store) {
    if (entry.expires < now) store.delete(code);
  }
}, 60 * 1000).unref();
