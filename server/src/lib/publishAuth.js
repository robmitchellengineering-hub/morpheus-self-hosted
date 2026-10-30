// publishAuth.js — who may publish a package, kept in one place so "admin or the release token" cannot drift between the route and
// the handler.
//
// WHY A MACHINE TOKEN AND NOT ONLY A SESSION. A release is pushed by a build, not by a person clicking, and asking a human to fetch a
// session cookie into a terminal is how credentials end up in shell history. The token is compared in constant time and only when it
// is configured: an unset VALIANT_PUBLISH_TOKEN must never mean "empty token accepted".
import { timingSafeEqual } from 'node:crypto';

const tokenOf = (req) => {
  const h = req?.headers?.authorization ?? '';
  return String(h).startsWith('Bearer ') ? String(h).slice(7).trim() : '';
};

/** @returns {boolean} */
export function mayPublish({ user, req } = {}) {
  if (user?.role === 'admin') return true;
  const configured = process.env.VALIANT_PUBLISH_TOKEN;
  if (!configured) return false;                    // NOT configured is not "no auth needed"
  const given = tokenOf(req);
  if (!given) return false;
  const a = Buffer.from(configured);
  const b = Buffer.from(given);
  // Length first: timingSafeEqual throws on a length mismatch, and throwing here would be a 500 for a wrong guess.
  return a.length === b.length && timingSafeEqual(a, b);
}
