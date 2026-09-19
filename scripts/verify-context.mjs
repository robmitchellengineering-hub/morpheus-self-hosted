// Enforced memory: assert that what the docs CLAIM is still true.
//
// WHY THIS EXISTS
//
// On 2026-09-19 the project's hand-written memory went stale eight separate
// times, and every one was discovered by accident while doing something else:
//
//   * .dsh/skills/morpheus-deck said /deck is admin-gated — it had been opened
//     to all users
//   * the same file listed the data-vault check and the Jarvis synthesis card
//     as unbuilt — both had shipped
//   * .dsh/skills/morpheus-hazards said the H9 fix was "not yet built" — it had
//     been built an hour earlier
//   * server/prisma/manual-supabase-init.sql had 26 of 52 tables and NONE of
//     the 21 deck_* tables
//   * AGENTS.md pointed at server/prisma/migrations/, which does not exist
//
// None of those were discipline failures. They were FACTS that changed
// underneath a document. Curation preserves rules well and facts badly, so the
// facts get checked by machine instead.
//
// Run: node scripts/verify-context.mjs

import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(REPO, p), 'utf8')

let pass = 0, fail = 0
const problems = []

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`)
  if (!ok) {
    console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`)
    problems.push(name)
  }
  ok ? pass++ : fail++
}

/** One-line summary of a set difference, capped so output stays readable. */
const diff = (a, b) => a.filter((x) => !b.includes(x))

// ── skill frontmatter, parsed without a YAML dependency ─────────────────────
// The frontmatter in this repo is a flat block of `key: "value"` lines, so a
// full parser would be a dependency bought for nothing.
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const out = {}
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)
    if (!kv) continue
    let v = kv[2].trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[kv[1]] = v
  }
  return out
}

// ═══ 1. Skill frontmatter is valid ══════════════════════════════════════════
console.log('\n1. every skill parses and matches its directory')
const skillDirs = readdirSync(join(REPO, '.dsh/skills'))
const skills = []
for (const d of skillDirs) {
  const rel = `.dsh/skills/${d}/SKILL.md`
  if (!existsSync(join(REPO, rel))) continue
  const fm = parseFrontmatter(read(rel))
  if (!fm) { check(`${d}: has frontmatter`, false, true); continue }
  const missing = ['name', 'description'].filter((k) => !fm[k])
  if (missing.length) { check(`${d}: declares name+description`, missing, []); continue }
  check(`${d}: name matches directory`, fm.name, d)
  skills.push({ dir: d, rel, fm })
}

// ═══ 2. manual-supabase-init.sql matches schema.prisma ══════════════════════
// This is the check that would have caught the drifted bootstrap file. It is
// the highest-value one here: a fresh self-host runs that SQL and nothing else.
console.log('\n2. bootstrap SQL matches schema.prisma')
const schema = read('server/prisma/schema.prisma')
const modelTables = [...schema.matchAll(/^model\s+(\w+)\s*\{([\s\S]*?)^\}/gm)].map((m) => {
  const mapped = m[2].match(/@@map\("([^"]+)"\)/)
  return mapped ? mapped[1] : m[1]
})
const initSql = read('server/prisma/manual-supabase-init.sql')
// Tolerant of both styles on purpose: the generated file quotes and upper-cases
// (`CREATE TABLE "users"`), the old hand-written one did neither
// (`create table users`). A format-sensitive regex would have counted 0 rather
// than 26 against the drifted file — failing for the wrong reason.
const sqlTables = [...initSql.matchAll(/^\s*create table\s+"?([A-Za-z0-9_]+)"?/gim)].map((m) => m[1])

check('model count is non-zero (parser sanity)', modelTables.length > 0, true)
check('every model has a CREATE TABLE', diff(modelTables, sqlTables), [])
check('no CREATE TABLE lacks a model', diff(sqlTables, modelTables), [])
check(
  `table counts match (${modelTables.length})`,
  sqlTables.length,
  modelTables.length,
)

// ═══ 3. Paths the docs reference exist — or, if negated, don't ══════════════
// Catches e.g. AGENTS.md describing migrations in server/prisma/migrations/.
//
// The negation half matters as much as the positive half: documenting "there is
// no X" is only useful while that stays true, and a doc that says a thing is
// absent after someone added it is exactly as misleading as one naming a file
// that was deleted.
console.log('\n3. paths the docs reference exist (or are correctly documented as absent)')
const DOCS = skills.map((s) => ({ rel: s.rel, dir: `.dsh/skills/${s.dir}` }))
DOCS.unshift({ rel: 'AGENTS.md', dir: '' })

// Docs legitimately use shorthand, so a reference resolves if it exists under
// ANY of these roots. Only when it resolves under none of them — AND its first
// segment names a real top-level directory of this repo — is it a broken
// reference. That last condition is what keeps a path belonging to a DIFFERENT
// project (working-with-rob cites `core/diagnostics.py` from the Wikidata
// client repo) from being reported as a missing file here.
const repoTop = readdirSync(REPO).filter((f) => !f.startsWith('.'))
const ROOTS = ['', 'server/src', 'server', 'src', '.dsh']

// Phrases that assert a path is NOT there. These must IMMEDIATELY precede the
// path, because the scope of a negation is a clause, not a line:
//
//   "There is no request-validation library anywhere in `server/src`"
//
// negates the LIBRARY and says `server/src` is where it is missing — a
// whole-line test reads that backwards and reports the directory as absent.
// Requiring adjacency handles it: "…anywhere in" does not end in a negation.
const NEGATION_BEFORE = /\b(no|not|never|absent|none|without)$/i

// Collect every candidate first, then ask git which of them are ignored.
//
// This matters more than it looks. Without it the check is environment-
// dependent: `server/.env`, `server/data/pg/` and `server/package-lock.json`
// all exist on a developer's machine (untracked) and are absent in a fresh
// clone, so the same commit passed locally and FAILED in CI. A documentation
// check that depends on untracked local files is worse than none — it reports
// a different answer depending on where it runs.
//
// Docs are allowed to reference gitignored runtime artifacts (`npm run dev:db`
// creates `server/data/pg/`; you create `server/.env` yourself). Those are
// expected to be absent from a clone, so they are skipped rather than required.
const candidates = []
for (const doc of DOCS) {
  for (const line of read(doc.rel).split('\n')) {
    for (const m of line.matchAll(/`([^`\n]+)`/g)) {
      let token = m[1].trim()
      if (!token.includes('/')) continue
      if (/[<>*?{}[\]\s]/.test(token)) continue
      if (token.includes('://') || token.startsWith('~') || token.startsWith('/')) continue
      if (token.startsWith('.')) continue
      token = token.replace(/:\d+(?::\d+)?$/, '')
      const hasExt = /\.[A-Za-z0-9]+$/.test(token)
      const first = token.split('/')[0]
      if (!hasExt && !repoTop.includes(first)) continue
      if (!token) continue
      candidates.push({
        doc,
        token,
        negated: NEGATION_BEFORE.test(line.slice(0, m.index).replace(/[*_`]/g, '').trimEnd()),
      })
    }
  }
}

const ignored = new Set()
try {
  const out = execFileSync('git', ['check-ignore', '--stdin'], {
    cwd: REPO,
    input: candidates.map((c) => c.token).join('\n'),
    encoding: 'utf8',
  })
  for (const l of out.split('\n')) if (l.trim()) ignored.add(l.trim())
} catch {
  // git check-ignore exits 1 when nothing matches — that is a normal outcome.
  // Any other failure means we cannot classify, so nothing is skipped.
}

const brokenRefs = []
const wrongNegations = []
const checked = new Set()
for (const { doc, token, negated } of candidates) {
  if (ignored.has(token)) continue // expected absent from a clone
  const key = `${doc.rel}\0${token}\0${negated}`
  if (checked.has(key)) continue
  checked.add(key)

  const roots = [doc.dir, ...ROOTS].filter((r) => r !== undefined)
  const exists = roots.some((r) => existsSync(join(REPO, r, token)))

  if (negated) {
    if (exists) wrongNegations.push(`${doc.rel} says "${token}" is absent, but it exists`)
  } else if (!exists && repoTop.includes(token.split('/')[0])) {
    brokenRefs.push(`${doc.rel} -> ${token}`)
  }
}
check('no doc references a missing repo path', brokenRefs, [])
check('no doc claims a path is absent when it exists', wrongNegations, [])
check('gitignore classification ran (guards against an env-dependent pass)',
  ignored.size >= 1, true)
check('the check is actually looking at something', checked.size > 15, true)

// ═══ 4. "not yet built" claims are still true ═══════════════════════════════
// morpheus-deck twice listed shipped features as unbuilt. A claim that a FILE
// does not exist is machine-checkable; anything vaguer than that is not, and
// belongs in prose a human reads rather than a fact a machine asserts.
console.log('\n4. "not yet built" claims about files are still true')
const UNBUILT = /not yet built|unbuilt|does not exist|doesn't exist|not been built/i
const falseClaims = []
for (const skill of skills) {
  for (const line of read(skill.rel).split('\n')) {
    if (!UNBUILT.test(line)) continue
    // A path in backticks that also names a source file.
    for (const m of line.matchAll(/`([^`\n]+\.(?:js|jsx|ts|tsx|sql|md))`/g)) {
      const token = m[1].trim()
      if (/[<>*?{}[\]]/.test(token)) continue
      if (existsSync(join(REPO, token))) {
        falseClaims.push(`${skill.dir} says "${token}" is unbuilt, but it exists`)
      }
    }
  }
}
check('no skill calls an existing file unbuilt', falseClaims, [])

// ═══ 5. Verification scripts referenced by CI exist ═════════════════════════
console.log('\n5. every verification script CI runs exists')
const ci = read('.github/workflows/ci.yml')
const ciScripts = [...ci.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1])
check('CI references at least one script', ciScripts.length > 0, true)
check('all of them exist', ciScripts.filter((s) => !existsSync(join(REPO, s))), [])

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nThe docs disagree with the code. Fix whichever is wrong — if the')
  console.log('code is right, update the document; if the document is right, the')
  console.log('code has a bug the docs just caught for you.\n')
  process.exit(1)
}
console.log('all good\n')
