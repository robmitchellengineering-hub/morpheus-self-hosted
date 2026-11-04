// vvsFeed.js — the signed corpus feed, served to a licence that includes it.
//
// WHY THIS ENDPOINT EXISTS. The feed used to be a file on the marketing site: `vvs.morpheus.nz/corpus/current.txt`,
// public, no auth. A $500 or $1,500 subscription therefore bought a URL anybody could read, and `claimLicence` handed
// the buyer exactly that URL. The feed the customer pays for has to be the thing the licence unlocks, or the tier is
// a price and a promise.
//
// THE ANSWER IS THE LICENCE, NOT THE ACCOUNT. There is no session here: the caller is the SDK on a machine that holds
// a licence file, exactly like `licenceCheck`. So the token IS the credential, and the checks are the same ones that
// endpoint makes — signature against the shipped keyring, expiry, and revocation read from the database (which fails
// closed: an unreadable revocation list must never be reported as "fine").
//
// IT VERIFIES THE TOKEN HERE RATHER THAN CALLING `decideCheck`, because that reply deliberately projects a licence down
// to jti/plan/seats/runners/exp — it has no `feed` field, so an endpoint asking `decideCheck` for the entitlement would
// refuse every corpus customer. The steps below are copied from it on purpose; if one changes, change both.
//
// WHAT A CALLER GETS BACK is the `vvc1.…` token, bytes unchanged. It is signed, so a caller can verify it offline with
// the same public key the SDK ships; this endpoint is a delivery mechanism, not a trust boundary. That is deliberate:
// a stored copy stays verifiable, and nobody has to trust this server's word for the feed's content.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prisma } from '../db.js';
import { verifyToken } from '../lib/licenceVerify.js';
import { lookupRevocation } from '../lib/licenceDecision.js';
import { normalizeCheckBody } from '../lib/licenceCheckShape.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FEED_PATH = process.env.VVS_FEED_PATH || join(HERE, '..', 'data', 'vvs-corpus.vvc');

/** The feed as published, or a refusal that names the file — never an empty body that reads as an empty feed. */
function publishedFeed() {
  try {
    const text = readFileSync(FEED_PATH, 'utf8').trim();
    if (!text.startsWith('vvc1.')) throw new Error(`${FEED_PATH} is not a signed feed (it does not start with vvc1.)`);
    return { ok: true, text };
  } catch (e) {
    return { ok: false, why: `the feed could not be read: ${e.message}` };
  }
}

export default async function vvsFeed({ body, now = Math.floor(Date.now() / 1000) }) {
  // Same shape the check endpoint takes: { licence } or { token }, so one client call shape serves both.
  const shape = normalizeCheckBody(body);
  if (!shape.ok) return { ok: false, status: 400, error: shape.why };

  const v = verifyToken(shape.token, now);
  if (!v.ok) return { ok: false, status: 401, error: v.why };

  let revoked;
  try {
    revoked = await lookupRevocation(v.claims?.jti, prisma);
  } catch {
    // Cannot check is not "fine" — the same rule the licence check follows.
    return { ok: false, status: 503, error: 'the revocation list could not be read — try again shortly' };
  }
  if (revoked) return { ok: false, status: 401, error: 'this licence has been revoked' };

  if (!v.claims?.feed) {
    // A valid SDK licence without the entitlement: the difference between "renew" and "upgrade" is the whole message.
    return {
      ok: false,
      status: 403,
      error: 'this licence does not include the corpus feed — the feed is the Corpus and Corpus — Enterprise tier',
    };
  }

  const feed = publishedFeed();
  if (!feed.ok) return { ok: false, status: 503, error: feed.why };

  return {
    ok: true,
    // The token, verbatim. The caller verifies it; storing it changes nothing about that.
    feed: feed.text,
    tier: v.claims.feed,
    issued: new Date().toISOString(),
  };
}
