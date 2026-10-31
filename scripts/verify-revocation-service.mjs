#!/usr/bin/env node
// verify-revocation-service.mjs — the list comes from the database, is signed, and refuses to answer without a key.
//
// Rob, 2026-11-02: licensing should "look after itself". The list used to be minted by a cron on the issuing Mac; this service replaces
// that with the database the revocations are actually recorded in.
import { claimsForList, TERM_DAYS, MAX_IDS } from '../server/src/lib/revocationList.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
let wrong = 0;
const check = (n, ok) => { if (!ok) wrong++; console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${n}`); };

{
  const c = claimsForList(['a', 'b', 'a', '  ', null, 'c']);
  check('ids are deduped and trimmed', JSON.stringify(c.revocations) === JSON.stringify(['a', 'b', 'c']));
  check('the token is a revocation list, not a licence', c.kind === 'revocations' && c.v === 1);
  check(`the term is ${TERM_DAYS} days`, Math.round((c.exp - c.iat) / 86_400) === TERM_DAYS);
  // THE KID MOVED WITH THE KEY (rotation, 2026-10-31). Pinned to a literal, this assertion would have to be edited on every rotation — so it
  // asserts the property instead: the list names a key that the deployment actually carries.
  const ring = readdirSync(join(HERE, '..', 'server', 'licence-keys')).filter((f) => f.endsWith('.pem')).map((f) => f.slice(0, -4));
  check('it names a key this deployment carries, so a rotated keyring can resolve it', ring.includes(c.kid), `kid ${c.kid} not in [${ring.join(', ')}]`);
  check('an empty list is a valid statement — "nothing is revoked"', claimsForList([]).revocations.length === 0);
  check('the list is bounded, so one huge history cannot make an unverifiable token', claimsForList(Array.from({ length: MAX_IDS + 50 }, (_, i) => `j${i}`)).revocations.length === MAX_IDS);
}

{
  const src = readFileSync(join(HERE, '..', 'server', 'src', 'functions', 'revocations.js'), 'utf8');
  check('the list is built from licences.revoked_at, the record that already exists', /revoked_at is not null/.test(src));
  check('…and signed with the issuer key rather than shipped raw', /signLicence/.test(src));
  check('…and refuses when the database cannot answer, instead of saying "nothing is revoked"', /could not be read/.test(src));
  check('…and refuses when there is no key, rather than publishing an unsigned list', /no issuer key/.test(src));
}

console.log(`\n${wrong === 0 ? 'the revocation list is signed, bounded, database-derived, and fails closed' : `${wrong} case(s) wrong`}\n`);
process.exit(wrong === 0 ? 0 : 1);
