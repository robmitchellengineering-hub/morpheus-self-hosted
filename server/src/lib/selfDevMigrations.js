// Self-dev DB migrations (SELF-DEV-V2 A2).
//
// A self-dev change that alters server/prisma/schema.prisma must ship a
// matching idempotent DDL file named `server/prisma/selfdev-<slug>.sql` in the
// SAME change. The coder is instructed to (scopedContextNote / KNOWN-HAZARDS),
// and pushSelfDevToGithub blocks a schema change that doesn't include one.
//
// After the change lands, applySelfDevMigrations.js runs any selfdev-*.sql not
// already recorded in the `self_dev_migrations` tracking table — but ONLY if
// every statement is additive (CREATE TABLE / ADD COLUMN / CREATE INDEX /
// CREATE TYPE / ALTER TYPE ADD VALUE / …). Anything with DROP, RENAME, or an
// ALTER COLUMN type change is left for a human to run against Supabase, since
// destructive DDL needs coordinating with the code deploy and can't be safely
// auto-applied.
//
// The backend container has prod deps only (no prisma CLI), so there's no
// `prisma migrate diff` here — the migration SQL is authored by the coder as a
// normal file, in the same dead-simple style as the existing
// server/prisma/*.sql files, and reviewed by the operator before the push.

export const SCHEMA_PATH = 'server/prisma/schema.prisma';
export const MIGRATION_RE = /^server\/prisma\/selfdev-[a-z0-9][a-z0-9-]*\.sql$/i;

// Statement-level allowlist — self-dev only ever adds schema, never rewrites it.
const ADDITIVE = [
  /^create\s+table\s+(if\s+not\s+exists\s+)?/i,
  /^create\s+(unique\s+)?index\s+(concurrently\s+)?(if\s+not\s+exists\s+)?/i,
  /^alter\s+table\s+[^\s]+\s+add\s+column\s+(if\s+not\s+exists\s+)?/i,
  /^alter\s+table\s+[^\s]+\s+add\s+constraint\s+/i,
  /^create\s+type\s+/i,
  /^alter\s+type\s+[^\s]+\s+add\s+value\s+/i,
  /^create\s+extension\s+(if\s+not\s+exists\s+)?/i,
  /^comment\s+on\s+/i,
];

// Destructive clauses that disqualify a statement **wherever** they appear in it,
// not only where it begins. This matters because one Postgres statement can carry
// several clauses: `ALTER TABLE t ADD COLUMN a int, DROP COLUMN b` is a single,
// valid statement that starts with an allowed prefix, so a prefix-only allowlist
// read it as additive and the runner executed it — the exact opposite of what the
// header above promises. The text tested here has had its string literals, quoted
// identifiers, dollar-quoted bodies and comments blanked out, so a word like
// "drop" inside a DEFAULT cannot trip the guard, and cannot hide behind one either.
//
// Deliberately narrow, and measured against all 47 files in server/prisma before
// landing: a bare `DELETE`/`UPDATE` scan refused 22 legitimate additive migrations,
// because `ON DELETE CASCADE` and `ON UPDATE CASCADE` are ordinary foreign-key
// syntax inside `CREATE TABLE` and `ADD CONSTRAINT`. Those are covered where they
// belong — by the prefix rule, since a statement that *starts* with DELETE or
// UPDATE matches no additive pattern. What a sub-clause can actually hide is a
// destructive DDL verb, so those are the ones matched here.
const RISKY_ANYWHERE = [
  /\bdrop\s+(column|constraint|table|schema|index|view|sequence|type|default|not\s+null|materialized\s+view)\b/i,
  /\brename\s+(column|constraint|to)\b/i,
  /\balter\s+column\b/i,
  /\btruncate\s+(table\s+)?[a-z_"]/i,
];

// One pass, three copies of each statement:
//   raw   — what actually runs.
//   code  — literals, dollar-quoted bodies and comments blanked to spaces, quoted
//           identifiers KEPT, because they are code: the additive patterns have to
//           see `ALTER TABLE "user_settings" ADD COLUMN`. Blanking them made the
//           table-name slot `[^\s]+` match nothing and refused 22 real migrations.
//   scan  — `code` with quoted identifiers blanked as well, so a column literally
//           named "drop column" cannot trip the destructive-clause scan.
// Splitting happens at every top-level `;`, and a `;` inside a literal, an
// identifier, a dollar-quoted body or a comment is not a separator. Requiring a
// newline after the `;` — which this used to do — meant `ALTER TABLE …; DROP TABLE
// users;` on one line was read as one statement whose first clause was all the
// allowlist ever saw.
function scanStatements(sql) {
  const src = String(sql || '');
  const out = [];
  let raw = '';
  let code = '';
  let scan = '';
  const flush = () => {
    // A chunk that is only comments and whitespace is not a statement — the runner
    // executes what it is handed, and handing it `-- a note` is an empty query.
    if (raw.trim() && code.trim()) out.push({ raw: raw.trim(), code: code.trim(), scan: scan.trim() });
    raw = ''; code = ''; scan = '';
  };
  const blankAll = (text) => { raw += text; code += ' '.repeat(text.length); scan += ' '.repeat(text.length); };
  const blankScan = (text) => { raw += text; code += text; scan += ' '.repeat(text.length); };

  for (let i = 0; i < src.length;) {
    const rest = src.slice(i);
    if (rest.startsWith('--')) {
      const nl = src.indexOf('\n', i);
      const stop = nl === -1 ? src.length : nl;
      blankAll(src.slice(i, stop)); i = stop; continue;
    }
    if (rest.startsWith('/*')) {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blankAll(src.slice(i, stop)); i = stop; continue;
    }
    const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
    if (dollar) {
      const tag = dollar[0];
      const end = src.indexOf(tag, i + tag.length);
      const stop = end === -1 ? src.length : end + tag.length;
      blankAll(src.slice(i, stop)); i = stop; continue;
    }
    if (rest[0] === "'" || rest[0] === '"') {
      const quote = rest[0];
      let j = i + 1;
      while (j < src.length) {
        if (src[j] === '\\' && quote === "'") { j += 2; continue; }        // E'…\'…'
        if (src[j] === quote) {
          if (src[j + 1] === quote) { j += 2; continue; }                   // '' inside '…'
          j += 1; break;
        }
        j += 1;
      }
      const text = src.slice(i, j);
      if (quote === '"') blankScan(text); else blankAll(text);
      i = j; continue;
    }
    if (rest[0] === ';') { raw += ';'; code += ' '; scan += ' '; flush(); i += 1; continue; }
    raw += rest[0]; code += rest[0]; scan += rest[0]; i += 1;
  }
  flush();
  return out;
}

export function splitStatements(sql) {
  return scanStatements(sql).map((s) => s.raw);
}

export function classifyMigration(sql) {
  const stmts = scanStatements(sql);
  const risky = stmts.filter(
    (s) => !ADDITIVE.some((re) => re.test(s.code)) || RISKY_ANYWHERE.some((re) => re.test(s.scan)),
  );
  return {
    additive: stmts.length > 0 && risky.length === 0,
    stmts: stmts.map((s) => s.raw),
    riskyStatements: risky.map((s) => s.raw),
  };
}

export async function ensureMigrationTable(prisma) {
  await prisma.$executeRawUnsafe(
    `create table if not exists self_dev_migrations (
       filename text primary key,
       statement_count integer not null default 0,
       applied_date timestamp(3) not null default now()
     )`,
  );
}

export async function appliedMigrationNames(prisma) {
  try {
    const rows = await prisma.$queryRawUnsafe('select filename from self_dev_migrations');
    return new Set(rows.map((r) => r.filename));
  } catch {
    return new Set();
  }
}
