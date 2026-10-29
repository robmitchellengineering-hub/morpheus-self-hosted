#!/usr/bin/env node
// export-revocations.mjs — print the licences this issuer has revoked, for the published list.
//
// WHY THIS EXISTS. A revocation is recorded in this database (`revoked_at`), and the licence that customers fetch is published
// from a file on the issuing Mac. Those were two records of the same fact that could disagree: revoke in the admin page and
// the published list stayed stale until someone copied the id across by hand.
//
// This prints the database's answer as JSON so the Mac can pull it before publishing. It is READ ONLY — nothing here can
// revoke or un-revoke anything.
//
//   node scripts/export-revocations.mjs          # {"revocations":[…],"count":n,"at":"…"}
//   node scripts/export-revocations.mjs --pretty
//
// exit 0 printed · 2 could not read the database (NOT VERIFIED — never an empty list, which would look like "nothing revoked")
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, '..', 'server');
const ENV = join(SERVER, '.env.prodsql');

const fail = (why) => { console.error(`export-revocations: ${why}`); process.exit(2); };

if (!existsSync(ENV)) fail(`no credential at ${ENV} — the list cannot be read, and an empty list would be a lie`);
process.loadEnvFile(ENV);
if (!process.env.PROD_DATABASE_URL) fail('SERVER/.env.prodsql has no PROD_DATABASE_URL');

const { PrismaClient } = await import(join(SERVER, 'node_modules/@prisma/client/default.js'));
const prisma = new PrismaClient({ datasources: { db: { url: process.env.PROD_DATABASE_URL } }, log: ['error'] });

try {
  const rows = await prisma.$queryRawUnsafe(
    'select jti, revoked_at from licences where revoked_at is not null order by revoked_at desc limit 500'
  );
  const out = {
    revocations: rows.map((r) => r.jti).filter(Boolean),
    count: rows.length,
    at: new Date().toISOString(),
    source: 'morpheus licences.revoked_at',
  };
  console.log(process.argv.includes('--pretty') ? JSON.stringify(out, null, 2) : JSON.stringify(out));
} catch (e) {
  fail(`could not read the licences table: ${String(e.message).split('\n')[0].slice(0, 140)}`);
} finally {
  await prisma.$disconnect().catch(() => {});
}
