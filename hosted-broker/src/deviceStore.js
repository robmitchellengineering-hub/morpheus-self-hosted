// Pending GitHub device-flow authorizations, keyed by an opaque ref the
// broker hands to the instance. Each entry holds the real GitHub
// `device_code` (minted with the broker's own client_id, so the instance
// can't poll GitHub for it directly) until the user approves it or it
// expires. Device codes live ~15 min GitHub-side, so the TTL matches.
//
// In-memory + single process, same as exchangeStore.js — fine for one
// broker replica. Swap for Redis with this same interface to scale the
// broker horizontally.
import crypto from 'crypto';

const store = new Map();
const TTL_MS = 16 * 60 * 1000;

export function put(value) {
  const ref = crypto.randomBytes(24).toString('base64url');
  store.set(ref, { value, expires: Date.now() + TTL_MS });
  return ref;
}

export function get(ref) {
  const entry = store.get(ref);
  if (!entry || entry.expires < Date.now()) {
    store.delete(ref);
    return null;
  }
  return entry.value;
}

export function drop(ref) {
  store.delete(ref);
}

setInterval(() => {
  const now = Date.now();
  for (const [ref, entry] of store) {
    if (entry.expires < now) store.delete(ref);
  }
}, 60 * 1000).unref();
