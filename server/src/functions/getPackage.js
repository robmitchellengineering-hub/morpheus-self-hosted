// getPackage.js — fetch one tarball by name and version, for `npm install -g <url>`.
//
// IT TAKES A LICENCE. This was public, on the argument that "the licence gates its use, not its download". That is a
// defensible position and it was the wrong one for this product: the download IS the thing a customer pays for, and a
// public tarball means a purchase buys nothing a visitor does not already have. (Rob, 2026-11-04: the download should be
// part of the process after purchasing, behind the account.)
//
// The licence is the credential, exactly as it is for `vvsFeed`: a `vvs1.…` token in the `licence` query parameter (npm
// cannot send a body on the GET it issues for a package URL). It is verified against the shipped keyring, unexpired, and
// not revoked — fail closed, and a refusal must be a sentence a customer can act on rather than TAR_BAD_ARCHIVE.
//
// THE CHECKSUM IS STILL THE INTEGRITY CHECK, and it is independent of this: a licence proves you may have the bytes, the
// sha256 proves they are the bytes.
import { prisma } from '../db.js';
import { NAME, VERSION } from '../lib/packageShape.js';
import { verifyToken } from '../lib/licenceVerify.js';
import { lookupRevocation } from '../lib/licenceDecision.js';

export default async function getPackage({ body, query, res }) {
  // GET OR POST. `npm install -g <url>` issues a GET and cannot send a body, so the query is the primary source; the body stays
  // supported for callers that already send JSON. A fetch-only-POST endpoint is unusable as a package URL — which is what the first
  // `npm install` from this registry proved, with TAR_BAD_ARCHIVE over a JSON error page.
  // THE LICENCE FIRST, before any work is done for the caller. A refusal here names what to do; `npm` shows the body.
  const licence = String(query?.licence ?? body?.licence ?? '').trim();
  if (!licence) {
    return {
      ok: false,
      error: 'a licence is required to download the SDK — sign in at https://morpheus.nz/licences (a free 14-day trial is issued there) and append &licence=<token>',
    };
  }
  const v = verifyToken(licence);
  if (!v.ok) return { ok: false, error: `this licence cannot be used: ${v.why} — get one at https://morpheus.nz/licences` };
  try {
    if (await lookupRevocation(v.claims?.jti, prisma)) return { ok: false, error: 'this licence has been revoked — get one at https://morpheus.nz/licences' };
  } catch {
    // Cannot check is not "fine".
    return { ok: false, error: 'the revocation list could not be read — try again shortly' };
  }

  const name = String(query?.name ?? body?.name ?? '').trim();
  const version = String(query?.version ?? body?.version ?? 'latest').trim();
  if (!NAME.test(name)) return { ok: false, error: 'name is required and must be valid' };
  // "latest" IS THE COMMAND A STRANGER ACTUALLY TYPES. It resolves to the newest published version — a self-service path that
  // requires knowing the current version number is not self-service, it is a changelog they have to read first.
  if (version !== 'latest' && !VERSION.test(version)) return { ok: false, error: 'version must be semver or "latest"' };

  const rows = version === 'latest'
    ? await prisma.$queryRaw`
        select name, version, bytes, sha256 from packages where name = ${name} order by published_at desc limit 1`
    : await prisma.$queryRaw`
        select name, version, bytes, sha256 from packages where name = ${name} and version = ${version} limit 1`;
  const row = rows?.[0];
  if (!row) return { ok: false, error: `${name}${version === 'latest' ? '' : '@' + version} is not published here` };

  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename="${row.name}-${row.version}.tgz"`);
  res.setHeader('x-checksum-sha256', row.sha256);
  // A MUTABLE URL MUST NOT BE CACHED AS IMMUTABLE. `version=latest` resolves to a different build tomorrow, so declaring it
  // immutable for a year makes a client keep the first answer — measured: after 0.3.1 was published, resolving `latest` installed
  // 0.3.0 straight from the client's own cache. A pinned version really is immutable and keeps the long cache.
  const pinned = version !== 'latest';
  res.setHeader('cache-control', pinned ? 'public, max-age=31536000, immutable' : 'no-store, must-revalidate');
  res.end(Buffer.from(row.bytes));
  return undefined;   // the response is written; the dispatcher must not send JSON over it
}
