// Syncs the real Morpheus source into the portable-morpheus download bundle.
//
// The portable package (public/portable-morpheus/server|client) is a hand-written
// standalone adaptation (Node/Express + file store + OpenAI client) and stays
// runnable as-is. To keep the downloadable bundle current with development, this
// script copies the authoritative real source — shared modules, backend
// functions, entity schemas, and key frontend files — verbatim into
// public/portable-morpheus/_source/<original-path> and writes a manifest the
// download page reads so every synced file is included in the ZIP.
//
// Run after dev changes:  node scripts/sync-portable-morpheus.mjs
//
// The running Morpheus app never imports these files; they are static assets
// served only for the portable download.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DEST_ROOT = path.join(ROOT, 'public/portable-morpheus/_source');

// What to mirror. Each entry is a path under the project root. Directories are
// scanned recursively; file globs use a single trailing * for the basename.
const SOURCES = [
  'base44/shared',
  'base44/entities',
  'base44/functions',     // copies <name>/entry.ts for every function
  'src/components/matrix',
  'src/hooks',
  'src/pages/Workspace.jsx',
  'src/pages/Architect.jsx',
  'src/pages/Settings.jsx',
  'src/pages/Landing.jsx',
  'src/App.jsx',
  'src/index.css',
  'tailwind.config.js',
];

// Only these extensions are mirrored from scanned directories (keeps the bundle
// lean — no node_modules, no build output, no lockfiles).
const ALLOWED_EXT = new Set(['.ts', '.js', '.jsx', '.jsonc', '.css']);

function listFiles(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  const stat = fs.statSync(abs);
  if (stat.isFile()) return [rel];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (ALLOWED_EXT.has(path.extname(e.name))) out.push(p);
    }
  };
  walk(abs);
  return out.map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
}

function copy(srcRel) {
  const src = path.join(ROOT, srcRel);
  const dest = path.join(DEST_ROOT, srcRel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return srcRel;
}

const synced = [];
for (const s of SOURCES) {
  for (const f of listFiles(s)) synced.push(copy(f));
}

synced.sort();
const manifest = {
  generated: new Date().toISOString(),
  count: synced.length,
  files: synced,
};
fs.mkdirSync(DEST_ROOT, { recursive: true });
fs.writeFileSync(path.join(DEST_ROOT, 'manifest.json'), JSON.stringify(manifest, null, 2));

console.log(`✓ synced ${synced.length} files into public/portable-morpheus/_source/`);
for (const f of synced) console.log(`  ${f}`);