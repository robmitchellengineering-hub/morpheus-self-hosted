// The user's connected-service credentials: stored ENCRYPTED, read through here.
//
// 2026-09-28 — this closes a false promise. `user_settings.connections` holds third-party provider
// credentials (hosting tokens, database URLs, API keys), and `schema.prisma` describes the column as
// "hosting platform credentials, encrypted at rest" — while the Connections UI promises the user the
// same thing. Neither was true: the column was written and read as plain JSON (`photoDrive.js` wrote
// it directly; every reader did `JSON.parse(settings.connections)`). It matters most now that the
// product asks people to paste a hosting token into exactly this field, on the principle that it is
// always the customer's own connection — a principle that only holds if we are honest about what we
// do with their credential.
//
// WHY THERE IS NO MIGRATION HERE, and do not add one: `crypto.js`'s `decrypt()` returns its input
// unchanged when it does not start with the `v1:` marker, and it writes that marker itself. So every
// existing plaintext row keeps decoding to the same object, and each row becomes encrypted the next
// time it is written. Read that guarantee in server/src/crypto.js before changing anything here.
import { decrypt, encrypt } from '../crypto.js';

// One place that decides how the column is shaped, so a reader and a writer cannot disagree about
// it — and so "is it encrypted?" has a single answer.
export function encodeConnections(value) {
  if (value == null) return null;
  // Already stored: writing it back must not wrap ciphertext in a second layer, which would decode
  // to a garbage string and look like a corrupted connection set.
  if (typeof value === 'string' && value.startsWith('v1:')) return value;
  return encrypt(typeof value === 'string' ? value : JSON.stringify(value));
}

// Decoding must never be the reason a page fails to load. It tolerates, in order of how they occur
// in real data:
//   - null / empty        → the user has connected nothing yet (the normal case for a new account)
//   - a legacy plaintext  → rows written before this change; decrypt() passes them through
//   - an encrypted value  → the normal case from now on
//   - malformed JSON      → a hand-edited or truncated row
//   - a failed auth tag   → ENCRYPTION_KEY rotated or the value corrupted; decrypt() throws
// The last two return {} rather than throwing, and the caller is expected to say "not connected"
// — which is true, and is the honest degradation. A thrown error here would take down Settings and
// every page that reads a credential.
export function decodeConnections(stored) {
  if (!stored) return {};
  let json = null;
  try {
    json = decrypt(stored);
  } catch {
    return {};
  }
  if (!json) return {};
  try {
    const parsed = typeof json === 'string' ? JSON.parse(json) : json;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The URL of the operator's deployed Netlify site, or ''.
 *
 * 2026-09-28: added for the provider-setup guide. Mode B of that guide tells the
 * operator to register the app's origin in the Google console, and a guide whose
 * origin line reads "(open the app and copy the address bar)" when we already know
 * the URL is a worse guide than it has to be. One function because two callers need
 * it — the compile panel and the build's README write — and a second `?.netlify?.url`
 * spelled out at each is how the two drift.
 *
 * Takes the DECODED connections object, not the stored column: decrypting is
 * `decodeConnections`'s job, and a helper that silently did it too would make it
 * impossible to tell whether a caller had already decoded.
 */
export function netlifyOrigin(connections) {
  const value = connections?.netlify?.url;
  if (typeof value !== 'string') return '';
  const url = value.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) return '';
  // The origin ONLY — Google's console wants scheme + host, and a path or query
  // there is one of the ways "Authorised JavaScript origins" silently does not match.
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

