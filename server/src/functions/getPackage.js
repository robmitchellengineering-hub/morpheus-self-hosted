// getPackage.js — fetch one tarball by name and version, for `npm install -g <url>`.
//
// PUBLIC: the tarball is not secret (the licence gates its use, not its download), and requiring an account here would put a login
// between a customer and the build they paid for. The checksum is the integrity check, and the SDK's own release gate compares it.
import { prisma } from '../db.js';
import { NAME, VERSION } from '../lib/packageShape.js';

export default async function getPackage({ body, query, res }) {
  // GET OR POST. `npm install -g <url>` issues a GET and cannot send a body, so the query is the primary source; the body stays
  // supported for callers that already send JSON. A fetch-only-POST endpoint is unusable as a package URL — which is what the first
  // `npm install` from this registry proved, with TAR_BAD_ARCHIVE over a JSON error page.
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
