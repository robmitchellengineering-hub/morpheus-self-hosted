// What the plugin installs, deleting the plugin removes.
//
// WHY THIS EXISTS — 2026-10-08
//
// `uninstall.php` removed two options (`morpheus_settings`, `morpheus_deploy_last`) and left five
// behind, so deleting and reinstalling the plugin inherited the previous site's SEO templates, fix
// history, pairing record and traffic toggle. Nothing failed, nothing warned, and the install simply
// was not fresh — the class of silent residue a reader cannot check by eye once the modules multiply.
//
// HOW IT DECIDES WHAT "COMPLETE" MEANS. Not from a hand-kept list here — that would rot in exactly
// the same way `uninstall.php` did. It reads the plugin's own source: every persistent store is
// either an option constant named `OPTION` / `RATE_OPTION` / `ATTEMPTS_OPTION` / `DEFAULTS_OPTION`,
// or a `get_option()`/`update_option()` call with a `morpheus_` literal. Add a store and this guard
// names it; forget `uninstall.php` and it fails on that name.
//
// WHAT IT DELIBERATELY DOES NOT COVER: transients. Every one carries a TTL (the longest, a day) and
// WordPress expires them, and their keys carry per-IP / per-slug hashes a source reader cannot
// compute. `uninstall.php` says so in its header, so this is a stated boundary and not a gap.
//
// Run:  node scripts/verify-plugin-uninstall.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(REPO, 'wp-plugin/morpheus');

let checks = 0;
let failures = 0;
function check(name, actual, expected) {
  checks++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    console.log(`  PASS  ${name}`);
  } else {
    console.log(`  FAIL  ${name}\n          expected ${e}\n          got      ${a}`);
    failures++;
  }
}

/** Every .php file under a directory, so a new module's store is seen without editing this file. */
function phpFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return phpFiles(p);
    return name.endsWith('.php') ? [p] : [];
  });
}

console.log('\nPlugin uninstall — what it installs, deleting it removes\n');

// ── what the plugin stores ──────────────────────────────────────────────────
// ANY constant whose name ends in OPTION, not a hand-listed four.
// ⚠️ The hand-listed version had exactly the hole it was written to close: the
// redirects module added `LOG_OPTION`, which the list did not name, so a second
// persistent store arrived invisible to this guard. A name shape is the rule now.
const OPTION_CONST = /const\s+([A-Z_]*OPTION)\s*=\s*'([^']+)'/g;
const OPTION_CALL = /(?:get|update|delete|add)_option\(\s*'([^']+)'/g;

const stores = new Set();
for (const file of phpFiles(join(PLUGIN, 'includes'))) {
  const src = readFileSync(file, 'utf8');
  for (const m of src.matchAll(OPTION_CONST)) stores.add(m[2]);
  for (const m of src.matchAll(OPTION_CALL)) {
    if (m[1].startsWith('morpheus_')) stores.add(m[1]);
  }
}

// The fixture is the real source tree, so it cannot be a fixture that "could never fire" (H19):
// there is always at least one store, and the count is asserted rather than assumed.
check('the plugin stores at least the known options', stores.size >= 9, true);

// ── what uninstall removes ──────────────────────────────────────────────────
const uninstall = readFileSync(join(PLUGIN, 'uninstall.php'), 'utf8');
const removed = new Set([...uninstall.matchAll(/delete_option\(\s*'([^']+)'/g)].map((m) => m[1]));

console.log('1. every store the plugin writes is removed');
check('…every option is deleted', [...stores].filter((s) => !removed.has(s)).sort(), []);
check('…and nothing is deleted that the plugin never stored', [...removed].filter((r) => !stores.has(r)).sort(), []);

console.log('\n2. the parts that are not options');
// The traffic module's rewrite rule survives deactivation in the stored `rewrite_rules` option.
// The plugin is not loaded during uninstall, so flushing there is what actually drops it.
check('the traffic rewrite rule is flushed, not left in rewrite_rules', /flush_rewrite_rules\(\)/.test(uninstall), true);
check('…and the plugin state directory is removed', /morpheus-state/.test(uninstall) && /RecursiveDirectoryIterator/.test(uninstall), true);
// It removes the plugin's OWN state and nothing else. A delete that reaches into the site — the
// plugin directory, the uploads, the root — is a different act and must not appear here.
check('…and it never deletes site files', /WP_CONTENT_DIR\s*\.\s*'\/morpheus-state'/.test(uninstall), true);
check('…and it bails when WordPress has not asked for an uninstall', /defined\(\s*'WP_UNINSTALL_PLUGIN'\s*\)/.test(uninstall), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a store the plugin keeps would survive a delete, or uninstall.php is out of step\n');
  process.exit(1);
}
console.log('The plugin removes what it installed.\n');
