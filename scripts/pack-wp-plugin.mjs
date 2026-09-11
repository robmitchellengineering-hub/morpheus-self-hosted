// Packs wp-plugin/morpheus/ into public/morpheus-wordpress-plugin.zip so the
// WEBSITE panel can hand a user the plugin to install — always current with
// the source. Runs on every build via the `prebuild` npm script. Excludes
// tests/. Uses the `zip` CLI (present on macOS, Linux, and the CI image).
//
// Also writes public/plugin-manifest.json ({version}) — SetupTab.jsx fetches
// it to compare against the live site's `/wp-json/morpheus/v1/status`
// version and prompt "update available" once they drift, rather than a user
// being stuck on an old plugin build with no way back to the download step
// (SetupTab only shows the install flow pre-connect).
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  writeFileSync(outManifest, JSON.stringify({ version }), 'utf8');
  console.log(`[pack-wp-plugin] wrote ${outManifest} (v${version})`);
} catch (err) {
  console.error(`[pack-wp-plugin] failed: ${err.message}`);
  process.exit(1);
}
