// Every relative import in the shipped frontend that leaves `src/` must resolve to a shipped file.
//
// WHY THIS EXISTS — the general debt PR #629 recorded and did not build.
//
// #629 fixed the Portable Morpheus download by shipping `base44/shared/`, because
// `src/components/matrix/BackendPanel.jsx` imports `base44/shared/infrastructureComponents` and the
// bundle excluded `base44/` wholesale — so the published download failed its own build with
// `Could not resolve "../../../base44/shared/infrastructureComponents"`. At the time the guard owed was
// written down and never built:
//
//   "a guard that walks shipped `src/**` for relative imports leaving `src/` and asserts each resolves
//   to a shipped file."
//
// A whitelist review will not catch a missing shipped import — only an assertion will. The bundle ships
// `src/` in full (see server/src/lib/portableBundle.js), so anything a shipped `src/**` file imports
// that lives OUTSIDE `src/` must be shipped too, or the download cannot build. This walks the real
// imports rather than a hand-written list, so the next omission is a red check instead of a stranger's
// afternoon.
//
// The rule it reads is the SAME source of truth the bundle builder uses: `isPortableFile` from
// server/src/lib/portableBundle.js, which is import-free so this runs in CI's no-install guards job.
// The guard and the builder therefore cannot drift apart.
//
// Dependency-free. Run:  node scripts/verify-shipped-src-imports.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPortableFile } from '../server/src/lib/portableBundle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');
const SOURCE_EXT = /\.(js|jsx|mjs|ts|tsx)$/;

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

// ── specifier extraction ─────────────────────────────────────────────────────
//
// A string/comment-aware scanner, not a regex, because the frontend writes imports across lines:
//
//   import {
//     COMPONENTS, DEFAULT_COMPONENTS, getServiceOption, hasCredentials,
//   } from '../../../base44/shared/infrastructureComponents';
//
// and this repo's own guards are full of STRING fixtures whose text is a real import statement
// (`content: "import x from '../lib/github.js'"`). A regex that matches `from '…'` anywhere reads that
// fixture as a real import and cries wolf; a single-line `^import` regex misses the multi-line import
// and reports nothing (which is worse — a checker that examined nothing reads as a pass). The scanner
// walks the file once, skipping string and comment contents, and only recognises `import` / `from` /
// `require` as keywords when they sit in real code.
function relativeSpecifiers(source) {
  const specs = new Set();
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && source[i] !== q) { if (source[i] === '\\') i++; i++; }
      i++;
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      if (word === 'import' || word === 'from' || word === 'require') {
        let k = j;
        while (k < n && /\s/.test(source[k])) k++;
        if (word === 'import' && source[k] === '.') { i = j; continue; } // import.meta
        if (word === 'require' || (word === 'import' && source[k] === '(')) {
          if (source[k] === '(') k++;
          while (k < n && /\s/.test(source[k])) k++;
        }
        if (source[k] === '"' || source[k] === "'") {
          const q = source[k];
          k++;
          const start = k;
          while (k < n && source[k] !== q) { if (source[k] === '\\') k++; k++; }
          const spec = source.slice(start, k);
          if (spec.startsWith('.')) specs.add(spec);
        }
      }
      i = j;
      continue;
    }
    i++;
  }
  return [...specs];
}

// The scanner is the part that can silently break, so it is proven before it judges anything. These
// fixtures are the exact shapes the real tree contains: a multi-line named import, a side-effect
// import, a dynamic import, `import type`, `import.meta`, and the two false positives that must NOT
// match (a string fixture and a comment quoting import syntax).
{
  const FIXTURE = [
    "import {\n  COMPONENTS, DEFAULT_COMPONENTS,\n} from '../../../base44/shared/infrastructureComponents';",
    "import './theme.css';",
    "const m = await import('./lazy-chunk.jsx');",
    "import type { Shape } from './types.js';",
    "import.meta.url",
    "const s = \"from './not-a-real-import.js'\";",
    "// import './also-not-real.js'",
  ].join('\n');
  const found = relativeSpecifiers(FIXTURE);
  check('the scanner sees a multi-line named import',
    found.includes('../../../base44/shared/infrastructureComponents'), true);
  check('…and a side-effect import', found.includes('./theme.css'), true);
  check('…and a dynamic import', found.includes('./lazy-chunk.jsx'), true);
  check('…and an `import type` specifier', found.includes('./types.js'), true);
  check('…and ignores a string that merely quotes import syntax',
    found.includes('./not-a-real-import.js'), false);
  check('…and ignores a comment quoting import syntax', found.includes('./also-not-real.js'), false);
  check('…and import.meta adds nothing', found.length, 4);
}

// The rule is the live include list, so assert it is really live before trusting it: the module must
// still ship base44/shared (the #629 fix) and still refuse the pre-port functions tree.
check('the rule ships base44/shared (the #629 fix)',
  isPortableFile('base44/shared/infrastructureComponents'), true);
check('…and still refuses the superseded base44/functions tree',
  isPortableFile('base44/functions/autonomousBuildStep/entry.ts'), false);

// ── walk the shipped frontend ────────────────────────────────────────────────
function walk(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const f = join(dir, e);
    if (statSync(f).isDirectory()) walk(f, out);
    else out.push(f);
  }
  return out;
}

const files = walk(SRC).filter((f) => SOURCE_EXT.test(f));
check('the shipped frontend was walked (parser sanity)', files.length > 100, true);

console.log(`\nshipped src/** imports that leave src/:\n`);
let escapes = 0;
for (const file of files) {
  const rel = relative(ROOT, file);
  const source = readFileSync(file, 'utf8');
  for (const spec of relativeSpecifiers(source)) {
    const resolved = normalize(resolve(dirname(file), spec));
    const relSrc = relative(SRC, resolved);
    if (!relSrc.startsWith('..') && !relSrc.startsWith('/')) continue; // stays inside src/
    escapes++;
    const target = relative(ROOT, resolved);
    const shipped = isPortableFile(target);
    if (shipped) {
      console.log(`  PASS  ${rel}\n          ${spec}  →  ${target} (shipped)`);
    } else {
      failures++;
      console.log(`  FAIL  ${rel}\n          ${spec}  →  ${target} is NOT shipped`);
    }
  }
}

// The anti-H17 guardrail: a scanner regression that finds nothing must not read as "all shipped". The
// tree ships exactly this import today, so the walk has to have seen it.
check('the walk saw the known escape (BackendPanel → base44/shared)',
  escapes >= 1 && files.some((f) => relative(ROOT, f) === 'src/components/matrix/BackendPanel.jsx'), true);

console.log(`\n${escapes} relative import(s) in shipped src/** leave src/, ${failures === 0 ? 'all shipped' : `${failures} missing`}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a shipped src/** file imports something outside src/ that the bundle does not ship.');
  console.log('    A rule that ships an importer has to ship the import — add the target to the bundle,');
  console.log('    or the download cannot build.\n');
  process.exit(1);
}
console.log('every relative import that leaves shipped src/ resolves to a shipped file\n');
