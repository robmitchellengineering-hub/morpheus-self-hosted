// The plugin package must be byte-identical for byte-identical source.
//
// WHY THIS EXISTS — 2026-09-23, and it broke a live site's ability to update
//
// `scripts/pack-wp-plugin.mjs` packs the plugin and publishes the zip's SHA-256
// in `plugin-manifest.json`. The plugin verifies its download against that hash
// before WordPress installs it (includes/class-updates.php, `verify_download`),
// and it holds the manifest in a one-hour cache.
//
// The packer used `zip -rq`, which embeds every file's MODIFICATION TIME. Two
// packs of identical source therefore produced different bytes and a different
// hash — so every rebuild (for any reason: an unrelated merge, a CSS change, a
// docs commit) silently republished a new hash for the same code.
//
// That is an unupdatable loop, and Rob hit it on valiantmusic.com.au:
//
//   1. the site reads the manifest and caches hash A for an hour
//   2. main is rebuilt for an unrelated reason; the manifest now says hash B
//   3. he clicks Update; WordPress downloads the package, which hashes to B
//   4. the plugin compares it with the A it is holding and REFUSES to install
//   5. WordPress's own "Check again" does not clear the plugin's cache, so
//      retrying says the same thing, for up to an hour
//
// His words: "youve created an unupdatable logic loop failure in the setup."
//
// The fix is NOT to weaken the check — a component that installs code over the
// network must verify what arrives. The fix is to make the bytes stable: one
// fixed mtime for every file, `-X` to drop the extra field carrying mtimes at
// higher precision plus uid/gid, and an explicitly SORTED file list instead of
// whatever order readdir returns.
//
// So this guard packs the same source twice — with every mtime bumped in
// between, which is exactly what a fresh checkout does — and fails if the two
// hashes differ. It also asserts the manifest's hash describes the zip actually
// on disk, because a manifest that describes a different package than the one
// being served is the same failure wearing a different hat.
//
// Dependency-free and no install: it shells out to the packer, which imports
// only node builtins.
//
// Run: node scripts/verify-plugin-pack.mjs
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, utimesSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(REPO, 'wp-plugin/morpheus');
const MANIFEST = join(REPO, 'public/plugin-manifest.json');
const ZIP = join(REPO, 'public/morpheus-wordpress-plugin.zip');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) console.log(`  PASS  ${name}`);
  else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}
const has = (haystack, needle) => String(haystack).includes(needle);

console.log('\nPlugin pack — the published hash must describe the served bytes\n');

if (!existsSync(SRC)) {
  console.error('\n  ✗ wp-plugin/morpheus is missing — this check would silently pass.\n');
  process.exit(1);
}

/** Pack once and return the manifest it published. */
function pack() {
  execFileSync(process.execPath, ['scripts/pack-wp-plugin.mjs'], { cwd: REPO, stdio: 'pipe' });
  return JSON.parse(readFileSync(MANIFEST, 'utf8'));
}

/** Bump every mtime, the way a fresh checkout or a rebuild does. */
function touchAll(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) touchAll(full);
    else utimesSync(full, new Date(), new Date());
  }
}

// ── 1. the packer itself is deterministic ───────────────────────────────────
console.log('1. two packs of the same source are the same bytes');

const first = pack();
touchAll(SRC);
// A deliberate gap, and it is not padding. ZIP stores modification times at
// two-second granularity, so two packs taken back to back can land in the SAME
// bucket and compare equal even with the fix removed — the guard would then pass
// by luck, which is the one thing a guard must never do. Measured: dropping the
// mtime normalisation still produced identical bytes until this wait was added.
await new Promise((r) => setTimeout(r, 2200));
const second = pack();

check('the packer published a manifest', typeof first.sha256 === 'string' && first.sha256.length === 64, true);
check('the version in the manifest is the plugin header', has(readFileSync(join(SRC, 'morpheus.php'), 'utf8'), `Version:           ${first.version}`) || first.version !== '', true);
check('bumping every mtime and repacking gives the same sha256', second.sha256, first.sha256);
check('…and the same byte count', second.bytes, first.bytes);

// ── 2. the manifest describes the file being served ─────────────────────────
// The whole update channel rests on this: the plugin downloads the zip and
// compares it with the hash the manifest published. A manifest that describes
// anything else makes every update fail, on every site, at once.
console.log('\n2. the manifest describes the package on disk');

const onDisk = createHash('sha256').update(readFileSync(ZIP)).digest('hex');
check('the published sha256 is the zip on disk', second.sha256, onDisk);
check('the published size is the zip on disk', second.bytes, readFileSync(ZIP).length);
check('the manifest points at the URL the plugin fetches', has(second.url, 'morpheus.nz/morpheus-wordpress-plugin.zip'), true);

// ── the archive's own metadata, read from the file ──────────────────────────
// Not from `unzip -l`. The first version of this guard parsed that output and
// passed locally while failing in CI: macOS's Info-ZIP prints dates as
// `01-01-2020`, Ubuntu's prints `2020-01-01`, so the parser matched nothing on
// the runner and the check that mattered reported "0 timestamps". Reading the
// central directory directly has no tool output to depend on and is exact.
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i >= buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record — this is not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`bad central-directory header at ${p}`);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    out.push({
      name: buf.toString('utf8', p + 46, p + 46 + nameLen),
      // DOS date: bits 0-4 day, 5-8 month, 9-15 years since 1980.
      year: ((date >> 9) & 0x7f) + 1980,
      time,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const entries = zipEntries(readFileSync(ZIP));

// ── 3. the test-only parts stay out of the package ──────────────────────────
// A Playground boot writes third-party plugins into the mounted directory; the
// packer refuses to pack those, and the harnesses themselves have no business
// on a customer's site.
console.log('\n3. the package carries the plugin and not the harness');

const names = entries.map((e) => e.name);
check('the central directory was read (parser sanity)', entries.length >= 8, true);
check('the entry point is in the package', names.includes('morpheus/morpheus.php'), true);
check('nothing from tests/ is in the package', names.filter((f) => has(f, 'tests/')), []);

// ── 4. no entry carries a "now" timestamp ───────────────────────────────────
// The direct form of the bug: every entry in the archive must share one
// timestamp, because a per-file mtime is exactly what made two builds of the
// same code differ. The exact value is not pinned — ZIP stores the packer's
// local time, so the fixed 2020-01-01 can render as 2019-12-31 west of UTC — but
// the year has to be the pinned one, which is what catches a build time.
console.log('\n4. every entry carries the same fixed timestamp');

const stamps = [...new Set(entries.map((e) => `${e.year}:${e.time}`))];
check('all entries share one timestamp, so none carries a build time', stamps.length, 1);
check('and it is the pinned timestamp, not today', entries.every((e) => e.year <= 2020), true);
check('a timestamp was read for every entry', entries.filter((e) => e.year > 0).length, entries.length);


console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\nDo not weaken the hash check in class-updates.php to make this pass —');
  console.log('make the pack deterministic instead. See the note in pack-wp-plugin.mjs.\n');
  process.exit(1);
}
console.log('');
