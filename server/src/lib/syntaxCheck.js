// Deterministic per-file syntax / JSX / Python / PHP check, shared by the self-dev verify
// gate (verifySelfDev.js) and every regular build turn (chatWithMorpheus.js).
//
// It runs esbuild's `transform` over each JS/TS/JSX/TSX file on its own —
// no bundling, no import resolution — so it catches the "the model emitted
// code that doesn't even parse" class (an unclosed brace, a stray token, a
// half-applied edit) BEFORE the change is written and the operator hits a
// white screen.
//
// Python files (.py/.pyw) get the same real-toolchain treatment via real
// CPython's ast.parse (2026-09-15) — added after a real incident: the
// Wikidata Batch Uploader's core/gemini_adapter.py was silently truncated
// mid-generation (almost certainly an output-token cutoff) and committed
// as-is, since this check used to skip Python entirely and nothing else
// verifies a native/Python project's files before they're written. It only
// surfaced much later, as a runtime crash the operator had to build a
// whole diagnostic-log system to even see. A truncated file just stops —
// no "TODO", no placeholder marker the semantic reviewer's completeness
// check would recognize — so a real parser is the only reliable way to
// catch it, exactly the same reasoning that put esbuild here for JS.
//
// PHP files (.php) got it next (2026-10-09), for the same reason and with
// more at stake: the FIRST LIVE CUSTOMER TARGET IS A WORDPRESS SITE, so a
// tenant's normal change is PHP, and this check used to read none of it.
// The WordPress delivery adapter said so itself — *"PHP lint and the theme
// build run in the target repo's CI"* — which is an assumption about a repo
// nobody had checked. Unlike Python, this one does NOT depend on a binary
// being present on the host: `php-parser` is a real parser written in JS, so
// it works in the backend container, which has no `php`. That matters,
// because the container is exactly where a tenant's change is verified.
//
// Other languages (Go, Arduino .ino, plain HTML, …) still carry no
// matching extension and are simply skipped — no real, embeddable parser
// readily available server-side for those, so this stays a no-op for them
// rather than a false sense of coverage.
//
// ⚠️ WHAT THIS FILE RETURNS, AND WHY THE SHAPE CHANGED. It used to return a
// list of errors, and callers decided coverage from a STATIC extension list —
// so `.php` could have been added to that list and coverage would have
// reported a pass over files nothing had read. That is H17 with the change
// that was meant to fix it as the cause. `checkSyntaxDetailed()` therefore
// reports `checked`: the files a checker ACTUALLY read, which is empty for a
// language whose tool is unavailable. Coverage is counted from that, never
// from an extension.
import { spawn } from 'node:child_process';

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
const PY_EXT = /\.pyw?$/;
const PHP_EXT = /\.php$/i;
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

function loaderFor(pathname) {
  if (/\.tsx$/.test(pathname)) return 'tsx';
  if (/\.ts$/.test(pathname)) return 'ts';
  return 'jsx'; // .js/.jsx/.mjs/.cjs — 'jsx' loader also parses plain JS
}

// Each language checker returns `{ errors, available }`. `available: false`
// means "this machine could not run the tool" — NOT "the files were fine".
// The difference is the whole reason `checked` exists.
async function checkJsFiles(files) {
  if (files.length === 0) return { errors: [], available: true };
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    return { errors: [], available: false }; // no esbuild in this environment — don't block on our own gap
  }
  const errors = [];
  await Promise.all(files.map(async (f) => {
    try {
      await esbuild.transform(f.content, {
        loader: loaderFor(f.path),
        jsx: 'automatic',
        sourcefile: f.path,
      });
    } catch (e) {
      for (const err of e.errors || [{ text: e.message }]) {
        errors.push({
          file: err.location?.file || f.path,
          line: err.location?.line ?? null,
          column: err.location?.column ?? null,
          text: err.text || String(e.message || 'syntax error'),
        });
      }
    }
  }));
  return { errors, available: true };
}

// Real CPython ast.parse over stdin — filename passed as argv[1] only for
// the error message. Prints "line:col:message" to stderr and exits 1 on a
// SyntaxError, exits 0 silently otherwise.
const PY_CHECK_SCRIPT = [
  'import sys, ast',
  'src = sys.stdin.read()',
  'try:',
  '    ast.parse(src, filename=sys.argv[1])',
  'except SyntaxError as e:',
  '    sys.stderr.write(f"{e.lineno or 0}:{e.offset or 0}:{e.msg}")',
  '    sys.exit(1)',
].join('\n');

function checkOnePythonFile(f) {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(PYTHON_BIN, ['-c', PY_CHECK_SCRIPT, f.path], { stdio: ['pipe', 'ignore', 'pipe'] });
    } catch {
      resolve({ errors: [], missing: true });
      return;
    }
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve({ errors: [], missing: true })); // python3 not available — same graceful skip as esbuild's try/catch
    proc.on('close', (code) => {
      if (code === 0 || !stderr) return resolve({ errors: [], missing: false });
      const m = stderr.match(/^(\d+):(\d+):([\s\S]*)$/);
      resolve({
        errors: [{
          file: f.path,
          line: m ? Number(m[1]) : null,
          column: m ? Number(m[2]) : null,
          text: m ? m[3].trim() : stderr.trim(),
        }],
        missing: false,
      });
    });
    proc.stdin.write(f.content);
    proc.stdin.end();
  });
}

async function checkPythonFiles(files) {
  if (files.length === 0) return { errors: [], available: true };
  const results = await Promise.all(files.map(checkOnePythonFile));
  // If EVERY file reported the tool missing, the tool is missing. One file
  // reporting it is enough to say so, because the spawn is the same for all.
  const available = !results.some((r) => r.missing);
  return { errors: results.flatMap((r) => r.errors), available };
}

// A real PHP parser, in JS. `suppressErrors: false` is the point — the
// default is to recover and keep going, which is exactly the behaviour that
// would hand back an AST for a file that does not parse.
async function checkPhpFiles(files) {
  if (files.length === 0) return { errors: [], available: true };
  let PhpParser;
  try {
    ({ default: PhpParser } = await import('php-parser'));
  } catch {
    return { errors: [], available: false }; // no parser in this environment — see `checked`
  }
  const errors = [];
  for (const f of files) {
    try {
      // A parser per file: `parseCode` carries no state we want to share, and a
      // reused instance is the kind of economy that turns one bad file into a
      // misleading error on the next.
      new PhpParser({ parser: { suppressErrors: false, extractDoc: false }, ast: { withPositions: true } })
        .parseCode(f.content, f.path);
    } catch (e) {
      errors.push({
        file: f.path,
        line: typeof e.lineNumber === 'number' ? e.lineNumber : null,
        column: typeof e.columnNumber === 'number' ? e.columnNumber : null,
        // "Parse Error : syntax error, unexpected '{'" — the prefix is noise in a panel.
        text: String(e.message || 'syntax error').replace(/^\s*Parse Error\s*:\s*/i, ''),
      });
    }
  }
  return { errors, available: true };
}

function dedupe(errors, limit) {
  const seen = new Set();
  return errors
    .filter((e) => {
      const k = `${e.file}:${e.line}:${e.text}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, limit);
}

/**
 * Check every file this module has a real tool for, and say which ones were READ.
 *
 * `checked` is the honest half and the reason this function exists: a file appears in it only
 * when its language's checker was AVAILABLE and the file was routed to it. Coverage is counted
 * from `checked`, so a language whose tool is missing reports "not verified" rather than a pass
 * over files nothing looked at.
 *
 * @param {{path:string, content:string}[]} files
 * @returns {Promise<{errors:Array, checked:string[]}>}
 */
export async function checkSyntaxDetailed(files, { limit = 50 } = {}) {
  const all = (files || []).filter((f) => f && typeof f.content === 'string');
  const jsFiles = all.filter((f) => CODE_EXT.test(f.path));
  const pyFiles = all.filter((f) => PY_EXT.test(f.path));
  const phpFiles = all.filter((f) => PHP_EXT.test(f.path));
  if (jsFiles.length === 0 && pyFiles.length === 0 && phpFiles.length === 0) {
    return { errors: [], checked: [] };
  }

  const [js, py, php] = await Promise.all([
    checkJsFiles(jsFiles),
    checkPythonFiles(pyFiles),
    checkPhpFiles(phpFiles),
  ]);

  const checked = [
    ...(js.available ? jsFiles : []),
    ...(py.available ? pyFiles : []),
    ...(php.available ? phpFiles : []),
  ].map((f) => f.path);

  return { errors: dedupe([...js.errors, ...py.errors, ...php.errors], limit), checked };
}

/** The error list alone — unchanged, for every caller that is not deciding coverage. */
export async function checkSyntax(files, opts) {
  return (await checkSyntaxDetailed(files, opts)).errors;
}
