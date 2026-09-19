// Runtime verification for the production migration guard.
//
// Dependency-free, so it runs in CI's no-install guards job alongside
// verify-drift.mjs. Run:  node scripts/verify-prod-sql.mjs
//
// This guards a script that holds production credentials, so the assertions
// matter more than usual: a guard that lets a DROP through is worse than no
// script, because it makes the operator stop checking by hand.
import { describeDatabaseUrl, isLocalDatabaseUrl, parseDatabaseUrl, reviewSql } from '../server/src/lib/prodSqlGuard.js';
import { readFileSync } from 'node:fs';

let failures = 0;
let checks = 0;

function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

const PROD = 'postgresql://postgres.abcdefgh:pw@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres';

console.log('\nProduction migration guard — runtime verification\n');

console.log('1. additive DDL is allowed');
check('ADD COLUMN IF NOT EXISTS', reviewSql('ALTER TABLE projects ADD COLUMN IF NOT EXISTS synced_commit TEXT;').ok, true);
check('CREATE TABLE IF NOT EXISTS', reviewSql('CREATE TABLE IF NOT EXISTS thing (id text primary key);').ok, true);
check('CREATE INDEX IF NOT EXISTS', reviewSql('CREATE INDEX IF NOT EXISTS ix ON projects (name);').ok, true);
check('COMMENT ON', reviewSql('COMMENT ON COLUMN projects.name IS \'x\';').ok, true);
check('a multi-statement additive migration is allowed',
  reviewSql('ALTER TABLE a ADD COLUMN IF NOT EXISTS x TEXT;\nALTER TABLE b ADD COLUMN IF NOT EXISTS y TEXT;').ok, true);

console.log('\n2. anything destructive is refused — the whole point of the guard');
for (const [label, sql] of [
  ['DROP TABLE', 'DROP TABLE projects;'],
  ['DROP COLUMN', 'ALTER TABLE projects DROP COLUMN synced_commit;'],
  ['TRUNCATE', 'TRUNCATE projects;'],
  ['DELETE', 'DELETE FROM projects;'],
  ['UPDATE (a silent data rewrite)', 'UPDATE projects SET name = \'x\';'],
  ['INSERT', 'INSERT INTO projects (id) VALUES (\'1\');'],
  ['ALTER COLUMN TYPE', 'ALTER TABLE projects ALTER COLUMN name TYPE varchar(10);'],
  ['RENAME', 'ALTER TABLE projects RENAME TO projects_old;'],
]) {
  const r = reviewSql(sql);
  check(`${label} -> refused`, r.ok, false);
  check(`${label} -> named as the offender`, r.riskyStatements.length >= 1, true);
}

console.log('\n3. one bad statement poisons the whole file, not just itself');
const mixed = reviewSql('ALTER TABLE projects ADD COLUMN IF NOT EXISTS ok_col TEXT;\nDROP TABLE projects;');
check('mixed additive + destructive -> refused outright', mixed.ok, false);
check('and the additive statement is not offered as safe to run', mixed.riskyStatements.length, 1);

console.log('\n4. comments do not smuggle a statement past the allowlist');
check('a commented-out DROP is not executed',
  reviewSql('-- DROP TABLE projects;\nALTER TABLE projects ADD COLUMN IF NOT EXISTS x TEXT;').ok, true);
check('a comment cannot hide a real DROP',
  reviewSql('ALTER TABLE projects ADD COLUMN IF NOT EXISTS x TEXT;\n-- harmless\nDROP TABLE projects;').ok, false);

console.log('\n5. nothing-to-run is refused rather than reported as success');
check('empty string', reviewSql('').ok, false);
check('comments only', reviewSql('-- just a note\n').ok, false);
check('and it says why', reviewSql('').reason, 'the file contains no statements');

console.log('\n6. a local target is refused — wrong-paste protection');
for (const host of ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal']) {
  check(`${host} is local`, isLocalDatabaseUrl(`postgresql://u:p@${host}:5432/morpheus`), true);
}
// The obvious spellings are not the only ones — a guard that misses these gives
// false confidence, which is worse than having no guard at all.
check('127.0.0.2 is loopback too (all of 127.0.0.0/8 is)', isLocalDatabaseUrl('postgresql://u:p@127.0.0.2:5432/db'), true);
check('127.255.255.254 is loopback', isLocalDatabaseUrl('postgresql://u:p@127.255.255.254:5432/db'), true);
check('IPv6 loopback in brackets', isLocalDatabaseUrl('postgresql://u:p@[::1]:5432/db'), true);
check('IPv6 loopback, fully expanded', isLocalDatabaseUrl('postgresql://u:p@[0:0:0:0:0:0:0:1]:5432/db'), true);
check('a .localhost name', isLocalDatabaseUrl('postgresql://u:p@db.localhost:5432/db'), true);
check('an mDNS .local name (same LAN)', isLocalDatabaseUrl('postgresql://u:p@mac.local:5432/db'), true);
check('128.0.0.1 is NOT loopback', isLocalDatabaseUrl('postgresql://u:p@128.0.0.1:5432/db'), false);
check('a Supabase pooler host is not local', isLocalDatabaseUrl(PROD), false);
check('the dev DATABASE_URL from server/.env would be refused', isLocalDatabaseUrl('postgresql://morpheus:pw@localhost:5433/morpheus?schema=public'), true);

console.log('\n7. an unparseable URL is refused, not guessed at');
check('garbage', parseDatabaseUrl('not a url'), null);
check('an unencoded # in the password', parseDatabaseUrl('postgresql://u:pa#ss@host:5432/db'), null);
check('empty', parseDatabaseUrl(''), null);
check('a non-postgres scheme', parseDatabaseUrl('mysql://u:p@host:3306/db'), null);
check('and an unparseable URL is not reported as local',
  isLocalDatabaseUrl('not a url'), false);

console.log('\n8. the URL is parsed and the password is never printed');
check('host/port/db/user extracted', parseDatabaseUrl(PROD),
  { host: 'aws-0-ap-southeast-2.pooler.supabase.com', port: '5432', database: 'postgres', user: 'postgres.abcdefgh' });
check('described without the password', describeDatabaseUrl(PROD),
  'postgres.abcdefgh@aws-0-ap-southeast-2.pooler.supabase.com:5432/postgres');
check('the description never contains the password', describeDatabaseUrl(PROD).includes('pw'), false);
check('a default port is filled in', parseDatabaseUrl('postgresql://u:p@host/db').port, '5432');

console.log('\n9. the runner cannot be pointed at the dev database by accident');
const runnerSrc = readFileSync(new URL('../server/scripts/prod-sql.mjs', import.meta.url), 'utf8');
check('it refuses a local target', /isLocalDatabaseUrl\(url\)/.test(runnerSrc), true);
check('it refuses an unparseable URL', /parseDatabaseUrl\(url\)/.test(runnerSrc), true);
check('it requires the additive review before connecting', /if \(!review\.ok\)/.test(runnerSrc), true);
check('it reads its own env file, NOT server/.env (which npm run dev loads)',
  /\.env\.prodsql/.test(runnerSrc) && !/loadEnvFile\([^)]*['"]\.env['"]/.test(runnerSrc), true);
check('it supports --dry-run', /dryRun/.test(runnerSrc), true);

console.log('\n10. the credential file is gitignored — asserted, not assumed');
check('server/.env.prodsql is covered by .gitignore',
  /^\.env\.\*$/m.test(readFileSync(new URL('../.gitignore', import.meta.url), 'utf8')), true);

// The data-repair channel exists because the additive-only rule had no way to
// repair DATA, only schema — which is what left a billing bug's -3.77 row
// stranded. It must stay NARROW: the whole risk is that "allow data repairs"
// quietly becomes "allow anything".
console.log('\n11. the data-repair channel is narrow and opt-in');
const write = 'UPDATE users SET credit_balance = 0 WHERE credit_balance < 0;';
check('without the flag a bounded UPDATE is still refused', reviewSql(write).ok, false);
check('and the refusal names the flag that would allow it', /--data-repair/.test(reviewSql(write).reason || ''), true);
check('with the flag a bounded UPDATE is allowed', reviewSql(write, { allowDataRepair: true }).ok, true);
check('and it reports its mode', reviewSql(write, { allowDataRepair: true }).mode, 'data-repair');
check('a bounded DELETE is allowed too',
  reviewSql('DELETE FROM deck_dump_items WHERE created_date < \'2020-01-01\';', { allowDataRepair: true }).ok, true);

console.log('\n12. …and it refuses everything wider');
for (const [label, sql] of [
  ['an UPDATE with no WHERE (an unbounded write)', 'UPDATE users SET credit_balance = 0;'],
  ['a DELETE with no WHERE', 'DELETE FROM users;'],
  ['DROP TABLE', 'DROP TABLE users;'],
  ['TRUNCATE', 'TRUNCATE users;'],
  ['INSERT', "INSERT INTO users (id) VALUES ('x');"],
  ['ALTER TABLE ... DROP COLUMN', 'ALTER TABLE users DROP COLUMN credit_balance;'],
  ['a DROP smuggled after a valid repair', `${write}\nDROP TABLE users;`],
]) {
  check(`${label} -> refused even with the flag`, reviewSql(sql, { allowDataRepair: true }).ok, false);
}
check('an unbounded write is called out as such, not lumped in',
  /no WHERE clause/.test(reviewSql('UPDATE users SET credit_balance = 0;', { allowDataRepair: true }).reason || ''), true);
check('additive DDL still works with the flag on', reviewSql('ALTER TABLE projects ADD COLUMN IF NOT EXISTS x TEXT;', { allowDataRepair: true }).ok, true);
check('and additive DDL reports its own mode',
  reviewSql('ALTER TABLE projects ADD COLUMN IF NOT EXISTS x TEXT;', { allowDataRepair: true }).mode, 'additive');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`${failures} FAILED\n`);
  process.exit(1);
}
console.log('all good\n');
