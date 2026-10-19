// Redirects and the 404 log — the rules that keep a rule list from becoming an outage.
//
// WHY THIS EXISTS — 2026-10-08
//
// Nothing in this plugin managed a redirect. On a WooCommerce store that is the
// content-ops feature that pays for itself: every retired product URL and every
// campaign link someone already shared is a 404 unless something is watching, and
// nothing was recording them either.
//
// A redirect list is also the one content feature that can take a site DOWN, and the
// failure is not subtle: a rule matching `wp-admin` locks the owner out of the
// screen they would fix it on. So the rules here are asserted as refusals, not as
// features — the protected paths, the destination shapes, the loops, and the bound
// on the log.
//
// Run:  node scripts/verify-redirects.mjs
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

const src = read('wp-plugin/morpheus/includes/class-redirects.php');
const bootstrap = read('wp-plugin/morpheus/morpheus.php');
const rest = read('wp-plugin/morpheus/includes/class-rest.php');
const uninstall = read('wp-plugin/morpheus/uninstall.php');

console.log('\nWP redirects — a rule list that cannot lock the owner out\n');

// ── 1. the admin surface is never redirectable ──────────────────────────────
console.log('1. the owner can always reach wp-admin');
for (const p of ['wp-admin', 'wp-login.php', 'wp-json', 'wp-cron.php', 'xmlrpc.php']) {
  check(`…"${p}" is on the protected list`, new RegExp(`'${p.replace('.', '\\.')}'`).test(src), true);
}
check('…and the state directory is protected too', /'wp-content\/morpheus-state'/.test(src), true);
// TWO refusals, not one: at save time (so the operator is told) AND at match time
// (so a rule that arrived any other way still cannot do it).
check('the refusal is applied when a rule is saved', /function clean_rule[\s\S]{0,600}is_protected\(/.test(src), true);
check('…and again when a rule is matched', /function maybe_redirect[\s\S]{0,900}is_protected\(/.test(src), true);
check('a protected path is refused with a sentence, not a silent drop',
  /WP_Error\(\s*'protected_from'/.test(src), true);

// ── 2. where a rule may point ───────────────────────────────────────────────
console.log('\n2. a destination cannot be a script');
check('only a same-site path or an absolute http(s) address is accepted',
  /preg_match\(\s*'#\^https\?:\/\//.test(src), true);
check('…a protocol-relative address is refused (an external host in disguise)', /0 === strpos\( \$to, '\/\/' \)/.test(src), true);
check('…a relative path is charset-checked before it becomes a Location header', /function is_relative_ok/.test(src), true);
check('…and the refusal names what a destination should look like', /WP_Error\(\s*'bad_to'/.test(src), true);

// ── 3. loops ────────────────────────────────────────────────────────────────
console.log('\n3. a rule cannot point at itself');
check('a self-redirect is refused', /WP_Error\(\s*'self_redirect'/.test(src), true);
check('…and a two-rule cycle is refused by name', /WP_Error\(\s*'loop'/.test(src), true);
check('…and a duplicate `from` is refused rather than silently shadowing', /WP_Error\(\s*'duplicate'/.test(src), true);
check('…and the cap on rules is named when it is reached', /WP_Error\(\s*'too_many'/.test(src), true);

// ── 4. when it runs, and what 410 means ─────────────────────────────────────
console.log('\n4. it runs before the theme, and 410 is not a redirect');
check('the hook is template_redirect at priority 1 (before any output)',
  /add_action\(\s*'template_redirect',\s*array\(\s*__CLASS__,\s*'maybe_redirect'\s*\),\s*1\s*\)/.test(src), true);
check('an admin or REST request is never redirected at all',
  /if \( is_admin\(\) \|\| \( defined\( 'REST_REQUEST' \)[\s\S]{0,80}return;/.test(src), true);
check('410 sets the status and renders the theme\'s own 404 body', /status_header\(\s*410\s*\)/.test(src), true);
// The one line that must never appear in the 410 branch: a Location header.
// ⚠️ Anchored on the statement that FOLLOWS the branch (`$to = (string)`), not on a
// character count. A fixed-width window is a check whose meaning changes when
// somebody edits a comment nearby — and it failed its own purpose in the first draft:
// a longer 410 branch would have pushed `wp_redirect` out of the window and passed
// while the 410 was sending a redirect.
const goneStart = src.indexOf('410 === $status');
const goneEnd = src.indexOf('$to = (string)', goneStart);
check('the 410 branch was located', goneStart > 0 && goneEnd > goneStart, true);
const gone = goneStart > 0 && goneEnd > goneStart ? src.slice(goneStart, goneEnd) : '';
check('…and a 410 sends NO Location header', /wp_redirect|wp_safe_redirect/.test(gone), false);
check('an external destination is chosen explicitly, not by accident',
  /wp_parse_url\(\s*\$to,\s*PHP_URL_HOST\s*\) !== wp_parse_url\(\s*home_url\(\)/.test(src), true);

// ── 5. the 404 log ──────────────────────────────────────────────────────────
console.log('\n5. the log cannot be flooded into uselessness');
check('it is bounded', /MAX_LOG\s*=\s*\d+/.test(src), true);
// ⚠️ THE EVICTION POLICY IS THE POINT. A bot asking for a thousand unique paths must
// not evict the URL forty visitors a day are hitting, so when the log is full the
// entry with the FEWEST HITS goes — not the oldest.
check('…and it evicts the LEAST-HIT entry, not the oldest', /function sort_rows[\s\S]{0,400}\$hb - \$ha/.test(src), true);
check('…which is also the order it is read in, so one policy not two',
  /function log_rows[\s\S]{0,200}sort_rows/.test(src), true);
check('a storm is not a write on every request (a stated throttle)',
  /LOG_THROTTLE_SECONDS\s*=\s*\d+/.test(src), true);
check('the log is pruned by age as well as by count', /LOG_DAYS\s*=\s*\d+/.test(src), true);
// Clearing IS allowed here, and the difference from the PHP error log is the reason.
check('clearing the log is allowed, and says why it differs from debug.log',
  /function clear_log/.test(src) && /our own record|Morpheus's own record/.test(src), true);

// ── 6. the wiring the app depends on ────────────────────────────────────────
console.log('\n6. wiring');
check('the module is required by the plugin', /require_once MORPHEUS_DIR \. 'includes\/class-redirects\.php';/.test(bootstrap), true);
check('…its front-end hook is registered', /Morpheus_Redirects::init\(\);/.test(bootstrap), true);
check('…and its route', /add_action\( 'rest_api_init', array\( 'Morpheus_Redirects', 'register_routes' \) \);/.test(bootstrap), true);
check('the route is /redirects', /register_rest_route\( MORPHEUS_REST_NS, '\/redirects'/.test(src), true);
check('…and it verifies the signed body like every other write route', /Morpheus_REST::verified_body\(\s*\$request\s*\)/.test(src), true);
check('it advertises itself on /status', /'redirects'\s*=>/.test(rest), true);
check('…without putting site activity on an unauthenticated route', /'not_found'/.test(rest), false);
// Both persistent stores are uninstalled (verify-plugin-uninstall.mjs owns the rule;
// this is the reminder that the module has TWO of them).
check('both of its options are removed on uninstall',
  /delete_option\( 'morpheus_redirects' \)/.test(uninstall) && /delete_option\( 'morpheus_404_log' \)/.test(uninstall), true);

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log('\n✗ a redirect list that can lock the owner out is worse than no redirect list\n');
  process.exit(1);
}
console.log('Redirects hold, and the owner can always get back into wp-admin.\n');
