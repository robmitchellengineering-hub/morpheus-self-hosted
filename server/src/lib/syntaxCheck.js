// Deterministic per-file syntax / JSX check, shared by the self-dev verify
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
// Other languages (Go, Arduino .ino, plain HTML, …) still carry no
// matching extension and are simply skipped — no real, embeddable parser
// readily available server-side for those, so this stays a no-op for them
// rather than a false sense of coverage.
//
// esbuild is already a backend dependency (added for verifySelfDev). If it
// or python3 somehow can't be loaded/spawned, that language's files are
// just skipped rather than blocking a build on our own gap.
import { spawn } from 'node:child_process';

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;
const PY_EXT = /\.pyw?$/;
const PYTHON_BIN = process.env.PYTHON_BIN || 'python3';

function loaderFor(pathname) {
  if (/\.tsx$/.test(pathname)) return 'tsx';
  if (/\.ts$/.test(pathname)) return 'ts';
  return 'jsx'; // .js/.jsx/.mjs/.cjs — 'jsx' loader also parses plain JS
}

async function checkJsFiles(files) {
  if (files.length === 0) return [];
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch {
    return []; // no esbuild in this environment — don't block on our own gap
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
  return errors;
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
      resolve([]);
      return;
    }
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', () => resolve([])); // python3 not available — same graceful skip as esbuild's try/catch
    proc.on('close', (code) => {
      if (code === 0 || !stderr) return resolve([]);
      const m = stderr.match(/^(\d+):(\d+):([\s\S]*)$/);
      resolve([{
        file: f.path,
        line: m ? Number(m[1]) : null,
        column: m ? Number(m[2]) : null,
        text: m ? m[3].trim() : stderr.trim(),
      }]);
    });
    proc.stdin.write(f.content);
    proc.stdin.end();
  });
}

async function checkPythonFiles(files) {
  if (files.length === 0) return [];
  const results = await Promise.all(files.map(checkOnePythonFile));
  return results.flat();
}

// files: [{ path, content }]. Returns [{ file, line, column, text }], one per
// distinct parse error, capped at `limit`.
export async function checkSyntax(files, { limit = 50 } = {}) {
  const all = (files || []).filter((f) => f && typeof f.content === 'string');
  const jsFiles = all.filter((f) => CODE_EXT.test(f.path));
  const pyFiles = all.filter((f) => PY_EXT.test(f.path));
  if (jsFiles.length === 0 && pyFiles.length === 0) return [];

  const errors = [
    ...(await checkJsFiles(jsFiles)),
    ...(await checkPythonFiles(pyFiles)),
  ];

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
