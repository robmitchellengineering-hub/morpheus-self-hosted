// Shared engine — VERIFY. Given a project's files, does the change parse,
// bundle, and keep its cross-file exports intact? Host-agnostic: self-dev
// and (later) an embedded plugin tenant both call this with their own entry
// points and exclude rule.
//
// Three checks, all deterministic:
//   1. per-file transform (syntax / JSX)              — lib/syntaxCheck.js
//   2. bundle from real entry points (local imports)  — esbuild, npm external
//   3. cross-file named-export check                  — lib/importGraph.js
// plus an opt-in fourth:
//   4. house conventions (`opts.conventionChecks`)    — lib/conventionChecks.js
//
// Check 4 exists because the gate that decides whether a change lands runs 33
// guards on top of these, so a change could pass everything here and still fail
// CI on a rule the writer was never shown in a form it could act on. Three
// consecutive self-dev changes did exactly that (`rework: 0/0/0`, then a red
// `prose-ink rule`). It is opt-in because these are Morpheus's own conventions —
// a tenant's generated project has no ink ladder, and enforcing our house style on
// someone else's code would be nonsense.
//
// It does NOT run `vite build` or `eslint` — the backend container has
// neither. esbuild is a single dependency-free binary and covers the
// failure modes that actually take a deploy down.
import { checkSyntaxDetailed } from '../syntaxCheck.js';
import { findBrokenImports } from '../importGraph.js';
import { conventionViolations } from '../conventionChecks.js';
import { coverageError } from './verificationCoverage.js';
import * as esbuild from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const ASSET_LOADERS = {
  '.css': 'empty', '.scss': 'empty', '.less': 'empty',
  '.svg': 'empty', '.png': 'empty', '.jpg': 'empty', '.jpeg': 'empty',
  '.gif': 'empty', '.webp': 'empty', '.ico': 'empty',
  '.woff': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.eot': 'empty',
  '.mp3': 'empty', '.mp4': 'empty', '.wav': 'empty',
};

// The standard JS web + node entry set. A caller can override or extend it.
export const DEFAULT_ENTRY_POINTS = [
  { name: 'frontend', entry: 'src/main.jsx', platform: 'browser', aliasRoots: { '@': 'src' } },
  { name: 'backend', entry: 'server/src/index.js', platform: 'node', aliasRoots: {} },
  { name: 'worker', entry: 'server/src/worker.js', platform: 'node', aliasRoots: {} },
];

function fmtLoc(err, root) {
  const l = err.location;
  const strip = (s) => (root ? String(s).split(root + '/').join('').replace(/^.*?\/engine-verify-[^/]+\//, '') : s);
  return {
    file: l ? strip(l.file) : null,
    line: l?.line ?? null,
    column: l?.column ?? null,
    text: strip(err.text),
  };
}

/**
 * @param {{path:string, content:string}[]} files  the whole project
 * @param {object} [opts]
 * @param {(path:string)=>boolean} [opts.exclude]   paths to skip entirely
 * @param {Array} [opts.entryPoints]                { name, entry, platform, aliasRoots } — defaults to DEFAULT_ENTRY_POINTS
 * @param {Array} [opts.esbuildPlugins]             extra esbuild plugins (e.g. to mark a deliberately-excluded dir external)
 * @returns {Promise<{ok:boolean, errorCount:number, errors:Array, checkedFiles:number}>}
 */
export async function verifyProject(files, opts = {}) {
  const exclude = opts.exclude || (() => false);
  const entryPoints = opts.entryPoints || DEFAULT_ENTRY_POINTS;
  const extraPlugins = opts.esbuildPlugins || [];

  const kept = files.filter((f) => f && typeof f.path === 'string' && !exclude(f.path));
  const errors = [];

  // Pass 1 — per-file syntax, over EVERY kept file, and the checker says which ones it read.
  //
  // ⚠️ THIS USED TO PASS ONLY JS/TS, because that was all `checkSyntax` could read. The cost was
  // invisible and expensive: for a WordPress tenant the normal change is PHP, and a PHP-only change
  // examined nothing, so coverage correctly said `not_verified` — honest, and no protection at all.
  // Reading the checker's own `checked` list is what makes coverage meaningful now: it is the files
  // that were really examined, so adding a language is only ever a gain.
  const syntax = await checkSyntaxDetailed(kept.map((f) => ({ path: f.path, content: f.content ?? '' })));
  for (const e of syntax.errors) {
    errors.push({ phase: 'syntax', file: e.file, line: e.line, column: e.column, text: e.text });
  }
  const codeFiles = syntax.checked;

  // Pass 2 — bundle from real entry points (local imports).
  const root = await mkdtemp(path.join(tmpdir(), 'engine-verify-'));
  try {
    for (const f of kept) {
      const full = path.join(root, f.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content ?? '');
    }

    for (const t of entryPoints) {
      if (!kept.some((f) => f.path === t.entry)) continue;
      const alias = Object.fromEntries(
        Object.entries(t.aliasRoots || {}).map(([k, rel]) => [k, path.join(root, rel)]),
      );
      try {
        await esbuild.build({
          entryPoints: [path.join(root, t.entry)],
          bundle: true,
          write: false,
          packages: 'external',   // npm deps not resolved — only local files
          format: 'esm',
          platform: t.platform,
          jsx: 'automatic',
          alias,
          loader: ASSET_LOADERS,
          plugins: extraPlugins,
          logLevel: 'silent',
          absWorkingDir: root,
        });
      } catch (e) {
        for (const err of e.errors || [{ text: e.message }]) {
          errors.push({ phase: `resolve:${t.name}`, ...fmtLoc(err, root), file: err.location?.file?.replace(root + '/', '') || t.entry });
        }
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }

  // Pass 3 — cross-file named-export check (catches importers no entry reaches).
  for (const b of findBrokenImports(kept)) {
    errors.push({
      phase: 'exports',
      file: b.importer,
      line: null,
      text: `imports "${b.name}" from ${b.target}, which does not export it — a caller-breaking change to ${b.target}`,
    });
  }

  // Pass 4 — house conventions (opt-in; see the header).
  for (const e of conventionViolations(kept, opts.conventionChecks)) errors.push(e);

  // Pass 5 — did any of the above have anything to look at? "Nothing failed" is
  // not "nothing to check": a pass from a check that examined nothing is not a
  // pass, and it is the answer nobody goes back and questions. See
  // verificationCoverage.js for the 37-file Python project this returned ok for.
  const coverage = coverageError({ codeFiles: codeFiles.length, files: kept.length });
  if (coverage) errors.push(coverage);

  const seen = new Set();
  const unique = errors.filter((e) => {
    const k = `${e.file}:${e.line}:${e.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    ok: unique.length === 0,
    errorCount: unique.length,
    errors: unique.slice(0, 50),
    checkedFiles: codeFiles.length,
  };
}
