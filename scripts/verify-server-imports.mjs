// Assert every relative import in the server tree actually resolves.
//
// WHY THIS EXISTS — the 2026-09-19 production outage
//
// server/src/lib/deckInsightSchedule.js was created by mirroring
// server/src/freshnessSchedule.js, and the import was copied verbatim as
// `./queue.js`. That is correct from src/, but this file lives in src/lib/, so
// it resolves to src/lib/queue.js — which does not exist. index.js imports the
// schedule at boot, so the container died at module load and Northflank served
// "no healthy upstream" for the whole API until it was found.
//
// Nothing in the pipeline could see it:
//   - CI's guards job runs `node --check`, which validates SYNTAX and never
//     resolves an import specifier.
//   - `npm run lint` does not resolve them either.
//   - The unit/integration tests imported deckInsight.js directly, so they
//     never loaded deckInsightSchedule.js and never touched the bad edge.
//   - It resolves on a case-insensitive filesystem only by accident; here the
//     file genuinely did not exist, so nothing local was ever exercised either.
// A one-character path error took down production and every gate was green.
//
// This is the missing gate. Dependency-free, so it runs in CI's no-install
// guards job. Run:  node scripts/verify-server-imports.mjs
//
// It also checks CASE exactly. macOS is case-insensitive, the Alpine container
// is not, so `./DeckMemory.js` for `deckMemory.js` would work locally and fail
// in production — the same failure with a harder-to-spot cause.
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_DIRS = ['server/src', 'server/scripts'];

let failures = 0;
let checked = 0;

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(m?js)$/.test(entry)) out.push(full);
  }
  return out;
}

// Imports are matched only at the START of a line, because that is how ESM
// import statements are actually written here. Matching anywhere in the file
// produced two false positives on the first run, both text rather than code:
// a generated config file's own comment inside wireFrontendToBackend.js's
// template literal, and prompt prose inside mac-app.js's aiNotes block. A
// resolution checker that cries wolf gets switched off.
//
//   import x from './y.js'   import './y.js'   await import('./y.js')
const STATIC_IMPORT = /^[ \t]*import\s+(?:[^'"\n]*\sfrom\s+)?['"](\.[^'"]+)['"]/gm;
const DYNAMIC_IMPORT = /^[ \t]*(?!\/\/)[^'"\n]*\bimport\(\s*['"](\.[^'"]+)['"]/gm;

// Exact-case existence: every path segment must appear in its parent directory
// with precisely this spelling. existsSync alone would pass on macOS for a
// case-wrong path that fails on the Linux container.
function existsWithExactCase(absPath) {
  if (!existsSync(absPath)) return false;
  let cursor = '/';
  for (const segment of absPath.split('/').filter(Boolean)) {
    let entries;
    try {
      entries = readdirSync(cursor);
    } catch {
      return false;
    }
    if (!entries.includes(segment)) return false;
    cursor = join(cursor, segment);
  }
  return true;
}

console.log('\nServer relative imports — resolution verification\n');

const files = SCAN_DIRS.flatMap((d) => walk(resolve(ROOT, d)));
console.log(`  scanning ${files.length} file(s) in ${SCAN_DIRS.join(', ')}\n`);

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const matches = [...source.matchAll(STATIC_IMPORT), ...source.matchAll(DYNAMIC_IMPORT)];
  for (const match of matches) {
    checked++;
    const specifier = match[1];
    const target = resolve(dirname(file), specifier);
    const rel = relative(ROOT, file);
    if (!existsWithExactCase(target)) {
      failures++;
      const line = source.slice(0, match.index).split('\n').length;
      console.log(`  FAIL  ${rel}:${line}\n          ${specifier} does not resolve (looked for ${relative(ROOT, target)})`);
    }
  }
}

// ── Named exports ────────────────────────────────────────────────────────────
//
// The check above resolves the PATH and nothing else, and on 2026-09-25 that
// gap shipped a production outage: runAiAction.js gained
// `import { buildReviewPrompt, REVIEW_SCHEMA, REVIEW_STEP_MAX_TOKENS } from
// '../lib/reviewer.js'` while only REVIEW_SCHEMA was exported. The path
// resolved, node --check saw a syntactically perfect file, lint was clean, and
// this guard was green — but ESM fails at LINK time, so importing runAiAction
// threw and every task on it 500'd, including the deployed Wikidata uploader's
// schema_mapping. Same shape as the 2026-09-19 outage (a broken edge nothing
// exercised): a missing NAME instead of a missing path, and three gates blind
// to it.
//
// A name is treated as exported when it is declared with `export`, listed in an
// `export { … }` clause, or destructured out of an `export const { … }`. A
// module that re-exports (`export * from`) or is CommonJS is treated as OPAQUE
// and skipped: this check must never cry wolf, because a resolution checker that
// does gets switched off.
//
// Known limit, deliberately accepted: a name exported only from inside a
// one-line block comment is read as exported (whole-line `//` comments are
// stripped, block comments are not — see verify-ai-roles.mjs for why stripping
// block comments is itself unsafe). That direction is a miss, never a false
// alarm.
const NAMED_IMPORT = /^[ \t]*import\s*\{([^}]*)\}\s*from\s*['"](\.[^'"]+)['"]/gm;
const codeOnly = (s) => s.replace(/^[ \t]*\/\/.*$/gm, ' ');

function exportedNames(source) {
  const src = codeOnly(source);
  const names = new Set();
  for (const m of src.matchAll(/^[ \t]*export\s+(?:async\s+)?(?:function|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) {
    names.add(m[1]);
  }
  for (const m of src.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1].split(',')) {
      const t = part.trim();
      if (!t) continue;
      const as = t.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  for (const m of src.matchAll(/^[ \t]*export\s+(?:const|let|var)\s*\{([^}]*)\}/gm)) {
    for (const p of m[1].split(',')) {
      const t = p.trim().split(':').pop().trim();
      if (t) names.add(t);
    }
  }
  const opaque = /^[ \t]*export\s+\*/m.test(src)
    || /\bmodule\.exports\b|^[ \t]*exports\./m.test(src);
  return { names, opaque };
}

// Self-test: a checker that cannot detect the bug it exists for is not a pass.
{
  const good = exportedNames('export const A = 1;\nexport function b() {}\n');
  const withStar = exportedNames("export * from './x.js';\n");
  const cjs = exportedNames('module.exports = { a: 1 };\n');
  if (!good.names.has('A') || !good.names.has('b') || good.opaque
      || !withStar.opaque || !cjs.opaque) {
    console.log('  FAIL  the named-export checker does not work (self-test)');
    process.exit(1);
  }
}

let nameChecked = 0;
let nameFailures = 0;
for (const file of files) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(NAMED_IMPORT)) {
    const specifier = match[2];
    const target = resolve(dirname(file), specifier);
    if (!existsWithExactCase(target) || !/\.m?js$/.test(target)) continue;
    const { names, opaque } = exportedNames(readFileSync(target, 'utf8'));
    if (opaque) continue;
    for (const raw of match[1].split(',')) {
      const t = raw.trim();
      if (!t) continue;
      const imported = t.split(/\s+as\s+/)[0].trim();
      if (!imported) continue;
      nameChecked++;
      if (!names.has(imported)) {
        nameFailures++;
        failures++;
        const line = source.slice(0, match.index).split('\n').length;
        console.log(`  FAIL  ${relative(ROOT, file)}:${line}\n          '${imported}' is imported from ${specifier} but is not exported by ${relative(ROOT, target)}`);
      }
    }
  }
}
console.log(`  ${nameChecked} named import(s) checked against their module's exports, ${nameFailures} missing\n`);

// A specifier that reaches outside the server tree (e.g. a shared/ module) is
// legitimate, but one pointing at a directory rather than a file is not: ESM
// has no directory/index resolution, so it fails at load in production.
console.log(`\n${checked} relative import(s) checked, ${failures} broken`);
if (failures) {
  console.log('\nFAILED — this is the class that took production down on 2026-09-19 (a');
  console.log('missing path) and again on 2026-09-25 (a missing named export). ESM fails');
  console.log('at LINK time: the file parses, lint passes, and the import still throws.\n');
  process.exit(1);
}
console.log('all good\n');