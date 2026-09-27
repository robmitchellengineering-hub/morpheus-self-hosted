// Runtime verification that every source file is actually LINTED.
//
// Dependency-free (it parses eslint.config.js and walks the tree), so it runs in CI's no-install
// guards job. Run:  node scripts/verify-lint-coverage.mjs
//
// Why this exists, and why it is a guard rather than a comment. This repo's eslint.config.js
// already carries three apologies for the same failure — "src/hooks was missing from this list, so
// the react-hooks plugin was never registered for those files"; "Siblings of the same gap: these
// directories matched no config block either, so nothing inside them was linted at all"; and then
// server/** had no block at all, which is how `chunkOps is not defined` shipped and killed every
// code build (2026-09-27, `#362`-`#363`). On 2026-09-28 the same gap was still there twice more:
// `src/main.jsx` matched no block, and `src/lib/**` was ignored outright — so the entry point and
// every module in src/lib (including real logic like staleChunk.js) had never been linted.
//
// A file that matches no config block is not "clean", it is UNCHECKED, and ESLint reports that as
// an info line nobody fails on. This walks the source tree and fails on it.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

const root = new URL('..', import.meta.url).pathname;
const configPath = join(root, 'eslint.config.js');

// Read the config as text rather than importing it: importing would need its plugins installed, and
// this guard runs in the job that deliberately installs nothing.
const config = readFileSync(configPath, 'utf8');

// Collect the `files:` globs and the `ignores:` globs. Both are written as array literals of
// strings in this config; anything more exotic than that is a change this guard should notice.
function patternsAfter(label) {
  const found = [];
  const re = new RegExp(`${label}:\\s*\\[([\\s\\S]*?)\\]`, 'g');
  for (const m of config.matchAll(re)) {
    for (const str of m[1].matchAll(/'([^']+)'|"([^"]+)"/g)) {
      const value = str[1] || str[2];
      // A quoted string inside a comment in the array (this config has one) is not a pattern.
      if (/^[\w./*{},-]+$/.test(value)) found.push(value);
    }
  }
  return found;
}
const fileGlobs = patternsAfter('files');
const ignoreGlobs = patternsAfter('ignores');

// A minimal glob → RegExp, for the two shapes this config uses: `dir/**/*.{a,b}` and an exact path.
//
// `**/` is substituted through a placeholder: expanding it to a literal `*` first means the
// single-`*` rule immediately below rewrites that `*` too, and the matcher silently degrades to one
// directory level — which made THIS guard report a dozen covered files as uncovered on its first
// run. The bug was in the guard, not the repo, and only a fake-vs-real check catches that.
function globToRegExp(glob) {
  const escape = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const body = (s) => escape(s)
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:[^/]*/)*');
  const brace = glob.match(/^(.*)\{([^}]+)\}$/);
  if (brace) return new RegExp(`^${body(brace[1])}(?:${brace[2].split(',').join('|')})$`);
  return new RegExp(`^${body(glob)}$`);
}
const fileRes = fileGlobs.map(globToRegExp);
const ignoreRes = ignoreGlobs.map(globToRegExp);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(js|mjs|cjs|jsx)$/.test(entry)) out.push(relative(root, full));
  }
  return out;
}

const sources = [...walk(join(root, 'src')), ...walk(join(root, 'server', 'src'))];
const uncovered = sources.filter((f) => !fileRes.some((re) => re.test(f)) && !ignoreRes.some((re) => re.test(f)));
const ignored = sources.filter((f) => ignoreRes.some((re) => re.test(f)));

console.log('\n1. the config was understood');
check('file globs were found', fileGlobs.length > 0, true);
// If this ever reads zero the guard would pass everything, which is the failure mode of every
// coverage check: a check that cannot run is not a pass.
check('the source walk found files', sources.length > 100, true);

console.log('\n2. no source file escapes lint');
check('every src/ and server/src/ file matches a config block', uncovered.join(', '), '');

console.log('\n3. the specific files that were unchecked are covered');
for (const f of ['src/main.jsx', 'src/lib/staleChunk.js', 'src/lib/deckInsightPayload.js', 'server/src/ai.js']) {
  check(`${f} is linted`, fileRes.some((re) => re.test(f)), true);
}

console.log('\n4. what is deliberately ignored is only ever UI kit');
// Not a rule about taste: an ignored directory is an unlinted one, so it has to be a decision
// somebody can see. `src/components/ui/**` is generated kit; anything else added here needs to be
// argued for in this list.
check('the ignore list is exactly the generated UI kit',
  [...new Set(ignored.map((f) => f.split('/').slice(0, 3).join('/')))].join(', '),
  'src/components/ui');

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) { console.log(`${failures} FAILED\n`); process.exit(1); }
console.log('all good\n');
