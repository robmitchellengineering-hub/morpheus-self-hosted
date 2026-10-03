// Does a FRESH self-host get the same schema as a migrated one?
//
// WHY THIS EXISTS (recorded 2026-09-28, measured and fixed 2026-09-30). `server/prisma/manual-supabase-init.sql`
// is the bootstrap for a new self-hosted install. The `selfdev-*.sql` migrations were applied to production and
// **never mirrored into it**, so a fresh install came up missing SEVENTEEN columns and said nothing:
//
//   project_files.synced_sha · the CRM fields (#383) · the fee tiers (#394) · the usage-event observability
//   columns (task, status, duration_ms)
//
// Nothing broke loudly. Readers fall back to the pre-migration shape (hazard H11), so the features simply did
// not persist on a fresh install — which is exactly why nobody noticed. A new self-host is the *whole point*
// of the portable/self-hosted promise, and it was quietly coming up incomplete.
//
// The check is decidable from the files: every column a `selfdev-*.sql` migration adds must exist in the
// bootstrap, either in its CREATE TABLE body or in an ALTER of its own.
//
// Run:  node scripts/verify-bootstrap-sql.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PRISMA = join(ROOT, 'server/prisma');

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}
const read = (p) => readFileSync(p, 'utf8');

// Case-insensitive on purpose: the migrations that caused this defect are written in lowercase
// (`alter table x add column if not exists y`) while others use upper case. The first version of this
// prototype matched only upper case and cheerfully reported that two migrations added nothing at all.
const ALTER = /alter\s+table\s+"?([a-z_][a-z0-9_]*)"?\s+add\s+column(?:\s+if\s+not\s+exists)?\s+"?([a-z_][a-z0-9_]*)"?/gi;
const CREATE = /create\s+table(?:\s+if\s+not\s+exists)?\s+"?([a-z_][a-z0-9_]*)"?\s*\(([\s\S]*?)\n\);/gi;

/** [{file, table, column}] — every column a migration ADDS. Drops and renames are out of scope by design. */
export function columnsAddedBy(sql, file = '(inline)') {
  return [...String(sql || '').matchAll(ALTER)].map((m) => ({ file, table: m[1].toLowerCase(), column: m[2].toLowerCase() }));
}

/** Words that begin a table-level constraint rather than a column definition. */
const TABLE_KEYWORDS = new Set(['primary', 'foreign', 'unique', 'check', 'constraint', 'key', 'index', 'exclude']);

/** Set of "table.column" the bootstrap provides, whether from a CREATE TABLE body or an ALTER of its own. */
export function columnsInBootstrap(sql) {
  const known = new Set();
  for (const m of String(sql || '').matchAll(CREATE)) {
    const table = m[1].toLowerCase();
    // A column line is an identifier followed by a type. The keyword test has to be on the NAME, not after
    // it: written as `...\s+(?!primary|foreign|...)([a-z])` the regex looked at the SECOND word, so
    // `primary key (a)` matched with the column name "primary" — which the self-test below caught.
    for (const line of m[2].split('\n')) {
      const c = /^\s*"?([a-z_][a-z0-9_]*)"?\s+([a-z(])/i.exec(line);
      if (c && !TABLE_KEYWORDS.has(c[1].toLowerCase())) known.add(`${table}.${c[1].toLowerCase()}`);
    }
  }
  for (const m of String(sql || '').matchAll(ALTER)) known.add(`${m[1].toLowerCase()}.${m[2].toLowerCase()}`);
  return known;
}

/** What a fresh install would be missing. */
export function bootstrapGaps(migrations, bootstrapSql) {
  const known = columnsInBootstrap(bootstrapSql);
  const missing = [];
  for (const { file, table, column } of migrations) {
    if (!known.has(`${table}.${column}`)) missing.push({ file, table, column });
  }
  return missing;
}

const bootstrap = read(join(PRISMA, 'manual-supabase-init.sql'));
const files = readdirSync(PRISMA).filter((f) => /^selfdev-.*\.sql$/.test(f)).sort();
const migrations = files.flatMap((f) => columnsAddedBy(read(join(PRISMA, f)), f));

console.log(`\n1. a fresh self-host gets every column the migrations added (${files.length} migration(s), ${migrations.length} column(s))`);
check('the migrations were actually parsed', migrations.length > 0, true);
check('…and every one names a table and a column',
  migrations.filter((m) => !m.table || !m.column), []);
// The defect itself: a column a migration adds that the bootstrap does not have.
check('no column is missing from the bootstrap',
  bootstrapGaps(migrations, bootstrap).map((g) => `${g.table}.${g.column} (${g.file})`), []);
// The tables those migrations touch must exist at all, or the app fails on a fresh install rather than
// merely persisting nothing.
const bootstrapTables = new Set([...bootstrap.matchAll(CREATE)].map((m) => m[1].toLowerCase()));
check('…and every table they touch exists in the bootstrap',
  [...new Set(migrations.map((m) => m.table))].filter((t) => !bootstrapTables.has(t)), []);

console.log('\n2. the checker can actually fail — this is the half that is usually missing');
// Behavioural self-tests on synthetic input, because a parser that finds nothing reports no gaps, and
// "nothing missing" from a checker that looked at nothing is the failure this whole file is about (H17).
const ONE = 'alter table t add column if not exists a text;';
check('it parses a lowercase alter (the case that caused this defect)',
  columnsAddedBy(ONE), [{ file: '(inline)', table: 't', column: 'a' }]);
check('…an uppercase ALTER', columnsAddedBy('ALTER TABLE T ADD COLUMN IF NOT EXISTS B TEXT;'),
  [{ file: '(inline)', table: 't', column: 'b' }]);
check('it sees a column in a CREATE TABLE body',
  columnsInBootstrap('create table t (\n  a text,\n  "b" integer\n);').has('t.a'), true);
check('…and does not mistake a constraint for a column',
  columnsInBootstrap('create table t (\n  a text,\n  primary key (a)\n);').has('t.primary'), false);
// The two directions that must be distinguishable: present, and genuinely absent.
check('a present column is not reported as a gap',
  bootstrapGaps(columnsAddedBy(ONE), 'create table t (\n  a text\n);'), []);
check('…and an absent one IS reported',
  bootstrapGaps(columnsAddedBy(ONE), 'create table t (\n  b text\n);').map((g) => `${g.table}.${g.column}`), ['t.a']);
check('a column added by an ALTER in the bootstrap counts as present',
  bootstrapGaps(columnsAddedBy(ONE), ONE), []);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a fresh self-host would come up with a schema the migrations never agreed to\n');
  process.exit(1);
}
console.log(`a fresh install gets all ${migrations.length} migrated column(s) — a new self-host is not a lesser one\n`);
