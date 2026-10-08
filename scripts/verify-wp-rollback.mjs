// The DEPLOY tab's UNDO — and the app to plugin contract behind it.
//
// WHY THIS EXISTS — 2026-10-08
//
// The plugin has had a tested `POST /rollback` since the Deploy module shipped, and NOTHING in the app
// ever called it. Meanwhile `server/src/lib/delivery/wordpress.js` advertised `supports: ['rollback']`,
// so the capability list claimed the delivery path could undo a deploy while the DEPLOY tab had no undo
// button, no action and no client function. A claim with no caller — H15's shape, one layer out.
//
// It is wired end to end now, and the parts that cross a boundary no compiler checks are asserted here:
// the route, the action name, the confirmation gate, and the two ways the plugin refuses. The behavioural
// half — that `rollback_last()` really restores the files — is `tests/harness.php`, which has asserted it
// since it shipped.
//
// ONE CLAIM BELOW IS AN ABSENCE, DELIBERATELY. The plugin's `handle_rollback` does NOT test `armed`; only
// `handle_deploy` does. That is exactly why the confirm panel tells the operator the undo writes even
// while the site is not armed. If the gate is ever added there, this goes red and that copy must be
// revisited — otherwise the panel would be warning about a danger that had gone away.
//
// Run:  node scripts/verify-wp-rollback.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

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

/** A PHP method body, from its `function name(` to the next method at the same indent. */
function phpBody(src, name) {
  const m = new RegExp(`function\\s+${name}\\s*\\(`).exec(src);
  if (!m) return '';
  const rest = src.slice(m.index + m[0].length);
  const end = rest.search(/\n\t(?:public|private|protected)\s+(?:static\s+)?function\s/);
  return end < 0 ? rest : rest.slice(0, end);
}

const php = read('wp-plugin/morpheus/includes/class-rest.php');
const deployPhp = read('wp-plugin/morpheus/includes/deploy/class-deploy.php');
const js = read('server/src/lib/wpPlugin.js');
const fn = read('server/src/functions/wordPressDeploy.js');
const tab = read('src/components/matrix/website/DeployTab.jsx');
const harness = read('wp-plugin/morpheus/tests/harness.php');
const delivery = read('server/src/lib/delivery/wordpress.js');

console.log('\nWP rollback — the deploy tab can undo, and both sides agree\n');

// ── 1. the plugin half ──────────────────────────────────────────────────────
console.log('1. the plugin registers the undo, and it is signed');
check('the /rollback route is registered', /register_rest_route\(\s*MORPHEUS_REST_NS\s*,\s*'\/rollback'/.test(php), true);
check('…for POST only', /'\/rollback'[\s\S]{0,200}?'methods'\s*=>\s*'POST'/.test(php), true);

const rollback = phpBody(php, 'handle_rollback');
check('the handler was located (a fixture that cannot fire proves nothing)', rollback.length > 200, true);
// The same front door as every other signed write: the HMAC over the raw body is the credential.
check('…and it verifies the signed body', /verified_body\(\s*\$request\s*\)/.test(rollback), true);
check('…and it calls rollback_last()', /rollback_last\(\)/.test(rollback), true);

// The two refusals the UI has to tell apart, and the retention rule that makes one of them real.
check('an absent deploy is refused as nothing_to_roll_back', /nothing_to_roll_back/.test(deployPhp), true);
check('an aged-out snapshot is refused as snapshot_missing, 410', /snapshot_missing[\s\S]{0,140}'status'\s*=>\s*410/.test(deployPhp), true);
check('the snapshot retention is bounded, which is what makes 410 reachable', /KEEP_SNAPSHOTS\s*=\s*\d+/.test(deployPhp), true);

// THE ABSENCE. The undo writes live files on a site that is not armed, because only the deploy handler
// tests `armed` — and the panel says so. Both halves of that sentence are asserted.
const deployHandler = phpBody(php, 'handle_deploy');
check('the deploy handler is the one that tests `armed`', /armed/.test(deployHandler), true);
check('…and the undo handler does not, which is what the panel warns about', /armed/.test(rollback), false);

// ── 2. the app half ─────────────────────────────────────────────────────────
console.log('\n2. the app can actually reach it');
check('wpPlugin.js exports wpRollback', /export async function wpRollback\s*\(/.test(js), true);
check('…which posts to the rollback endpoint (wpCall signs the body)', /wpCall\(conn,\s*'rollback'/.test(js), true);
check('the deploy function allows the action', /ALLOWED\s*=\s*new Set\(\[[^\]]*'rollback'[^\]]*\]\)/.test(fn), true);
check('…and imports wpRollback', /import\s*\{[^}]*wpRollback[^}]*\}\s*from\s*'\.\.\/lib\/wpPlugin\.js'/.test(fn), true);

const marker = fn.indexOf("action === 'rollback'");
const actionBlock = marker < 0 ? '' : fn.slice(marker, marker + 1800);
check('the rollback branch was located', actionBlock.length > 200, true);
check('…it refuses without an explicit confirm', /confirm\s*!==\s*true/.test(actionBlock), true);
check('…and refuses BEFORE it reaches the plugin', actionBlock.indexOf('confirm !== true') < actionBlock.indexOf('wpRollback('), true);
check('…and reports an unreachable site as its own failure', /res\.status === 0/.test(actionBlock), true);
// A refusal is the plugin's word, not ours: `nothing_to_roll_back` and `snapshot_missing` arrive as a
// payload and are returned as one, rather than being flattened into a generic failure.
check('…and returns the plugin\u2019s own refusal instead of inventing one', /\.\.\.\(res\.data \|\| \{\}\)/.test(actionBlock), true);

// ── 3. the control ─────────────────────────────────────────────────────────
console.log('\n3. the button exists, it is honest, and it cannot fire by accident');
check('DeployTab invokes the rollback action', /action:\s*'rollback'/.test(tab), true);
check('…with confirm: true', /action:\s*'rollback'[\s\S]{0,140}?confirm:\s*true/.test(tab), true);
// The plugin records `success: false` for a deploy it ALREADY rolled back (a failed health check), so
// offering undo then would restore a snapshot onto the state it came from and report health — a no-op
// wearing a success. The control is therefore gated on the deploy having LANDED.
check('…and offers it only after a deploy that landed', /last\?\.success === true/.test(tab), true);
// The repo's rule for a destructive control: a two-step inline confirm, never window.confirm.
check('…through a two-step inline confirm', /undoConfirming/.test(tab) && /setUndoConfirming\(true\)/.test(tab), true);
check('…and never window.confirm', /window\.confirm/.test(tab), false);
// The two refusals have different remedies — try again later vs. it is gone for good — so one sentence
// must not stand in for both.
check('…and an aged-out snapshot reads differently from a refused undo', /snapshot_missing/.test(tab), true);

// ── 4. the claim that started this ──────────────────────────────────────────
console.log('\n4. the capability the delivery path advertised');
check('delivery/wordpress.js still declares rollback support', /supports[\s\S]{0,200}?'rollback'/.test(delivery), true);
check('…and the plugin harness asserts the route that resolves to', /\$routes\['\/morpheus\/v1\/rollback'\]\s*\),\s*'route \/morpheus\/v1\/rollback registered'/.test(harness), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ the undo is not wired end to end any more — fix before merging.\n');
  process.exit(1);
}
console.log('The deploy tab can undo a deploy, and both sides agree on how.\n');
