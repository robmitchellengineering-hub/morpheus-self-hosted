// Build the downloadable Portable Morpheus bundle — ONE zip, written from the tree being built.
//
// Run by `postbuild`, after `vite build`, so it always describes the commit that produced the
// deployment. That is the whole design: there is no committed mirror to forget to refresh, which is
// how the previous version silently shipped a tree a month old (see server/src/lib/portableBundle.js
// for that post-mortem, and for the rule this script applies).
//
// Writes, into dist/ (gitignored):
//   dist/portable-morpheus.zip    the source, plus a generated README describing it honestly
//   dist/portable-morpheus.json   { commit, builtAt, fileCount, bytes } — what the download page shows
//
// Run:  node scripts/build-portable-bundle.mjs
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { selectPortableFiles, portableBundleReadme } from '../server/src/lib/portableBundle.js';
import { LAUNCHERS } from '../server/src/lib/portableLaunch.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const ZIP_PATH = join(DIST, 'portable-morpheus.zip');
const META_PATH = join(DIST, 'portable-morpheus.json');

// Directories never worth walking: their contents are either excluded by the rule anyway (node_modules,
// dist, .git) or large enough that walking them for nothing is the slow part of a build.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'dist-plugin', '.render-smoke', '.netlify']);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.isDirectory()) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
    } else if (entry.isFile()) {
      out.push(relative(ROOT, full).split(sep).join('/'));
    }
  }
  return out;
}

function commit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {
    // A source tarball has no git. Say so rather than inventing a hash — the README prints this.
    return 'unknown (built outside a git checkout)';
  }
}

const files = selectPortableFiles(walk(ROOT));
if (files.length < 100) {
  // The rule selects hundreds of files; a handful means the walk or the rule broke, and a bundle that
  // ships almost nothing must not look like a success.
  console.error(`\n  ✗ portable bundle: only ${files.length} file(s) selected — refusing to write it.`);
  console.error('    Expected hundreds. Check PORTABLE_INCLUDE_ROOTS and the walk.\n');
  process.exit(1);
}

const zip = new JSZip();
const root = zip.folder('portable-morpheus');
for (const p of files) root.file(p, readFileSync(join(ROOT, p)));

const builtAt = new Date().toISOString();
root.file('PORTABLE-README.md', portableBundleReadme({ commit: commit(), builtAt, fileCount: files.length }));

// The launchers are GENERATED here rather than committed, so there is no second copy to drift from
// server/src/lib/portableLaunch.js. The exec bit matters: a .command without it does not double-click.
for (const l of LAUNCHERS) {
  const needsExec = l.file.endsWith('.command') || l.file.endsWith('.desktop');
  root.file(l.file, l.body, needsExec ? { unixPermissions: 0o755 } : {});
}

// platform: 'UNIX' is REQUIRED for unixPermissions to be written at all — without it JSZip defaults to
// DOS attributes and every file extracts as 0644, so the .command launcher opens in a text editor
// instead of running. Measured by unzipping the artifact, not assumed: the first build shipped the
// launchers non-executable.
const buffer = await zip.generateAsync({
  type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, platform: 'UNIX',
});
if (!existsSync(DIST)) mkdirSync(DIST, { recursive: true });
writeFileSync(ZIP_PATH, buffer);
writeFileSync(META_PATH, `${JSON.stringify({
  commit: commit(), builtAt, fileCount: files.length, bytes: buffer.length,
}, null, 2)}\n`);

console.log(`  portable: ${files.length} files + ${LAUNCHERS.length} launchers · ${(buffer.length / 1048576).toFixed(1)} MB · built from ${commit()}`);
