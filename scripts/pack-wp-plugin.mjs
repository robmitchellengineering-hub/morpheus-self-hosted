// Packs wp-plugin/morpheus/ into public/morpheus-wordpress-plugin.zip so the
// WEBSITE panel can hand a user the plugin to install — always current with
// the source. Runs on every build via the `prebuild` npm script. Excludes
// tests/. Uses the `zip` CLI (present on macOS, Linux, and the CI image).
import { execSync } from 'node:child_process';
import { rmSync, mkdirSync, cpSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(root, 'wp-plugin/morpheus');
const outZip = resolve(root, 'public/morpheus-wordpress-plugin.zip');
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
} catch (err) {
  console.error(`[pack-wp-plugin] failed: ${err.message}`);
  process.exit(1);
}
