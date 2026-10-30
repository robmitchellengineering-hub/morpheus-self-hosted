// listPackages.js — the public index: what exists, what is latest, and the checksum to verify.
//
// PUBLIC, because an installer must be able to ask "is there a newer one" without an account. It never returns the tarballs
// themselves, only their metadata — a listing is cheap and a megabyte per request is not.
import { prisma } from '../db.js';
import { buildIndex } from '../lib/packageShape.js';

export default async function listPackages() {
  const rows = await prisma.$queryRaw`
    select name, version, sha256, size, notes, published_at from packages order by published_at desc limit 500`;
  return { ok: true, ...buildIndex(rows ?? []) };
}
