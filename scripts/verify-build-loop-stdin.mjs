// Does the build loop close stdin on every tool it shells out to?
//
// WHY THIS EXISTS. The harness-mesh's distributed-compute traps record the incident this ports: a node loop
// started a child with stdin inherited and never closed, so a tool that decided to ask a question (`vmrun`
// wanting guest credentials) blocked for ever — and because the loop waits for that child, every queued job
// waited behind it. The fix was "close stdin at start: a prompt now gets EOF and fails fast" (KNOWN-HAZARDS
// H24, the first mesh trap enforced here).
//
// Morpheus's build loop shells out the same way: `server/src/lib/syntaxCheck.js` runs a real `python3` over
// every `.py` file, and `server/src/lib/appSelfTest.js` writes a self-test runner into each generated app
// that spawns the app's own `npm start`. A tool that reads stdin and decides to prompt — a `git` asking for
// credentials, an installer asking "proceed? [y/N]" — would hang the build, not just the one file.
//
// THE CLAIM: no subprocess spawned anywhere under `server/src/**` inherits stdin, and none is left with the
// unmanaged default pipe that a prompt could block on. A subprocess may pipe stdin ONLY as a deliberate data
// channel the parent writes and then `end()`s — which is the Python syntax check — and never as
// `stdio: 'inherit'`, `stdio: ['inherit', …]`, or a spawn with no `stdio`/`input` at all.
//
// ⚠️ IT ASSERTS THE SOURCE, NOT ITS OWN PROSE (H19). The classifier is driven with synthetic snippets in
// section 1, and the walk runs over comment-stripped source, so a spawn named in a comment proves nothing.
//
// Run:  node scripts/verify-build-loop-stdin.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// Strip comments before any source assertion — a spawn mentioned in prose is not a spawn (H19 records six
// guards satisfied by their own explanatory text).
const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');

// The child_process spawn family, longest alternation first so `spawnSync` is not read as `spawn`. The
// leading `[^\w.]` keeps regex `.exec(` method calls (which are everywhere) from being read as subprocesses.
const SPAWN_CALL = /(?:^|[^\w.])(spawnSync|spawn|execFileSync|execFile|execSync|exec|fork)\s*\(/g;

/** Recursively list `.js` files under a directory. */
function filesUnder(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) filesUnder(p, out);
    else if (name.endsWith('.js')) out.push(p);
  }
  return out;
}

/** Index just past the `)` that closes the `(` at openIndex, skipping string literals. */
function closeParen(src, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < src.length; i++) {
    const c = src[i];
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      i++;
      while (i < src.length) {
        if (src[i] === '\\') { i += 2; continue; }
        if (src[i] === q) break;
        i++;
      }
      continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') { depth--; if (depth === 0) return i + 1; }
  }
  return src.length;
}

/**
 * One violation for a spawn-family call, or null. `args` is the call's argument text (inside the parens);
 * `fileEndsStdin` is true when the file that owns the call explicitly `end()`s a stdin pipe.
 *
 * The rule, in one line: stdin is inherited → fail; stdin is the default pipe → fail; stdin is a pipe the
 * parent never ends → fail. `'ignore'`, `['ignore', …]`, `input:` and a parent-ended pipe are the only
 * shapes a prompt gets EOF from.
 */
function stdinViolation(args, fileEndsStdin) {
  const stdio = /stdio\s*:\s*('ignore'|'inherit'|'pipe'|\[[^\]]*\])/.exec(args);
  if (stdio) {
    const v = stdio[1];
    if (v === "'ignore'") return null;
    if (v === "'inherit'") return 'inherits stdin (stdio: inherit)';
    if (v === "'pipe'") return fileEndsStdin ? null : 'pipes stdin but the parent never ends it';
    const first = /\[\s*('ignore'|'inherit'|'pipe')/.exec(v);
    if (!first) return null; // an unusual array shape — refuse to guess rather than fail a good call
    if (first[1] === "'ignore'") return null;
    if (first[1] === "'inherit'") return 'inherits stdin (stdio[0]: inherit)';
    return fileEndsStdin ? null : 'pipes stdin but the parent never ends it';
  }
  if (/\binput\s*:/.test(args)) return null; // sync variants: Node writes the input and closes stdin itself
  return 'no stdin disposition — the default pipe is open, so a prompt blocks on it';
}

/** Every stdin-policy violation in one file's source. */
function violationsFor(src) {
  const c = code(src);
  const endsStdin = /\.stdin\.(?:end|destroy)\s*\(/.test(c);
  const out = [];
  let m;
  SPAWN_CALL.lastIndex = 0;
  while ((m = SPAWN_CALL.exec(c))) {
    const open = m.index + m[0].length - 1; // the '('
    const args = c.slice(open, closeParen(c, open));
    const line = c.slice(0, m.index).split('\n').length;
    const reason = stdinViolation(args, endsStdin);
    if (reason) out.push({ call: m[1], line, reason });
  }
  return out;
}

let failures = 0;
let checks = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else { console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`); failures++; }
}

console.log('\n1. the rule, on synthetic snippets (it must be able to fire — H19)');
check('a spawn with stdio: ignore is closed', violationsFor("spawn('x', [], { stdio: 'ignore' })"), []);
check('a spawn with an ignore array is closed', violationsFor("spawn('x', [], { stdio: ['ignore', 'pipe', 'pipe'] })"), []);
check('a spawn that pipes stdin and the parent ends it is closed',
  violationsFor("const p = spawn('python3', ['-c', 'import sys; sys.stdin.read()'], { stdio: ['pipe', 'ignore', 'pipe'] });\n p.stdin.end();"), []);
check('a sync call with input is closed', violationsFor("execSync('x', { input: 'y' })"), []);
check('stdio: inherit is a violation',
  violationsFor("spawn('x', [], { stdio: 'inherit' })").map((v) => v.reason), ['inherits stdin (stdio: inherit)']);
check('an inherit array is a violation',
  violationsFor("spawn('x', [], { stdio: ['inherit', 'pipe', 'pipe'] })").map((v) => v.reason), ['inherits stdin (stdio[0]: inherit)']);
check('a pipe the parent never ends is a violation',
  violationsFor("spawn('x', [], { stdio: ['pipe', 'pipe', 'pipe'] })").map((v) => v.reason), ['pipes stdin but the parent never ends it']);
check('a spawn with no stdio is a violation',
  violationsFor("spawn('x', [])").map((v) => v.reason), ['no stdin disposition — the default pipe is open, so a prompt blocks on it']);
check('a regex .exec() is not read as a subprocess', violationsFor("const m = /a/.exec('b');"), []);
check('a spawn named only in a comment is not read as a spawn', violationsFor("// spawn('x', [], { stdio: 'inherit' })\n"), []);

console.log('\n2. the real tree: no build-loop subprocess inherits stdin');
const files = filesUnder(join(ROOT, 'server', 'src'));
const findings = [];
for (const abs of files) {
  const rel = relative(ROOT, abs);
  for (const v of violationsFor(readFileSync(abs, 'utf8'))) findings.push({ file: rel, ...v });
}
// Sanity first, so "no findings" cannot be "nothing was examined" (H17): the walk really found the two files
// whose spawns the build loop owns, and all three of their call sites.
const withSpawns = new Set(findings.map((f) => f.file));
check('the two build-loop spawn files were actually read', files.some((f) => f.endsWith('syntaxCheck.js')) && files.some((f) => f.endsWith('appSelfTest.js')), true);
check('no violation anywhere under server/src', findings, []);

console.log('\n3. the deliberate data pipe is a real one, not an accident of the walk');
// The Python check is the one legitimate stdin pipe: the parent writes the file and ends it. Assert the
// actual source still carries both halves, so a future edit that keeps 'pipe' but drops the end() is caught
// by the rule above (and this positive claim does not silently rot into "examined nothing").
const py = read('server/src/lib/syntaxCheck.js');
check('the Python check pipes stdin for the file content', /stdio:\s*\[\s*'pipe',\s*'ignore',\s*'pipe'\s*\]/.test(code(py)), true);
check('…and the parent ends that pipe', /\.stdin\.end\(\)/.test(code(py)), true);
const runner = read('server/src/lib/appSelfTest.js');
check('the self-test runner closes stdin on the app it starts', /stdio:\s*\[\s*'ignore',\s*'pipe',\s*'pipe'\s*\]/.test(code(runner)), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a build-loop subprocess can inherit stdin, so a tool that prompts hangs the whole build\n');
  process.exit(1);
}
console.log('every subprocess the build loop spawns closes stdin — a prompt gets EOF and fails fast\n');
