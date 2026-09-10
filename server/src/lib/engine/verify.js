// Shared engine — VERIFY. Given a project's files, does the change parse,
// bundle, and keep its cross-file exports intact? Host-agnostic: self-dev
// and (later) an embedded plugin tenant both call this with their own entry
// points and exclude rule.
//
// Three checks, all deterministic:
//   1. per-file transform (syntax / JSX)              — lib/syntaxCheck.js
//   2. bundle from real entry points (local imports)  — esbuild, npm external
//   3. cross-file named-export check                  — lib/importGraph.js
//
// It does NOT run `vite build` or `eslint` — the backend container has
// neither. esbuild is a single dependency-free binary and covers the
// failure modes that actually take a deploy down.
import { checkSyntax } from '../syntaxCheck.js';
import { findBrokenImports } from '../importGraph.js';
import * as esbuild from 'esbuild';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const CODE_EXT = /\.(jsx?|tsx?|mjs|cjs)$/;

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
  const codeFiles = kept.filter((f) => CODE_EXT.test(f.path));
  const errors = [];

  // Pass 1 — per-file transform (syntax / JSX).
  for (const e of await checkSyntax(codeFiles.map((f) => ({ path: f.path, content: f.content ?? '' })))) {
    errors.push({ phase: 'syntax', file: e.file, line: e.line, column: e.column, text: e.text });
  }

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
