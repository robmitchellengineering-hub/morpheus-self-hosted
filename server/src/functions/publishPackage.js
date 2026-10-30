// publishPackage.js — put a build on OUR domain, so distribution needs nobody's registry (Rob, 2026-11-02: "build it").
//
// ADMIN ONLY. Publishing is the one action in this product that is effectively irreversible — a version that exists can be fetched
// forever — so it takes an account with admin rights, and a version that already exists is refused rather than overwritten.
import { prisma } from '../db.js';
import { normalizePublish } from '../lib/packageShape.js';
import { mayPublish } from '../lib/publishAuth.js';

export default async function publishPackage({ user, body, req }) {
  // Admin session OR the release token: a build pushes a release, not a person clicking.
  if (!mayPublish({ user, req })) return { ok: false, error: 'publishing needs an admin session or the release token' };
  const shape = normalizePublish(body);
  if (!shape.ok) return { ok: false, error: shape.why };
  const { name, version, bytes, sha256, size, notes } = shape.pkg;

  // A PUBLISHED VERSION IS IMMUTABLE. npm learned this the hard way; a customer who pinned 0.3.0 must get 0.3.0 or an error, never
  // a different build wearing the same number.
  const existing = await prisma.$queryRaw`
    select version from packages where name = ${name} and version = ${version} limit 1`;
  if (existing?.length) {
    return { ok: false, error: `${name}@${version} already exists — publishing a new build over a version would make every pin a lie. Bump the version.` };
  }

  await prisma.$executeRaw`
    insert into packages (name, version, sha256, size, notes, published_by, bytes)
    values (${name}, ${version}, ${sha256}, ${size}, ${notes}, ${user?.id ?? 'release-token'}, ${bytes})`;
  return { ok: true, name, version, sha256, size };
}
