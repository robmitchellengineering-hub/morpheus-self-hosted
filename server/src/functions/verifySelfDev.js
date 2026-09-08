// Pre-push verification for the self-dev workspace (Command Deck 4.0 /
// self-dev-replaces-the-dev-loop, Tier 1 #1). Before PUSH TO PRODUCTION,
// this materialises the whole workspace to a temp dir and runs esbuild over
// it two ways:
//
//   1. transform every JS/TS/JSX/TSX file on its own — catches syntax and
//      JSX errors anywhere, including files not reachable from an entry.
//   2. bundle from the real entry points (src/main.jsx for the frontend,
//      server/src/{index,worker}.js for the backend) with all npm packages
//      marked external — catches broken local imports and missing named
//      exports across files (exactly the "does not provide an export named
//      X" class that the 2026-09-06 self-dev rewrite of github.js shipped to
//      production).
//
// It does NOT run the real `vite build` or `eslint` — the backend container
// has neither (server/Dockerfile installs prod deps only, no frontend
// tree). esbuild is a single dependency-free binary and covers the failure
// modes that actually take a self-dev push down.
import { prisma } from '../db.js';
import { logUsage } from '../lib/projectUtils.js';
import { shouldExclude } from '../lib/selfDevRepo.js';
import { findBrokenImports } from '../lib/importGraph.js';
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

function fmtLoc(err, root) {
  const l = err.location;
  const strip = (s) => (root ? String(s).split(root + '/').join('').replace(/^.*?\/selfdev-verify-[^/]+\//, '') : s);
  return {
    file: l ? strip(l.file) : null,
    line: l?.line ?? null,
    column: l?.column ?? null,
    text: strip(err.text),
  };
}

export async function runVerifySelfDev(user) {
  const project = await prisma.project.findFirst({
    where: { created_by_id: user.id, project_type: 'self_dev' },
  });
  if (!project) throw Object.assign(new Error('Self-dev project not found — sync from GitHub first'), { status: 404 });

  const files = await prisma.projectFile.findMany({
    where: { project_id: project.id },
    select: { path: true, content: true },
  });
  if (files.length === 0) throw Object.assign(new Error('Workspace is empty — sync from GitHub first'), { status: 400 });

  const root = await mkdtemp(path.join(tmpdir(), 'selfdev-verify-'));
  const errors = [];
  try {
    // Materialise the workspace.
    for (const f of files) {
      if (shouldExclude(f.path)) continue;
      const full = path.join(root, f.path);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, f.content ?? '');
    }

    const codeFiles = files.filter((f) => CODE_EXT.test(f.path) && !shouldExclude(f.path));

    // Pass 1 — per-file transform (syntax / JSX).
    await Promise.all(codeFiles.map(async (f) => {
      try {
        await esbuild.transform(f.content ?? '', {
          loader: /tsx?$/.test(f.path) ? (f.path.endsWith('x') ? 'tsx' : 'ts') : 'jsx',
          jsx: 'automatic',
          sourcefile: f.path,
        });
      } catch (e) {
        for (const err of e.errors || [{ text: e.message }]) errors.push({ phase: 'syntax', ...fmtLoc(err, root), file: err.location?.file || f.path });
      }
    }));

    // Pass 2 — bundle from real entry points (cross-file imports / exports).
    const bundleTargets = [
      { name: 'frontend', entry: 'src/main.jsx', platform: 'browser', alias: { '@': path.join(root, 'src') } },
      { name: 'backend', entry: 'server/src/index.js', platform: 'node', alias: {} },
      { name: 'worker', entry: 'server/src/worker.js', platform: 'node', alias: {} },
    ];
    for (const t of bundleTargets) {
      const entryFull = path.join(root, t.entry);
      if (!files.some((f) => f.path === t.entry)) continue;
      try {
        await esbuild.build({
          entryPoints: [entryFull],
          bundle: true,
          write: false,
          packages: 'external', // npm deps not resolved — only local files
          format: 'esm',
          platform: t.platform,
          jsx: 'automatic',
          alias: t.alias,
          loader: ASSET_LOADERS,
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

  // Cross-file export check (A3): a NAMED import of a local file that the file
  // doesn't export — the exact "does not provide an export named X" class the
  // 2026-09-06 github.js rewrite shipped to every compile path. Deterministic,
  // and catches importers the esbuild bundle pass above can't reach from an
  // entry point.
  for (const b of findBrokenImports(files.filter((f) => !shouldExclude(f.path)))) {
    errors.push({
      phase: 'exports',
      file: b.importer,
      line: null,
      text: `imports "${b.name}" from ${b.target}, which does not export it — a caller-breaking change to ${b.target}`,
    });
  }

  // De-dupe (a broken export shows up once per importer).
  const seen = new Set();
  const unique = errors.filter((e) => {
    const k = `${e.file}:${e.line}:${e.text}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  await logUsage(user.id, 'self_dev_verify', project.id, project.name, { ok: unique.length === 0, errorCount: unique.length });

  return {
    ok: unique.length === 0,
    errorCount: unique.length,
    errors: unique.slice(0, 50),
    checkedFiles: files.filter((f) => CODE_EXT.test(f.path) && !shouldExclude(f.path)).length,
  };
}

export default async function handler({ user }) {
  if (user.role !== 'admin') throw Object.assign(new Error('Self-dev is admin only'), { status: 403 });
  return runVerifySelfDev(user);
}
