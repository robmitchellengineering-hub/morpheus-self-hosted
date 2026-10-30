// getPackage.js — fetch one tarball by name and version, for `npm install -g <url>`.
//
// PUBLIC: the tarball is not secret (the licence gates its use, not its download), and requiring an account here would put a login
// between a customer and the build they paid for. The checksum is the integrity check, and the SDK's own release gate compares it.
import { prisma } from '../db.js';
import { NAME, VERSION } from '../lib/packageShape.js';

export default async function getPackage({ body, res }) {
  const name = String(body?.name ?? '').trim();
  const version = String(body?.version ?? '').trim();
  if (!NAME.test(name) || !VERSION.test(version)) {
    return { ok: false, error: 'name and version are required and must be valid' };
  }
  const rows = await prisma.$queryRaw`
    select name, version, bytes, sha256 from packages where name = ${name} and version = ${version} limit 1`;
  const row = rows?.[0];
  if (!row) return { ok: false, error: `${name}@${version} is not published here` };

  res.setHeader('content-type', 'application/octet-stream');
  res.setHeader('content-disposition', `attachment; filename="${row.name}-${row.version}.tgz"`);
  res.setHeader('x-checksum-sha256', row.sha256);
  res.setHeader('cache-control', 'public, max-age=31536000, immutable');
  res.end(Buffer.from(row.bytes));
  return undefined;   // the response is written; the dispatcher must not send JSON over it
}
