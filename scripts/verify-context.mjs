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
// Root documents are scanned too, and this list is the point of the exercise.
// Until 2026-09-20 the scan covered ONLY the skills and AGENTS.md — so the same
// staleness survived unchecked in exactly the documents that carry the most
// weight. KNOWN-HAZARDS.md still said H9's fix was "not yet built" a day after
// it was built (and that file is handed to the self-dev planner and reviewer on
// every build turn); ROADMAP.md still described a delivery loop that had
// changed; DSH-HARNESS.md still listed three skills when nine existed. Curating
// the rules while the authoritative documents drift freely is half a memory.
DOCS.unshift(
  { rel: 'AGENTS.md', dir: '' },
  { rel: 'KNOWN-HAZARDS.md', dir: '' },
  { rel: 'DSH-HARNESS.md', dir: '' },
  { rel: 'ROADMAP.md', dir: '' },
  { rel: 'docs/README.md', dir: 'docs' },
)

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
// …and the same claim is often written the other way round: "it resolved to
// `src/lib/queue.js` — a file that does not exist". Reading only backwards
// reported that (correct, useful) sentence as a broken reference.
//
// The two directions are deliberately NOT symmetric, because the grammar is not.
// "does not exist" AFTER a path describes the path just named, so it gets a
// generous window ("— a file that …" is a long way to say it). A negation BEFORE
// a path is the risky direction: in "it resolved to `src/lib/queue.js` — a file
// that does not exist. The real one is `server/src/queue.js`", a wide backwards
// window attributes that phrase to the *real* file and reports a correct
// sentence as a false claim. So the prefix window is short: "no `x`", "removed
// `x`", "never `x`".
const NEGATION_PREFIX = /\b(no|not|never|absent|none|without|removed|deleted|dropped)\s*$/i
const NEGATION_AFTER = /\b(not yet built|unbuilt|never built|not been built|does ?n[o']?t exist|doesn'?t exist|is absent|never existed|no such file|removed|deleted|dropped|was lost)\b/i
const negationNear = (context, index, length) => {
  const before = context.slice(Math.max(0, index - 12), index).replace(/[*_`]/g, '').trimEnd()
  const after = context.slice(index + length, index + length + 32).replace(/[*_`]/g, '')
  return NEGATION_PREFIX.test(before) || NEGATION_AFTER.test(after)
}

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
// A claim can wrap. Markdown prose here is wrapped at ~80 columns, so "…the
// revert also removed" can end one line and the path it removed begin the next —
// which is exactly how the first version of this proximity rule reported a
// correctly-documented deletion as a broken reference. So the text a claim is
// judged against is the previous line's tail joined to the current line, with
// the current line's start offset recorded.
const withWrap = (lines) => lines.map((line, i) => {
  const context = (lines[i - 1] || '').slice(-60) + line
  return { line, context, offset: context.length - line.length }
})
for (const doc of DOCS) {
  for (const { line, context, offset } of withWrap(read(doc.rel).split('\n'))) {
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
        negated: NEGATION_BEFORE.test(context.slice(0, offset + m.index).replace(/[*_`]/g, '').trimEnd())
          || negationNear(context, offset + m.index, m[0].length),
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
for (const doc of DOCS) {
  for (const { line, context, offset } of withWrap(read(doc.rel).split('\n'))) {
    if (!UNBUILT.test(context)) continue
    // A path in backticks that also names a source file.
    for (const m of line.matchAll(/`([^`\n]+\.(?:js|jsx|ts|tsx|sql|md))`/g)) {
      const token = m[1].trim()
      if (/[<>*?{}[\]]/.test(token)) continue
      // A bare filename is not specific enough to be a claim about a file: prose
      // about a *column* or a *route* that "does not exist" sits on the same line
      // as the model or route it is about, and resolving `entities.js` against
      // source roots turned those into false positives. A path with a separator
      // is unambiguous, so only those are judged.
      if (!token.includes('/')) continue
      // …and the "unbuilt" phrase has to be about THIS path. The hazard skills
      // are tables whose rows are single very long lines, so a rule reading
      // "a route that does not exist" shares a line with the fix that replaced
      // it. Proximity, not the line, decides what a claim is about.
      if (!negationNear(context, offset + m.index, m[0].length)) continue
      // Bare filenames are how this drifted before: KNOWN-HAZARDS.md names
      // `lib/selfDevDrift.js`, which resolves from server/src, while
      // `server/prisma/selfdev-<slug>.sql` is a template and is skipped above.
      const hit = [doc.dir, ...ROOTS].filter(Boolean).map((r) => join(REPO, r, token)).find((p) => existsSync(p))
      if (hit) falseClaims.push(`${doc.rel} says "${token}" is unbuilt, but ${hit.replace(REPO + '/', '')} exists`)
    }
  }
}
check('no doc calls an existing file unbuilt', falseClaims, [])

// KNOWN-HAZARDS.md is read by self-dev's planner and reviewer on EVERY build
// turn, so a status claim in it is an instruction the next build acts on. H9's
// said its own fix was "not yet built" for a day after `lib/selfDevDrift.js`
// shipped — the skill was corrected, the hazard file was not, and because this
// file was outside the scan nothing noticed. It is a list of rules; a claim
// about what exists belongs in a check, not here.
check('KNOWN-HAZARDS.md makes no "not yet built" status claim',
  /not yet built|unbuilt|never built/i.test(read('KNOWN-HAZARDS.md')), false)

// ── The authority's OWN verdicts ────────────────────────────────────────────
// sections 4 and 4b police what the DOCS claim; this one polices what
// `scripts/reality.mjs` claims, which is worse to get wrong because reality.mjs
// is the file the docs are measured against.
//
// The failure it exists for, 2026-09-28: `out.billing` carried
//   { step: '7  billing verification pass', verdict: 'NOT BUILT', evidence:
//     'no end-to-end check that charges match recorded usage' }
// as a LITERAL, and #419 had built exactly that (verify-billing-ledger.mjs plus
// its import-free maths half). Nothing recomputed it, so the authority went on
// telling every session to build a shipped pass — and because the file is .js,
// section 4's scan of the docs walked straight past it.
//
// THE RULE, and it is asymmetric on purpose: a verdict of ABSENCE must be
// COMPUTED. A literal 'BUILT' can only go stale if something is deleted, which
// is loud and rare; a literal 'NOT BUILT' goes stale the moment work lands,
// silently, and reads as an instruction. So a literal 'NOT BUILT' is what fails
// here — not literal verdicts in general, which would cry wolf on the schema row
// that is legitimately asserted from production state.
const realitySrc = read('scripts/reality.mjs')
const literalAbsence = [...realitySrc.matchAll(/verdict:\s*(["'])(NOT BUILT[^"']*)\1/g)].map((m) => m[2])
check('the authority never writes an absence verdict as a literal', literalAbsence, [])
// A threshold, not the exact count: an exact number breaks every time a step is
// added, and a guard that cries wolf on correct work gets switched off. 11 are
// computed today; the point is that the regex is matching real code at all.
check('…its verdicts are really computed (regex sanity)',
  (realitySrc.match(/\? 'BUILT[^']*' : 'NOT BUILT'/g) || []).length >= 8, true)
// …and the computed one has to be about the REAL artifact, not any expression
// that happens to end in the right strings. Step 7 must test the checker it
// claims, and that checker must exist.
check('step 7\'s verdict tests the billing-ledger checker, not a placeholder',
  /step: '7[^']*', verdict: [^\n]*verify-billing-ledger/.test(realitySrc), true)
check('…and the files it tests exist',
  ['scripts/verify-billing-ledger.mjs', 'scripts/verify-billing-ledger-math.mjs']
    .filter((p) => !existsSync(join(REPO, p))), [])

// ═══ 5. Verification scripts referenced by CI exist ═════════════════════════
console.log('\n5. every verification script CI runs exists')
const ci = read('.github/workflows/ci.yml')
const ciScripts = [...ci.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1])
check('CI references at least one script', ciScripts.length > 0, true)
check('all of them exist', ciScripts.filter((s) => !existsSync(join(REPO, s))), [])

// ═══ 5b. The workflow files are ones GitHub will actually run ═══════════════
// WHY THIS EXISTS — 2026-09-23, and it went unnoticed for an hour and a half.
//
// The contrast commit added its step to ci.yml indented eight spaces where every
// sibling uses six. That is not "one step does not run": GitHub refuses the whole
// FILE, so the run fails in 0s with no jobs at all — no lint, no guards, no boot
// smoke, on every push and every pull request. `gh pr checks` then reports only
// the Netlify preview, and a PR whose code checks never ran reads as mergeable
// and CLEAN. Two commits reached main through that hole before anyone looked.
//
// §5 above could not catch it: the scripts CI *names* all existed. §8 could not
// either: every guard was listed in verify.mjs and in ci.yml. The one thing that
// broke was the file those lists live in.
//
// A YAML parser would be the real answer and cannot be used here — this runs in
// CI's no-install guards job, and verify-guards-no-install.mjs fails any guard
// that reaches a package. So this checks the two structural rules whose breach
// is both silent and total, at the granularity that actually catches the way
// this file gets broken by a person or an agent editing it: a sequence entry
// that does not line up with its siblings, and a tab.
const workflowFiles = readdirSync(join(REPO, '.github/workflows')).filter((f) => /\.ya?ml$/.test(f)).sort()
check('workflow files were found (parser sanity)', workflowFiles.length >= 1, true)

const misaligned = []
const tabbed = []
// A GitHub step always begins with one of these keys at the dash. Anything else
// starting with `- ` is a nested sequence (an `args:` list, a `with:` value) and
// is legitimately deeper — so the check must not treat those as steps, or it
// would fail on a perfectly good workflow.
const STEP_ENTRY = /^\s*- (name|uses|run|id|if|shell|working-directory|timeout-minutes|continue-on-error):/
for (const file of workflowFiles) {
  const lines = read(`.github/workflows/${file}`).split('\n')
  let stepsIndent = null
  let entryIndent = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^\s*\t/.test(line)) tabbed.push(`${file}:${i + 1}`)
    if (/^\s*$/.test(line) || /^\s*#/.test(line)) continue
    const indent = line.match(/^ */)[0].length
    if (/^\s*steps:\s*$/.test(line)) { stepsIndent = indent; entryIndent = null; continue }
    if (stepsIndent === null) continue
    if (indent <= stepsIndent) { stepsIndent = null; entryIndent = null; continue }
    if (!STEP_ENTRY.test(line)) continue
    if (entryIndent === null) entryIndent = indent
    else if (indent !== entryIndent) {
      misaligned.push(`${file}:${i + 1} is a step at column ${indent}, but this block's other steps are at ${entryIndent}`)
    }
  }
}
check('no workflow line is indented with a tab', tabbed, [])
check('every step in a steps: block lines up with its siblings', misaligned, [])

// ═══ 6. the build library index matches its cards ═══════════════════════════
// The library's whole value is that the INDEX is the cheap thing you read and the
// cards are the detail you load on demand. Both halves fail silently on their
// own: a card missing from the index is invisible, and an index row pointing at
// a card that was renamed is a dead end. So the two are checked against each
// other, and the check reports what it looked at so a parse failure cannot pass
// as "no problems".
console.log('\n6. the build library index matches its cards')
const LIB = '.dsh/skills/morpheus-build-library'
const libIndexPath = `${LIB}/SKILL.md`
const libIndexExists = existsSync(join(REPO, libIndexPath))
check('the library index exists', libIndexExists, true)
if (libIndexExists) {
  const index = read(libIndexPath)
  const cards = existsSync(join(REPO, `${LIB}/references`))
    ? readdirSync(join(REPO, `${LIB}/references`)).filter((f) => f.endsWith('.md')).sort()
    : []
  check('it has cards (parser sanity)', cards.length >= 4, true)

  const listed = [...index.matchAll(/`references\/([\w.-]+\.md)`/g)].map((m) => m[1])
  const unlisted = cards.filter((c) => !listed.includes(c))
  const missing = listed.filter((c) => !cards.includes(c))
  check('every card is listed in the index', unlisted, [])
  check('every index row points at a real card', missing, [])
  check('the index says what it is for', /whenToUse:/.test(index) && /How to use it/.test(index), true)
}

// ═══ 7. The entry document knows what exists ════════════════════════════════
// AGENTS.md is the first file a fresh agent reads, and it claimed "Three project
// skills under .dsh/skills/" long after there were nine. A short list that reads
// as complete is worse than no list, because nothing prompts you to look
// further — so the two are checked against each other.
console.log('\n7. AGENTS.md names every skill that exists')
check('skill directories were read (parser sanity)', skillDirs.length >= 4, true)
const agentsDoc = read('AGENTS.md')
// Split to bare words first: a name written as `morpheus-stack` or "morpheus-stack"
// must count, but the substring "stack" inside a sentence must not.
const agentsWords = agentsDoc.split(/[^A-Za-z0-9_-]+/).filter(Boolean)
check('every skill on disk is named in AGENTS.md', diff(skillDirs, agentsWords), [])

// ═══ 8. The one gate runs every guard ══════════════════════════════════════
// verify.mjs's own header says it exists "so no step can be skipped or
// forgotten". Two guards were not in it — verify-billing-clamp and
// verify-guards-no-install — and nothing failed, because CI ran them anyway.
// That is exactly how a "run this before merging" command quietly stops being
// the whole gate, and a guard you only meet in CI is a guard that surprises you
// after you have already decided the change was fine.
console.log('\n8. every guard is run by the one gate')
const verifySrc = read('scripts/verify.mjs')
const hardBlock = verifySrc.match(/const HARD = \[([\s\S]*?)\]/)
const hardListed = hardBlock ? [...hardBlock[1].matchAll(/'([\w.-]+\.mjs)'/g)].map((m) => m[1]) : []
const guardFiles = readdirSync(join(REPO, 'scripts')).filter((f) => /^verify-.*\.mjs$/.test(f)).sort()
// verify.mjs runs this one on its own, not in the HARD loop, because it needs a
// production credential and reports "not verified" (exit 2) rather than failing.
const RUN_SEPARATELY = ['verify-schema-prod.mjs', 'verify-billing-ledger.mjs']
check('the guard list parsed (parser sanity)', hardListed.length >= 8, true)
check('every guard is run by the one gate',
  guardFiles.filter((f) => !hardListed.includes(f) && !RUN_SEPARATELY.includes(f)), [])
check('every entry in the gate is a real script',
  hardListed.filter((f) => !existsSync(join(REPO, 'scripts', f))), [])
// CI is the second list, and two lists drift the same way one does.
const ciRuns = new Set([...ci.matchAll(/node (scripts\/[\w.-]+\.mjs)/g)].map((m) => m[1].replace('scripts/', '')))
// boot-smoke boots the real server, so it needs the server's own dependencies —
// and server/package-lock.json is untracked (H4), so CI cannot install them.
const CI_CANNOT = ['boot-smoke.mjs', 'verify-schema-prod.mjs', 'verify-billing-ledger.mjs']
check('CI runs every hard gate', hardListed.filter((f) => !ciRuns.has(f) && !CI_CANNOT.includes(f)), [])

// ═══ 9. The archive indexes list every file ════════════════════════════════
// docs/planning and docs/audits hold point-in-time snapshots kept so this
// knowledge cannot be lost with a folder. The index is what makes them findable;
// a file nobody listed is a file nobody reads. Same contract as the library.
console.log('\n9. the archive indexes match their files')
const archiveIndex = read('docs/README.md')
for (const dir of ['docs/planning', 'docs/audits']) {
  const files = readdirSync(join(REPO, dir)).filter((f) => f.endsWith('.md')).sort()
  check(`${dir} has files (parser sanity)`, files.length >= 4, true)
  check(`every file in ${dir} is listed in docs/README.md`, files.filter((f) => !archiveIndex.includes(`${dir}/${f}`)), [])
  const dangling = [...archiveIndex.matchAll(new RegExp(`${dir}/[\\w.-]+\\.md`, 'g'))]
    .map((m) => m[0]).filter((p) => !existsSync(join(REPO, p)))
  check(`every ${dir} path named in docs/README.md exists`, dangling, [])
}

// ═══ 10. The quoted hazard range is the real one ═══════════════════════════
// Adding H13–H16 instantly made five documents wrong: AGENTS.md, DSH-HARNESS.md,
// the hazards skill's own description, the dev protocol's "Related" list and the
// library index all still said "H1–H12". That is the same stale-list failure as
// "Three project skills", so it gets the same treatment — the range a document
// quotes is checked against the last hazard that actually exists.
console.log('\n10. the quoted hazard range matches KNOWN-HAZARDS.md')
const hazardNums = [...read('KNOWN-HAZARDS.md').matchAll(/^## H(\d+)\b/gm)].map((m) => Number(m[1]))
check('hazards parsed (parser sanity)', hazardNums.length >= 12, true)
const hMax = Math.max(...hazardNums)
const staleRanges = []
for (const doc of DOCS) {
  for (const m of read(doc.rel).matchAll(/H1[–-]H(\d+)/g)) {
    if (Number(m[1]) !== hMax) staleRanges.push(`${doc.rel} quotes H1–H${m[1]}, but the newest hazard is H${hMax}`)
  }
}
check(`every quoted hazard range ends at H${hMax}`, staleRanges, [])

// …AND EVERY HAZARD IS ACTUALLY IN THE CHECKLIST. The endpoint check above cannot see a hazard that
// was added to KNOWN-HAZARDS.md but never given a row in `morpheus-hazards`, which is the file a
// reviewer is told to walk item by item. Updating the range and forgetting the row makes the range a
// lie — the failure this whole section exists to prevent, one level up. (Found 2026-09-30 while
// appending H19: the range across five documents was caught automatically, the missing row was not.)
const skillTable = read('.dsh/skills/morpheus-hazards/SKILL.md')
const missingRows = hazardNums.filter((n) => !new RegExp(`\\|\\s*\\*\\*H${n}\\*\\*\\s*\\|`).test(skillTable))
check('every hazard has a row in the morpheus-hazards checklist', missingRows, [])

// ═══ 11. The operator's surfaces are the ones we think ══════════════════════
// A session asked to fix "the SEO tab in the WordPress plugin" went to wp-plugin/
// — which ships no interface at all — while the operator was in the floating dock
// that public/plugin.js drops on their own site. Two unrelated things share the
// word "plugin", and the dock and the app's WEBSITE panel mount the SAME tab
// components, so a fix in one is a fix in both.
//
// That is only true while nobody forks them: the day someone gives the dock its
// own SEO panel, a shared-component fix silently stops covering the operator's
// site. This is the check that announces it.
console.log('\n11. the operator\'s surfaces are the ones we think')
const surfPanel = read('src/components/matrix/WebsitePanel.jsx')
const surfEmbed = read('src/pages/Embed.jsx')
const surfDock = read('public/plugin.js')
const tabImports = (src) => [...src.matchAll(/from\s+'[^']*\/website\/(\w+)'/g)].map((m) => m[1])
const panelCmps = tabImports(surfPanel)
const embedCmps = tabImports(surfEmbed)
// Only components that ARE tabs. The dock legitimately adds non-tab components of
// its own (EmbedChat — it talks to the page it floats over, which the app panel's
// chat does not), so the assertion is about tabs: a dock-only *Tab is the fork
// that would silently stop a shared-component fix from reaching the operator.
const embedTabCmps = embedCmps.filter((c) => /Tab$/.test(c))
check('the app panel mounts tabs (parser sanity)', panelCmps.length >= 5, true)
check('the dock mounts tabs (parser sanity)', embedTabCmps.length >= 4, true)
check('every tab the dock mounts is the app panel\'s own component', embedTabCmps.filter((t) => !panelCmps.includes(t)), [])
check('the SEO tab is shared by both surfaces', embedTabCmps.includes('SeoTab') && panelCmps.includes('SeoTab'), true)
check('the dock loader points at the embed surface', /\/embed\?/.test(surfDock), true)

// The WordPress plugin is headless, and that is exactly why looking for a tab in
// it wastes a session. Assert the absence so that adding a UI to the plugin fails
// here — forcing whoever does it to update the map rather than surprise the next
// reader with a third place a panel can live.
const pluginFiles = (() => {
  const full = join(REPO, 'wp-plugin/morpheus')
  if (!existsSync(full)) return []
  const walk = (d, prefix = '') => readdirSync(d, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walk(join(d, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]
  ))
  return walk(full)
})()
check('the WordPress plugin still ships no JS/CSS (it is headless)', pluginFiles.filter((f) => /\.(js|css)$/.test(f)), [])


// ── 11b. the task runner is above the tab switch, on both surfaces ──────────
//
// 2026-09-24, Rob: "whenever you switch tabs in the plugin the tasks stop running
// or atleast apear to". Both were true: the tabs are rendered conditionally, so
// switching UNMOUNTED the component that owned the loop, and the remaining slices
// were never sent while the state that described them was destroyed.
//
// "The provider is present" is not the claim. The claim is that it ENCLOSES the
// conditional tab renders — so these checks locate the mount and the tab branches
// in the same source and compare their positions, rather than looking for a name.
// This script compares values rather than searching text, so the section brings
// its own one-line helper instead of assuming another guard's vocabulary.
const contains = (haystack, needle) => String(haystack).includes(needle)

const RUNNER = 'src/components/matrix/TaskRunner.jsx'
const runnerSrc = read(RUNNER)
const seoLoopSrc = read('src/components/matrix/website/SeoTab.jsx')

// The tab branches, by the shape both surfaces use to render one.
const tabBranchPositions = (src) => [...src.matchAll(/\{\s*(?:!loading\s*&&\s*)?tab === '/g)].map((m) => m.index)

for (const [label, file] of [['the app panel', 'src/components/matrix/WebsitePanel.jsx'], ['the dock', 'src/pages/Embed.jsx']]) {
  const src = read(file)
  const open = src.indexOf('<TaskRunner>')
  const close = src.lastIndexOf('</TaskRunner>')
  const branches = tabBranchPositions(src)
  check(`${label} mounts the task runner (parser sanity)`, open > 0 && close > open, true)
  check(`${label} still switches tabs (parser sanity)`, branches.length >= 4, true)
  // The whole point: every conditional tab render sits INSIDE the provider, so
  // unmounting a tab cannot unmount the thing that owns the work.
  check(`${label} mounts it outside the tab switch`,
    open < Math.min(...branches) && close > Math.max(...branches), true)
  // EXACTLY one mount. A second one inside a tab branch leaves the first in the
  // right place, so a position check alone still passes while a loop started in
  // that branch is owned by the wrong provider — and nothing on screen says so.
  check(`${label} mounts it exactly once`,
    (src.match(/<TaskRunner>/g) || []).length, 1)
  check(`${label} imports the one shared runner`,
    /from '@\/components\/matrix\/TaskRunner'|from '\.\/TaskRunner'/.test(src), true)
}

// The state is the runner's, not the tab's. If someone moves the loop back into
// the tab, the strip would still exist and the provider would still be mounted —
// and the bug would be back. These two are what catch that.
check('the SEO tab uses the shared runner', contains(seoLoopSrc, 'useTaskRunner()'), true)
check('…and starts the batch through it', contains(seoLoopSrc, 'startTask('), true)
check('…under a stable task key', contains(seoLoopSrc, "RUN_KEY = 'seo:batch'"), true)
// The markers of the loop having gone back into the tab: its own cancel ref, and
// a local run state keyed to the batch.
check('…and no longer cancels with a local ref', contains(seoLoopSrc, 'cancelRun'), false)
check('…and no longer holds the batch run in tab state', /setRun\(\{\s*key: 'batch'/.test(seoLoopSrc), false)
check('…and no longer draws the batch timer itself', contains(seoLoopSrc, "timerFor('batch')"), false)

// The run has to be RENDERED somewhere that is not the tab it belongs to, or
// leaving the tab still hides it.
check('the runner renders the strip', contains(runnerSrc, '<TaskRunStrip'), true)
check('the strip is exported for the same reason', contains(runnerSrc, 'export function TaskRunStrip'), true)
// Rendered UNCONDITIONALLY. A strip behind a condition is a strip that can be
// hidden by the very thing this fixes — the tab the operator is looking at — and
// "it is present in the file" would still pass while that happened.
check('…and rendered unconditionally, not behind a condition',
  /\{[^}]*<TaskRunStrip/.test(runnerSrc), false)
const tabFiles = (() => {
  const dir = join(REPO, 'src/components/matrix/website')
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter((f) => f.endsWith('.jsx'))
})()
check('the website tabs were found (parser sanity)', tabFiles.length >= 8, true)
check('no tab draws the run strip for itself',
  tabFiles.filter((f) => contains(read(`src/components/matrix/website/${f}`), 'TaskRunStrip')), [])
check('the runner says where its state lives',
  contains(runnerSrc, 'THIS MODULE owns the state') && contains(runnerSrc, 'A TAB owns only the presentation'), true)


// ── 11c. EVERY client-driven loop is owned by the runner, not by a tab ──────
//
// 2026-09-24, Rob: "Yes we need to fix them all" — after the SEO batch was moved
// above the tab switch, the other loops in these tabs still died the same way.
//
// The half that is easy to miss is the RESULT. Moving only the work means the job
// finishes while the operator is on another tab and the answer is still gone when
// they come back — the worst of both. So each check below is about the result as
// much as the run, and the keys are asserted so two actions in one tab cannot
// overwrite each other's.
const LOOP_TABS = ['SeoTab', 'HealthTab', 'TrafficTab'].map((n) => `src/components/matrix/website/${n}.jsx`)
const loopSrc = LOOP_TABS.map((f) => read(f))
const loopKeys = loopSrc.flatMap((src) => [...src.matchAll(/task\('([a-z0-9:]+)'|key: '([a-z0-9:]+)'/g)].map((m) => m[1] || m[2])
  .concat([...src.matchAll(/RUN_KEY = '([a-z0-9:]+)'/g)].map((m) => m[1])))

check('the migrated tabs were read (parser sanity)', loopSrc.every((src) => src.length > 2000), true)
check('every loop declares a key (parser sanity)', loopKeys.length >= 10, true)
check('the task keys are exactly the migrated loops', [...loopKeys].sort(),
  // CLEAN MY SITE added two: the heavy scan and the one press that quarantines
  // the safe set. Both run in the runner for the same reason as FIX ALL — leaving
  // the tab must not cancel a quarantine half-way through the set.
  ['health:clean', 'health:cleanapply', 'health:fixall', 'health:scan', 'seo:audit', 'seo:batch', 'seo:blog', 'seo:keywords',
    'seo:linkapply', 'seo:linkplan', 'seo:links', 'seo:one', 'traffic:backfill'])
check('…and no two loops share a key', new Set(loopKeys).size, loopKeys.length)

// NO tab owns a run — or a result — in local state. These are the setters that
// used to hold them; a loop reverted to local state brings one back, which is the
// regression this half is for.
const ORPHANED_SETTERS = [
  'setAuditing', 'setKwBusy', 'setGenOne', 'setGenBlog', 'setLoadingLinks', 'setApplyingLinks',
  'setFixAllRunning', 'setFixAllProgress', 'setFixAllReport', 'setScan(', "setBusy('backfill')",
]
// The state NAMES too, not only the setters: a loop reverted to local state can
// declare `const [scan, setScan] = useState(null)` and never call the setter yet,
// which is the regression in its purest form — and a check that only searched for
// the setter CALL passed it. (Found by mutation L3, which did exactly that.)
const ORPHANED_STATES = [
  // NOT `loading`: SeoTab has a legitimate `loading` for its item list, which is
  // not a run state. Every other name here belonged to a migrated loop.
  'auditing', 'kwBusy', 'genOne', 'genBlog', 'loadingLinks', 'applyingLinks',
  'fixAllRunning', 'fixAllProgress', 'fixAllReport', 'scan',
]
const declaredStates = (src) => [...src.matchAll(/const\s*\[\s*([A-Za-z_$][\w$]*)\s*,\s*set[A-Za-z_$][\w$]*\s*\]\s*=\s*useState/g)].map((m) => m[1])

for (const [i, src] of loopSrc.entries()) {
  const label = LOOP_TABS[i].split('/').pop()
  check(`${label} keeps no run or result in local state`,
    ORPHANED_SETTERS.filter((setter) => contains(src, setter)), [])
  check(`${label} declares no run or result state`,
    declaredStates(src).filter((n) => ORPHANED_STATES.includes(n)), [])
  // …and reads them back out of the runner instead, which is what makes a
  // remount show the answer rather than a blank.
  check(`${label} reads its results back from the runner`,
    (src.match(/useTaskResult\(/g) || []).length >= 1, true)
  // The strip's Stop has to be real: a cancel button that no longer cancels is
  // worse than none. Every loop a tab starts must check it.
  const started = (src.match(/startTask\(|await task\(/g) || []).length
  const cancels = (src.match(/cancelled\(\)/g) || []).length
  check(`${label} checks the cancel in every loop it starts (${cancels} checks / ${started} starts)`,
    cancels >= started, true)
}
// A result the tab CANNOT place yet must not be consumed. The per-item loops carry
// an item id, and a remount starts on the list with no item open — consuming the
// result there spends the hook's one application on a tab that cannot use it, and
// the answer is lost silently. Watching the merged code do exactly that is how this
// was found; these two keep it from coming back.
check('the runner does not consume a result its apply refused',
  /if \(fn\.current\(r\) === false\) return;/.test(runnerSrc), true)
check('…and the effect re-runs when what the result lands on changes',
  /\[key, task\?\.status, task\?\.result, \.\.\.watch\]/.test(runnerSrc), true)
{
  const perItem = (loopSrc[0].match(/\[edit\?\.id\]\)/g) || []).length
  check('every per-item loop watches the open item', perItem >= 3, true)
  check('…and refuses a result that belongs to another page',
    (loopSrc[0].match(/return false; \/\/ not this page/g) || []).length >= 3, true)
}

// …and the strip is where the cancel comes from, so it must pass one on.

check('the strip offers a cancel', contains(runnerSrc, 'onCancel(t.key)') || contains(runnerSrc, 'onCancel:'), true)

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nThe docs disagree with the code. Fix whichever is wrong — if the')
  console.log('code is right, update the document; if the document is right, the')
  console.log('code has a bug the docs just caught for you.\n')
  process.exit(1)
}
console.log('all good\n')
