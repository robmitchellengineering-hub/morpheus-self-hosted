// Packs wp-plugin/morpheus/ into public/morpheus-wordpress-plugin.zip so the
// WEBSITE panel can hand a user the plugin to install — always current with
// the source. Runs on every build via the `prebuild` npm script. Excludes
// tests/. Uses the `zip` CLI (present on macOS, Linux, and the CI image).
//
// Also writes public/plugin-manifest.json — SetupTab.jsx fetches it to compare
// against the live site's `/wp-json/morpheus/v1/status` version, and the PLUGIN
// itself fetches it (see includes/class-updates.php) to offer a one-click update
// inside WordPress. The manifest therefore carries the package URL and its
// SHA-256 as well as the version, because the plugin verifies the download
// against that hash before installing it — a self-updating component should not
// accept whatever arrives on the wire.
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync, utimesSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { undeliverable } from './lib/wpPluginRelease.mjs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'wp-plugin/morpheus');
const outZip = resolve(root, 'public/morpheus-wordpress-plugin.zip');
const outManifest = resolve(root, 'public/plugin-manifest.json');
const staging = resolve(root, 'node_modules/.cache/wp-plugin-pack');

if (!existsSync(src)) {
  console.warn('[pack-wp-plugin] wp-plugin/morpheus not found — skipping');
  process.exit(0);
}

// The plugin directory must contain ONLY the plugin. A WordPress Playground
// harness boot mounts this directory into wp-content/plugins, so installing
// WooCommerce or Yoast for a test writes them back HERE — 89 MB of third-party
// code that the packer would otherwise zip and publish as this plugin's own
// update, with a manifest checksum that matches it. Fail loudly instead.
const ALLOWED_TOP_LEVEL = new Set(['morpheus.php', 'uninstall.php', 'readme.txt', 'includes', 'tests']);
const stray = readdirSync(src).filter((name) => !ALLOWED_TOP_LEVEL.has(name));
if (stray.length) {
  console.error(
    `[pack-wp-plugin] refusing to pack: ${stray.join(', ')} is not part of the plugin. `
    + 'A Playground harness boot installs test plugins inside the mounted directory — delete it and re-run.',
  );
  process.exit(1);
}

try {
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  cpSync(src, resolve(staging, 'morpheus'), { recursive: true });
  rmSync(resolve(staging, 'morpheus/tests'), { recursive: true, force: true });
  mkdirSync(resolve(root, 'public'), { recursive: true });
  rmSync(outZip, { force: true });

  // THE PACK IS DETERMINISTIC, AND THAT IS NOT TIDINESS — IT IS THE UPDATE CHANNEL.
  //
  // 2026-09-23: `zip -rq` embedded each file's modification time, so packing the
  // SAME plugin source twice produced two different files with two different
  // SHA-256s. Every build therefore published a new hash for byte-identical
  // content, and the plugin verifies its download against the manifest it read
  // earlier — cached for an hour (class-updates.php, CACHE_TTL).
  //
  // The loop that produced: a site caches the manifest, the app is rebuilt for
  // any unrelated reason, the site clicks Update, downloads a package whose
  // bytes no longer match the hash it is holding, and the plugin correctly
  // REFUSES to install it. WordPress's own "Check again" does not clear that
  // cache, so retrying says the same thing. Rob hit exactly this on
  // valiantmusic.com.au and named it: "an unupdatable logic loop".
  //
  // The hash is not the thing to weaken — a component that installs code over
  // the network must verify what arrives. The bytes are the thing to fix: one
  // fixed timestamp for every file, `-X` to drop the extra field that carries
  // mtimes at higher precision plus uid/gid, and an explicit SORTED file list
  // rather than whatever order readdir happens to return.
  const files = [];
  const walk = (dir, prefix = '') => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(resolve(dir, entry.name), rel);
      else if (!/\.DS_Store$/.test(entry.name)) files.push(rel);
    }
  };
  walk(resolve(staging, 'morpheus'), 'morpheus');
  files.sort();

  const FIXED_MTIME = new Date('2020-01-01T00:00:00Z');
  for (const rel of files) utimesSync(resolve(staging, rel), FIXED_MTIME, FIXED_MTIME);

  execSync(`zip -X -q "${outZip}" -@`, { cwd: staging, input: `${files.join('\n')}\n` });
  console.log(`[pack-wp-plugin] wrote ${outZip}`);

  const header = readFileSync(resolve(src, 'morpheus.php'), 'utf8');
  const m = header.match(/^\s*\*\s*Version:\s*([\d.]+)/m);
  const version = m ? m[1] : null;
  if (!version) throw new Error('could not read Version: from morpheus.php header');

  // The hash is computed over the zip we just wrote, so the manifest can never
  // describe a different package than the one being served.
  const bytes = statSync(outZip).size;
  const sha256 = createHash('sha256').update(readFileSync(outZip)).digest('hex');
  writeFileSync(outManifest, JSON.stringify({
    version,
    sha256,
    bytes,
    // Where the plugin downloads it from. Absolute on purpose: the plugin runs
    // on someone else's server and has no idea what host this build was made on.
    url: 'https://morpheus.nz/morpheus-wordpress-plugin.zip',
    requires: (header.match(/^\s*\*\s*Requires at least:\s*([\d.]+)/m) || [, null])[1],
    requires_php: (header.match(/^\s*\*\s*Requires PHP:\s*([\d.]+)/m) || [, null])[1],
  }), 'utf8');
  // ⚠️ THE PUBLISHED MANIFEST, FETCHED AT PACK TIME — see undeliverable() for why this is the only place the
  // question can be answered. A network failure is NOT a build failure (this runs on every build, including on a
  // laptop with no connection): it warns and moves on. The condition it exists to catch is specific and knowable.
  const next = { version, sha256 };
  let live = null;
  try {
    const res = await fetch('https://morpheus.nz/plugin-manifest.json', { signal: AbortSignal.timeout(8000) });
    if (res.ok) live = await res.json();
  } catch {
    console.log('[pack-wp-plugin] could not read the published manifest — skipping the deliverability check');
  }
  const why = undeliverable(live, next);
  if (why) {
    console.error(`\n[pack-wp-plugin] REFUSING TO PUBLISH: ${why}.`);
    console.error('  Bump the Version: header, the MORPHEUS_VERSION constant and the readme\'s Stable tag,');
    console.error('  and add a changelog entry. Three copies plus the changelog — verify-pairing.mjs checks they agree.\n');
    process.exit(1);
  }

  console.log(`[pack-wp-plugin] wrote ${outManifest} (v${version}, ${bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`);
} catch (err) {
  console.error(`[pack-wp-plugin] failed: ${err.message}`);
  process.exit(1);
}
