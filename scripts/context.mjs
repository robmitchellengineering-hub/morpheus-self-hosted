// Generated context: what this system IS right now, read from the code.
//
// WHY THIS EXISTS
//
// On 2026-09-19 the project's hand-written memory went stale eight times, and
// the pattern was always the same: a DOCUMENT held a fact that the CODE had
// moved past. Curation preserves rules well and facts badly.
//
// So facts live here instead — derived on demand, therefore never stale by
// construction. Nothing in this file is remembered; every line is read from
// source. If the output disagrees with a doc, the doc is wrong.
//
// Run: node scripts/context.mjs
//      node scripts/context.mjs --json    (machine-readable)

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p) => readFileSync(join(REPO, p), 'utf8')
const exists = (p) => existsSync(join(REPO, p))
const ls = (p) => (exists(p) ? readdirSync(join(REPO, p)) : [])
/** Every file under a directory, recursive — for "does this ship any JS at all". */
const walkFiles = (dir) => {
  const full = join(REPO, dir)
  if (!existsSync(full)) return []
  return readdirSync(full, { withFileTypes: true }).flatMap((e) => (
    e.isDirectory() ? walkFiles(`${dir}/${e.name}`) : [`${dir}/${e.name}`]
  ))
}
const listFiles = (dir, ext) => {
  const full = join(REPO, dir)
  if (!existsSync(full)) return []
  const out = []
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (!ext || p.endsWith(ext)) out.push(p.slice(REPO.length + 1))
    }
  }
  walk(full)
  return out
}

const out = {}
const asJson = process.argv.includes('--json')

// ── server ──────────────────────────────────────────────────────────────────
const index = read('server/src/index.js')
const fnRoutes = read('server/src/routes/functions.routes.js')

const setFrom = (src, name) => {
  const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`))
  return m ? [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]) : []
}
const publicFns = setFrom(fnRoutes, 'PUBLIC_FUNCTIONS')
const adminFns = setFrom(fnRoutes, 'ADMIN_FUNCTIONS')
const allFns = ls('server/src/functions').filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''))

const mounts = [...index.matchAll(/app\.use\('(\/api\/[a-z-]+)'\s*,\s*(\w+Routes)/g)].map((m) => `${m[1]} -> ${m[2]}`)
// windowMs is written as an expression (`60 * 1000`), so match the raw value
// and evaluate only multiplication of integers — no eval.
const rateLimitMatch = index.match(/rateLimit\(\{([^}]*)\}\)/)
const rateLimit = (() => {
  if (!rateLimitMatch) return null
  const win = (rateLimitMatch[1].match(/windowMs:\s*([0-9*\s]+)/) || [])[1]
  const max = (rateLimitMatch[1].match(/max:\s*(\d+)/) || [])[1]
  if (!win || !max) return null
  const ms = win.split('*').map((s) => Number(s.trim())).reduce((a, b) => a * b, 1)
  return { ms, max }
})()
const corsSrc = exists('server/src/lib/corsOrigin.js') ? read('server/src/lib/corsOrigin.js') : ''

out.server = {
  sourceFiles: listFiles('server/src', '.js').length,
  functionHandlers: allFns.length,
  libModules: ls('server/src/lib').filter((f) => f.endsWith('.js')).length,
  mounts,
  rateLimit: rateLimit ? `${rateLimit.max} requests / ${rateLimit.ms / 1000}s across /api` : 'none',
  cors: corsSrc
    ? `default ${(corsSrc.match(/DEFAULT_CORS_ORIGIN = '([^']+)'/) || [])[1]}; wildcard disables credentials: ${/credentials: !wildcard/.test(corsSrc)}`
    : 'not extracted',
  functions: {
    public: publicFns,
    admin: adminFns,
    authenticated: allFns.filter((f) => !publicFns.includes(f) && !adminFns.includes(f)).length,
    total: allFns.length,
  },
}

// ── data ────────────────────────────────────────────────────────────────────
const schema = read('server/prisma/schema.prisma')
const models = [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1])
const sqlFiles = ls('server/prisma').filter((f) => f.endsWith('.sql'))
const selfdevSql = sqlFiles.filter((f) => /^selfdev-/.test(f))
const bootstrap = 'server/prisma/manual-supabase-init.sql'
const bootstrapTables = exists(bootstrap)
  ? [...read(bootstrap).matchAll(/^\s*create table\s+"?([A-Za-z0-9_]+)"?/gim)].length
  : 0

out.data = {
  models: models.length,
  hasMigrationsDirectory: exists('server/prisma/migrations'),
  sqlMigrations: sqlFiles.length,
  autoApplied: selfdevSql.length,
  handRun: sqlFiles.length - selfdevSql.length,
  bootstrapTables,
  bootstrapMatchesSchema: bootstrapTables === models.length,
  deckModels: models.filter((m) => m.startsWith('Deck')).length,
}

// ── command deck ────────────────────────────────────────────────────────────
// morpheus-deck used to carry a hand-written "shipped" list. That is pure
// status, it rots daily, and it is fully derivable — so it is derived.
const deckWidgetsSrc = exists('src/pages/CommandDeck/deckWidgets.js')
  ? read('src/pages/CommandDeck/deckWidgets.js')
  : ''
out.deck = {
  functionFiles: ls('server/src/functions').filter((f) => /deck|jarvis/i.test(f)),
  models: models.filter((m) => m.startsWith('Deck')),
  pages: ls('src/pages/CommandDeck').filter((f) => f.endsWith('.jsx')),
  widgetCount: (deckWidgetsSrc.match(/key:\s*'/g) || []).length,
  hasSynthesisCard: exists('server/src/functions/runJarvisSynthesis.js'),
  hasVaultCheck: exists('server/src/functions/checkDeckVault.js'),
  hasMemory: exists('server/src/lib/deckMemory.js'),
}

// ── frontend ────────────────────────────────────────────────────────────────
const app = read('src/App.jsx')
const adminBlock = app.match(/adminOnly\s*\/>[\s\S]*?<\/Route>/) || app.match(/adminOnly[\s\S]{0,2000}/)
const routes = [...app.matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1])
const adminRoutes = adminBlock ? [...adminBlock[0].matchAll(/<Route\s+path="([^"]+)"/g)].map((m) => m[1]) : []

// Line comments are stripped first: eslint.config.js explains itself in prose
// that contains quoted strings (e.g. \"Definition for rule ... was not found\"),
// and without this the parser collected a sentence as if it were a glob.
const eslintCfg = read('eslint.config.js').replace(/\/\/[^\n]*/g, '')
const filesBlock = eslintCfg.match(/files:\s*\[([\s\S]*?)\]/)
const lintFiles = filesBlock ? [...filesBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []
const ignoresBlock = eslintCfg.match(/ignores:\s*\[([^\]]*)\]/)
const lintIgnores = ignoresBlock ? [...ignoresBlock[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : []

out.frontend = {
  routes: routes.length,
  adminOnlyRoutes: adminRoutes,
  lintCovers: lintFiles,
  lintIgnores,
}

// ── surfaces ────────────────────────────────────────────────────────────────
// Where the operator actually SEES Morpheus, derived so it cannot drift.
//
// This section exists because of a real miss (2026-09-22). Asked to fix "the SEO
// tab in the WordPress plugin", a session went to wp-plugin/ — which ships no
// interface at all — because two unrelated things share the word "plugin":
//
//   public/plugin.js   the dock loader MORPHEUS serves, which drops the panel on
//                      the operator's own site (admin-only by gating the tag)
//   wp-plugin/         the WordPress plugin, which answers signed requests
//
// The second fact worth never re-learning: the dock and the app's WEBSITE panel
// mount the SAME tab components, so a fix in one is a fix in both — true only
// while nobody forks them, which is what section 11 of verify-context.mjs holds.
const panelSrc = read('src/components/matrix/WebsitePanel.jsx')
const embedSrc = read('src/pages/Embed.jsx')
const dockSrc = read('public/plugin.js')
const tabComponents = (src) => [...src.matchAll(/from\s+'[^']*\/website\/(\w+)'/g)].map((m) => m[1])
const panelTabCmp = tabComponents(panelSrc)
const embedTabCmp = tabComponents(embedSrc)
const pluginAssets = walkFiles('wp-plugin/morpheus').filter((f) => /\.(js|css)$/.test(f))
out.surfaces = {
  panelTabs: [...panelSrc.matchAll(/\{\s*id:\s*'([a-z]+)',\s*label:/g)].map((m) => m[1]),
  embedTabs: [...embedSrc.matchAll(/scope:\s*'([a-z]+)',\s*id:\s*'([a-z]+)'/g)].map((m) => `${m[2]} (${m[1]})`),
  sharedTabs: embedTabCmp.filter((t) => panelTabCmp.includes(t)).sort(),
  panelOnlyTabs: panelTabCmp.filter((t) => !embedTabCmp.includes(t)).sort(),
  embedPath: /\/embed\?/.test(dockSrc) ? '/embed' : null,
  pluginVersion: (read('wp-plugin/morpheus/morpheus.php').match(/MORPHEUS_VERSION',\s*'([^']+)'/) || [])[1] || '?',
  pluginAssets: pluginAssets.length,
}

// ── verification ────────────────────────────────────────────────────────────
const ci = exists('.github/workflows/ci.yml') ? read('.github/workflows/ci.yml') : ''
// Scope to the jobs: block. Taking every 2-space key matched pull_request: and
// push: from the `on:` block as if they were jobs.
const jobsBlock = (ci.split(/^jobs:\s*$/m)[1] || '').split(/^\S/m)[0] || ''
const jobs = [...jobsBlock.matchAll(/^ {2}([a-z][\w-]*):/gm)].map((m) => m[1])
const verifyScripts = listFiles('scripts', '.mjs').filter((f) => /verify-/.test(f))
const assertionCounts = {}
for (const s of verifyScripts) {
  const src = read(s)
  assertionCounts[s] = (src.match(/\bcheck\(/g) || []).length
}

out.verification = {
  ciTriggers: [...ci.matchAll(/^ {2}(pull_request|push):/gm)].map((m) => m[1]),
  ciJobs: jobs,
  scripts: verifyScripts,
  assertions: assertionCounts,
  tests: listFiles('.', '.test.js').length,
}

// ── skills ──────────────────────────────────────────────────────────────────
out.skills = ls('.dsh/skills')
  .filter((d) => exists(`.dsh/skills/${d}/SKILL.md`))
  .map((d) => {
    const t = read(`.dsh/skills/${d}/SKILL.md`)
    const desc = (t.match(/^description:\s*"?([^"\n]+)"?/m) || [])[1] || ''
    return { name: d, lines: t.split('\n').length, description: desc.slice(0, 90) }
  })

// ── env ─────────────────────────────────────────────────────────────────────
const envExample = exists('server/.env.example') ? read('server/.env.example') : ''
out.env = {
  keys: [...envExample.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]),
}

// ── extraction sanity ───────────────────────────────────────────────────────
// A parser that silently returns nothing is worse than one that fails: the
// first run of this script reported "rate limit: none" for a server that
// plainly had one, and "lint covers" swallowed a sentence out of a comment.
// If the source contains a thing, the report must have found it.
const sanity = []
if (index.includes('rateLimit(') && !rateLimit) sanity.push('index.js has rateLimit(...) but none was extracted')
if (ci.includes('jobs:') && jobs.length === 0) sanity.push('ci.yml has a jobs: block but no jobs were extracted')
if (eslintCfg.includes('files:') && lintFiles.length === 0) sanity.push('eslint.config.js has files:[] but no patterns were extracted')
if (models.length === 0) sanity.push('schema.prisma has no models')
if (allFns.length === 0) sanity.push('no function handlers found')
if (deckWidgetsSrc && out.deck.widgetCount === 0) sanity.push('deckWidgets.js has entries but none were extracted')
if (sanity.length) {
  console.error('\nCONTEXT EXTRACTION FAILED — the report would be wrong:\n')
  for (const s of sanity) console.error('  - ' + s)
  console.error('\nFix the parser before trusting any of this.\n')
  process.exit(1)
}

// ── render ──────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify(out, null, 2))
  process.exit(0)
}

const H = (s) => `\n${s}\n${'-'.repeat(s.length)}`
console.log('MORPHEUS CONTEXT — read from the code, not remembered')
console.log('regenerate: node scripts/context.mjs          (--json for machine-readable)')

console.log(H('SERVER'))
console.log(`  ${out.server.sourceFiles} files · ${out.server.functionHandlers} functions · ${out.server.libModules} lib modules`)
console.log(`  mounts: ${out.server.mounts.join('  ')}`)
console.log(`  rate limit: ${out.server.rateLimit}`)
console.log(`  cors: ${out.server.cors}`)
console.log(`  function gates:`)
console.log(`    public (${publicFns.length}): ${publicFns.join(', ')}`)
console.log(`    admin (${adminFns.length}): ${adminFns.join(', ')}`)
console.log(`    authenticated: ${out.server.functions.authenticated}`)

console.log(H('DATA'))
console.log(`  ${out.data.models} models · ${out.data.sqlMigrations} *.sql migrations (${out.data.autoApplied} auto-applied, ${out.data.handRun} hand-run)`)
console.log(`  server/prisma/migrations/ exists: ${out.data.hasMigrationsDirectory}`)
console.log(`  bootstrap SQL: ${out.data.bootstrapTables} tables (matches schema: ${out.data.bootstrapMatchesSchema})`)
console.log(`  Deck models: ${out.data.deckModels}`)

console.log(H('COMMAND DECK'))
console.log(`  ${out.deck.functionFiles.length} deck/jarvis functions · ${out.deck.models.length} Deck models · ${out.deck.pages.length} pages · ${out.deck.widgetCount} widgets`)
console.log(`  synthesis card: ${out.deck.hasSynthesisCard} · vault check: ${out.deck.hasVaultCheck} · long-term memory: ${out.deck.hasMemory}`)
console.log(`  functions: ${out.deck.functionFiles.join(', ')}`)

console.log(H('SURFACES'))
console.log(`  app panel        src/components/matrix/WebsitePanel.jsx   tabs: ${out.surfaces.panelTabs.join(', ')}`)
console.log(`  dock / embed     public/plugin.js -> ${out.surfaces.embedPath} -> src/pages/Embed.jsx   tabs: ${out.surfaces.embedTabs.join(', ')}`)
console.log('                   (the dock is what the operator sees logged into wp-admin, over their own site;')
console.log('                    its tabs are gated by the widget token\'s scopes, so a missing tab is a missing scope)')
console.log(`  wordpress plugin wp-plugin/morpheus v${out.surfaces.pluginVersion}   ${out.surfaces.pluginAssets === 0
  ? 'no JS/CSS — headless: pairing + signed endpoints + the on-site work'
  : `${out.surfaces.pluginAssets} JS/CSS asset(s)`}`)
console.log(`  command deck     /deck   (see COMMAND DECK above)`)
console.log(`  app panel only   ${out.surfaces.panelOnlyTabs.join(', ')}`)
console.log(`  BOTH surfaces    ${out.surfaces.sharedTabs.join(', ')}   <- one component, so one fix`)
console.log('  naming trap      public/plugin.js is the dock loader Morpheus serves; wp-plugin/ is the')
console.log('                   WordPress plugin. Unrelated files, unrelated jobs.')

console.log(H('FRONTEND'))
console.log(`  ${out.frontend.routes} routes · adminOnly: ${out.frontend.adminOnlyRoutes.join(', ') || 'none'}`)
console.log(`  lint covers: ${out.frontend.lintCovers.join('  ')}`)
console.log(`  lint ignores: ${out.frontend.lintIgnores.join('  ')}`)

console.log(H('VERIFICATION'))
console.log(`  CI on: ${out.verification.ciTriggers.join(', ')} · jobs: ${out.verification.ciJobs.join(', ')}`)
console.log(`  test files: ${out.verification.tests}`)
for (const [s, n] of Object.entries(out.verification.assertions)) console.log(`  ${s}: ~${n} assertions`)

console.log(H(`SKILLS (${out.skills.length})`))
for (const s of out.skills) console.log(`  ${s.name.padEnd(24)} ${String(s.lines).padStart(4)} lines  ${s.description}`)

console.log(H('ENV'))
console.log(`  ${out.env.keys.length} keys in server/.env.example`)
console.log('')
