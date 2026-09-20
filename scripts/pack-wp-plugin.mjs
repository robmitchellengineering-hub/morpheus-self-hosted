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
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
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
  execSync(`zip -rq "${outZip}" morpheus -x '*.DS_Store'`, { cwd: staging, stdio: 'inherit' });
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
  console.log(`[pack-wp-plugin] wrote ${outManifest} (v${version}, ${bytes} bytes, sha256 ${sha256.slice(0, 12)}…)`);
} catch (err) {
  console.error(`[pack-wp-plugin] failed: ${err.message}`);
  process.exit(1);
}
