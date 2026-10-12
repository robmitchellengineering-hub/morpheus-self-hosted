// Every relative import in the shipped tree must resolve to a shipped file.
//
// WHY THIS EXISTS — the general debt PR #629 recorded and did not build, generalised out of `src/`.
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
// That guard shipped walking `src/**` only, and the same bug class survived one directory over — in the
// tree the bundle ships *because* it is the thing a self-hoster runs to check the install:
// `scripts/verify-cloud-metering.mjs` imports `../hosted-broker/src/metering.js`, and `hosted-broker/`
// was not in the ship list, so the suite the bundle advertises could not load. A guard that walks one
// shipped directory structurally cannot see a missing import in another, which is why the walk here is
// the WHOLE shipped tree, derived from the bundle's own roots rather than a second list to keep in step.
//
// A whitelist review will not catch a missing shipped import — only an assertion will. The rule it reads
// is the SAME source of truth the bundle builder uses: `isPortableFile` (with the root and file lists)
// from server/src/lib/portableBundle.js, which is import-free so this runs in CI's no-install guards job.
// The guard and the builder therefore cannot drift apart: add a shipped directory and this walks it.
//
// WHAT THIS DOES NOT COVER: a shipped file that READS an unshipped path (`readFileSync`, a fixture path)
// rather than importing it. That is the same class of omission — the shipped suite references files the
// bundle does not carry — but it is not an import, so nothing here will see it; it needs its own guard.
//
// Dependency-free. Run:  node scripts/verify-shipped-imports.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPortableFile, PORTABLE_INCLUDE_ROOTS, PORTABLE_INCLUDE_FILES,
} from '../server/src/lib/portableBundle.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
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
// A string/comment/regex-aware scanner, not a regex, because the repo writes imports across lines:
//
//   import {
//     COMPONENTS, DEFAULT_COMPONENTS, getServiceOption, hasCredentials,
//   } from '../../../base44/shared/infrastructureComponents';
//
// and this repo's own guards are full of STRING fixtures whose text is a real import statement
// (`content: "import x from '../lib/github.js'"`). A regex that matches `from '…'` anywhere reads that
// fixture as a real import and cries wolf; a single-line `^import` regex misses the multi-line import
// and reports nothing (which is worse — a checker that examined nothing reads as a pass). The scanner
// walks the file once, skipping string, comment and regex-literal contents, and only recognises
// `import` / `from` / `require` as keywords when they sit in real code.
//
// REGEX LITERALS ARE SKIPPED FOR A REASON, and it is not tidiness. Walking the whole shipped tree (as
// opposed to `src/` only) reaches this repo's own guards, which are full of regexes carrying a quote —
// `m[1].replace(/'/g, '"')` in scripts/verify-review-context.mjs. A scanner that treats the `'` inside
// that regex as a string opener flips its quote parity: the closing quote of the regex becomes an
// OPENING quote, the string FIXTURES later in the file are then read as real code, and the guard fails
// on a healthy tree with four imports that do not exist (`../lib/doesNotExist.js` among them). The
// fix is the standard `/` heuristic — a slash is a regex when the token before it cannot end an
// expression — with a bail-out if no closing slash appears before the newline, so a misread division
// cannot swallow real code.
const REGEX_MAY_FOLLOW = new Set([
  '', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '~', '^', '<', '>',
]);
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await',
]);

function relativeSpecifiers(source) {
  const specs = new Set();
  let i = 0;
  const n = source.length;
  // The last significant code character and word, which is what decides division from regex. They are
  // only ever set on the code path, never inside a string or comment.
  let prev = '';
  let prevWord = '';
  const setPrev = (ch, word = '') => { prev = ch; prevWord = word; };

  while (i < n) {
    const c = source[i];
    if (c === '/' && source[i + 1] === '/') { while (i < n && source[i] !== '\n') i++; continue; }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '/' && (prev === '' || REGEX_MAY_FOLLOW.has(prev) || REGEX_KEYWORDS.has(prevWord))) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = source[j];
        if (d === '\\') { j += 2; continue; }
        if (d === '\n') break;                       // a regex literal cannot span a line
        if (inClass) { if (d === ']') inClass = false; j++; continue; }
        if (d === '[') { inClass = true; j++; continue; }
        if (d === '/') { closed = true; j++; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(source[j])) j++; // flags
        i = j;
        setPrev('/');
        continue;
      }
      i++;                                           // no closing slash: it was division
      setPrev('/');
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      i++;
      while (i < n && source[i] !== q) { if (source[i] === '\\') i++; i++; }
      i++;
      setPrev(q);
      continue;
    }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[A-Za-z0-9_$]/.test(source[j])) j++;
      const word = source.slice(i, j);
      if (word === 'import' || word === 'from' || word === 'require') {
        let k = j;
        while (k < n && /\s/.test(source[k])) k++;
        if (word === 'import' && source[k] === '.') { setPrev(source[j - 1], word); i = j; continue; } // import.meta
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
      setPrev(source[j - 1], word);
      i = j;
      continue;
    }
    setPrev(c);
    i++;
  }
  return [...specs];
}

// The scanner is the part that can silently break, so it is proven before it judges anything. These
// fixtures are the exact shapes the real tree contains: a multi-line named import, a side-effect
// import, a dynamic import, `import type`, `import.meta`, a regex literal carrying a quote and a
// division (which must not flip the scanner's state), and the false positives that must NOT match
// (a string fixture and a comment quoting import syntax).
{
  const FIXTURE = [
    "import {\n  COMPONENTS, DEFAULT_COMPONENTS,\n} from '../../../base44/shared/infrastructureComponents';",
    "import './theme.css';",
    "const m = await import('./lazy-chunk.jsx');",
    "import type { Shape } from './types.js';",
    "import.meta.url",
    "const s = \"from './not-a-real-import.js'\";",
    "// import './also-not-real.js'",
    "const cleaned = raw.replace(/'/g, '\"');",
    "const half = total / 2;",
    "import real from './after-a-regex.js';",
    "const after = \"from './still-not-real.js'\";",
  ].join('\n');
  const found = relativeSpecifiers(FIXTURE);
  check('the scanner sees a multi-line named import',
    found.includes('../../../base44/shared/infrastructureComponents'), true);
  check('…and a side-effect import', found.includes('./theme.css'), true);
  check('…and a dynamic import', found.includes('./lazy-chunk.jsx'), true);
  check('…and an `import type` specifier', found.includes('./types.js'), true);
  check('…and a real import after a regex carrying a quote AND a division',
    found.includes('./after-a-regex.js'), true);
  check('…and ignores a string that merely quotes import syntax',
    found.includes('./not-a-real-import.js'), false);
  check('…and ignores a comment quoting import syntax', found.includes('./also-not-real.js'), false);
  check('…and still ignores a string fixture AFTER a regex and a division',
    found.includes('./still-not-real.js'), false);
  check('…and import.meta adds nothing', found.length, 5);
}

// The rule is the live include list, so assert it is really live before trusting it: the module must
// still ship base44/shared (the #629 fix) and the broker the shipped verification suite imports (this
// change), and still refuse the pre-port functions tree.
check('the rule ships base44/shared (the #629 fix)',
  isPortableFile('base44/shared/infrastructureComponents'), true);
check('…and ships the broker the shipped verification suite imports',
  isPortableFile('hosted-broker/src/metering.js'), true);
check('…and still refuses the superseded base44/functions tree',
  isPortableFile('base44/functions/autonomousBuildStep/entry.ts'), false);

// ── walk the whole shipped tree ──────────────────────────────────────────────
//
// Derived from the bundle's own rule, never from a second list here. `couldShip` is what lets the walk
// descend through `hosted-broker/` to the one shipped part inside it: `isPortableFile('hosted-broker/')`
// is false while `isPortableFile('hosted-broker/src/')` is true, so pruning on the directory itself
// would silently skip the exact tree this guard was generalised to cover.
const SHIPPED = [...PORTABLE_INCLUDE_ROOTS, ...PORTABLE_INCLUDE_FILES];
const couldShip = (relDir) => isPortableFile(relDir) || SHIPPED.some((p) => p.startsWith(relDir));

function walkShipped(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    const rel = relative(ROOT, full).split(sep).join('/');
    if (e.isDirectory()) {
      if (couldShip(`${rel}/`)) walkShipped(full, out);
    } else if (e.isFile() && isPortableFile(rel)) {
      out.push({ full, rel });
    }
  }
  return out;
}

const shippedFiles = walkShipped(ROOT);
const sourceFiles = shippedFiles.filter(({ rel }) => SOURCE_EXT.test(rel));
const srcFiles = sourceFiles.filter(({ rel }) => rel.startsWith('src/'));
const scriptFiles = sourceFiles.filter(({ rel }) => rel.startsWith('scripts/'));

// Parser sanity per shipped tree, not just in total: a walk that dropped `scripts/` would otherwise
// still pass on the strength of `src/` alone and read as "all shipped" (H17).
check('the shipped frontend was walked (parser sanity)', srcFiles.length > 100, true);
check('the shipped verification suite was walked (parser sanity)', scriptFiles.length > 100, true);

// Every relative specifier the walk actually examined, recorded so the anti-H17 guardrails below can
// prove the walk SAW the known cross-tree imports rather than merely that the file existed.
const examined = new Set();
const escapes = [];

console.log(`\nrelative imports in the shipped tree that resolve outside it:\n`);
for (const { full, rel } of sourceFiles) {
  const source = readFileSync(full, 'utf8');
  for (const spec of relativeSpecifiers(source)) {
    const resolved = normalize(resolve(dirname(full), spec));
    const target = relative(ROOT, resolved).split(sep).join('/');
    examined.add(`${rel} → ${target}`);
    if (isPortableFile(target)) {
      continue; // the import travels with the importer
    }
    escapes.push(`${rel} → ${target}`);
    failures++;
    console.log(`  FAIL  ${rel}\n          ${spec}  →  ${target} is NOT shipped`);
  }
}

// The anti-H17 guardrails: a scanner or walk regression that examines nothing must not read as "all
// shipped". Both trees' known cross-tree imports have to have been SEEN by this run.
check('the walk followed the frontend\'s cross-tree import (the #629 case)',
  examined.has('src/components/matrix/BackendPanel.jsx → base44/shared/infrastructureComponents'), true);
check('…and the shipped suite\'s (the gap this change closes)',
  examined.has('scripts/verify-cloud-metering.mjs → hosted-broker/src/metering.js'), true);

console.log(`\n${examined.size} relative import(s) examined across ${sourceFiles.length} shipped source files, ` +
  `${escapes.length === 0 ? 'all shipped' : `${escapes.length} resolving outside the bundle`}`);
console.log(`${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a shipped file imports something the bundle does not ship.');
  console.log('    A rule that ships an importer has to ship the import — add the target to the bundle,');
  console.log('    or the verification suite (or the download\'s build) cannot run.\n');
  process.exit(1);
}
console.log('every relative import in the shipped tree resolves to a shipped file\n');
