// Site health: the rules that decide what an operator is told about their site.
//
// WHY THIS EXISTS
//
// A health screen is believed. Its failure mode is not a crash — it is a wrong
// verdict, or a real verdict presented as something it is not:
//
//   * a score. "Health: 82%" invites optimising the number instead of the site,
//     and there is no honest way to weight a missing PHP extension against an
//     open registration form. This module must never produce one.
//   * our opinion wearing WordPress's badge. Morpheus's own checks and
//     WordPress's Site Health tests are different authorities; the payload keeps
//     the source on every finding for exactly that reason.
//   * "no updates available" read as reassurance on a site that has not asked
//     wordpress.org in a week. Age is part of the answer.
//   * an absent test read as a passing one. WordPress runs six of its tests from
//     the browser; a signed server scan cannot, so they are reported as not-run
//     with the reason.
//   * a "fix" offered on a site where files cannot be written at all.
//
// The imported module is pure and dependency-free, which is what lets this run
// in CI's no-install guards job (hazard H4). It must never import
// lib/wpPlugin.js, which reaches Prisma.
//
// Run:  node scripts/verify-site-health.mjs
import { readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  findings, summarise, attention, dataFreshness, canApply, updatePlan, isPluginTooOld,
  severityRank, describeAge, SEVERITY_ORDER, SOURCE_LABELS, STALE_AFTER_HOURS,
} from '../server/src/lib/siteHealth.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
let fail = 0;
const problems = [];

function check(name, got, want) {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) {
    console.log(`          expected ${JSON.stringify(want)}\n          got      ${JSON.stringify(got)}`);
    problems.push(name);
  }
  ok ? pass++ : fail++;
}

// A scan with a deliberate mix, including the two shapes that matter: a
// Morpheus check and a WooCommerce-registered test alongside core's own.
const SCAN = {
  wp_version: '7.1.1',
  php_version: '8.2.33',
  update_checked_at: Math.floor(Date.now() / 1000) - 3600,
  tests: [
    { id: 'php_version', label: 'PHP Version', status: 'recommended', badge: 'Performance', description: 'PHP is older than recommended.', links: [{ url: 'https://site/wp-admin/options-general.php', label: 'Manage' }], source: 'wordpress' },
    { id: 'debug_enabled', label: 'Debug mode', status: 'critical', badge: '', description: 'Logging to a file.', links: [] },
    { id: 'http_requests', label: 'HTTP Requests', status: 'good', badge: '', description: 'Fine.', links: [] },
    { id: 'woocommerce_secure_connection', label: 'WooCommerce secure connection', status: 'critical', badge: 'WooCommerce', description: 'Not HTTPS.', links: [] },
  ],
  own_checks: [
    { id: 'morpheus_can_update_files', label: 'Morpheus can write files', status: 'good', description: 'Writable.', source: 'morpheus' },
    { id: 'morpheus_file_editor', label: 'File editor disabled', status: 'recommended', description: 'It is available.', source: 'morpheus' },
  ],
  updates: {
    counts: { plugins: 1, themes: 0, wordpress: 1, translations: 0, total: 2 },
    plugins: [{ file: 'akismet/akismet.php', name: 'Akismet', version: '5.0', new_version: '5.1' }],
    themes: [],
    core: [{ current: '7.1.1', version: '7.2', response: 'upgrade' }],
    checked_at: Math.floor(Date.now() / 1000) - 3600,
  },
  host: { filesystem_method: 'direct', plugin_dir_writable: true, can_update_files: true, blockers: [] },
  can: { update_files: true, reason: null },
};

console.log('\n1. every finding is ordered worst-first and keeps its source')

check('critical before recommended before unknown before good', SEVERITY_ORDER, ['critical', 'recommended', 'unknown', 'good']);
const all = findings(SCAN);
check('no finding is lost', all.length, SCAN.tests.length + SCAN.own_checks.length);
// Six findings: four WordPress tests plus two of ours.
check('the list is ordered by severity', all.map((f) => f.status), ['critical', 'critical', 'recommended', 'recommended', 'good', 'good']);
// WordPress's own tests and ours both come through, each labelled — presenting
// our opinion as WordPress's verdict is the lie that makes the real ones useless.
check('WordPress findings are labelled as WordPress', all.filter((f) => f.source === 'wordpress').every((f) => f.sourceLabel === SOURCE_LABELS.wordpress), true);
check('Morpheus findings are labelled as Morpheus', all.filter((f) => f.source === 'morpheus').every((f) => f.sourceLabel === SOURCE_LABELS.morpheus), true);
// A test registered by another plugin (WooCommerce) is still WordPress's Site
// Health telling us, not a Morpheus opinion.
check('a plugin-registered test is attributed to WordPress', all.find((f) => f.id === 'woocommerce_secure_connection')?.source, 'wordpress');
check('an unrecognised status sorts last, not first', severityRank('weird') > severityRank('good'), true);
// Stability: an unchanged site must read the same twice.
check('ordering is stable for equal severities', findings(SCAN).map((f) => f.id), findings(SCAN).map((f) => f.id));

console.log('\n2. the summary counts, and never scores')

const s = summarise(SCAN);
check('critical count', s.critical, 2);
check('recommended count', s.recommended, 2);
check('total', s.total, 6);
check('attention = critical + recommended', s.attention, 4);
check('the headline names the number that needs fixing', /2 things need fixing now/.test(s.headline), true);
// The one thing a health screen must never show. A score cannot be defended:
// it would have to weigh an open registration form against a missing extension.
check('the summary has no score, percentage or grade field', Object.keys(s).some((k) => /score|percent|grade|rating|health_index/i.test(k)), false);
check('…and no such field is anywhere in the payload shape', Object.keys(s).sort(), ['attention', 'critical', 'good', 'headline', 'recommended', 'total', 'unknown']);

const nothing = summarise({ tests: [], own_checks: [] });
check('an empty scan is not reported as a clean site', /not the same as a clean site/.test(nothing.headline), true);
check('a clean scan says so plainly', summarise({ tests: [{ id: 'a', label: 'A', status: 'good' }] }).headline, 'Every check passed.');

console.log('\n3. "nothing to update" carries the age of the claim')

const fresh = dataFreshness(SCAN, Date.now());
check('a recent check is not stale', fresh.stale, false);
check('…and says how long ago', /1 hour ago/.test(fresh.message), true);
// A site whose cron or outbound requests are broken reports zero updates
// forever — and is exactly the site that needs updating.
const old = dataFreshness({ update_checked_at: Math.floor(Date.now() / 1000) - 3 * 86400 }, Date.now());
check('a three-day-old check is stale', old.stale, true);
check('…and says the list cannot be trusted', /may be out of date/.test(old.message), true);
check('…and explains why a site can lie about updates', /wordpress\.org reports "no updates" indefinitely/.test(old.message), true);
const never = dataFreshness({}, Date.now());
check('a site that has never checked is stale', never.stale, true);
check('never-checked is reported as unknown, not as fresh', never.known, false);
check('…with an instruction rather than a shrug', /Open Dashboard → Updates/.test(never.message), true);
check('the staleness threshold is a day (WordPress checks twice daily)', STALE_AFTER_HOURS, 24);
check('age reads in minutes', describeAge(5 * 60 * 1000), '5 minutes');
check('age reads in days past 48 hours', describeAge(3 * 86400 * 1000), '3 days');

console.log('\n4. a fix is never offered where files cannot be written')

const okApply = canApply(SCAN);
check('a writable site can be updated', okApply.ok, true);
const blockers = canApply({ host: { can_update_files: false, blockers: ['DISALLOW_FILE_MODS is set in wp-config.php, which forbids all file changes from WordPress', 'the plugins directory is not writable by PHP'] } });
check('a blocked site cannot', blockers.ok, false);
check('…and every blocker is passed through, not summarised away', blockers.reasons.length, 2);
check('…and the message says Morpheus will not ask for credentials', /will not ask you for FTP or SSH credentials/.test(blockers.message), true);
// The `can` block is the plugin's own summary; when it disagrees with host, the
// explicit answer wins — it is the one written for this purpose.
const disagreeing = canApply({ can: { update_files: false, reason: 'not writable' }, host: { can_update_files: true, blockers: [] } });
check('the explicit can.update_files answer wins', disagreeing.ok, false);
check('…and its reason is shown', disagreeing.reasons, ['not writable']);
const silent = canApply({ host: { can_update_files: false, blockers: [] } });
check('a site that does not say why still gets a sentence', /did not say why/.test(silent.message), true);

console.log('\n5. updates are described, and core is called out separately')

const plan = updatePlan(SCAN);
// One plugin + no themes + one core update.
check('total counts plugins, themes and core', plan.total, 2);
check('core is flagged separately from patches', plan.hasCore, true);
check('the message names what and how many', /2 updates available: 1 plugin, WordPress itself/.test(plan.message), true);
check('nothing to update is said plainly', updatePlan({ updates: { counts: { total: 0 } } }).message, 'Nothing to update.');
check('a missing updates block does not throw', updatePlan({}).total, 0);

console.log('\n6. an old plugin is named, not surfaced as a WordPress error')

// Both shapes were learned the hard way on the working-copy pull: the route
// missing is 404 rest_no_route, the action missing is 400 unknown_action.
const r404 = isPluginTooOld({ status: 404, data: { code: 'rest_no_route', message: 'No route was found matching the URL and request method.' } }, '0.5.6');
check('404 rest_no_route is recognised', r404.tooOld, true);
check('…and the message names the running version', /runs plugin 0\.5\.6/.test(r404.message), true);
check('…and tells the operator to update the plugin', /Update the plugin from wp-admin/.test(r404.message), true);
check('400 unknown_action is recognised', isPluginTooOld({ status: 400, data: { code: 'unknown_action' } }, null).tooOld, true);
check('501 unsupported is recognised', isPluginTooOld({ status: 501, data: { code: 'unsupported' } }, null).tooOld, true);
check('a 404 with no WordPress code is not assumed to be an old plugin', isPluginTooOld({ status: 404, data: { message: 'Not found.' } }, null).tooOld, false);
check('a 500 is not an old plugin', isPluginTooOld({ status: 500, data: {} }, null).tooOld, false);
check('a successful response is not an old plugin', isPluginTooOld({ status: 200, data: {} }, null).tooOld, false);

console.log('\n7. the wiring')

// The scan moved into lib/siteScan.js so the panel and the monthly schedule
// share ONE definition of a scan; the handler is now a dispatcher and the policy
// action lives beside it. The invariants are asserted where the code is, not
// where it used to be — but every one of them still holds.
const fn = read('server/src/functions/siteHealth.js');
// The action set grew when applying arrived; what matters is that every declared
// action has a branch and that the rules for the dangerous ones live in
// scripts/verify-site-maintenance.mjs.
check('the handler declares its actions in one place', /ACTIONS = new Set\(\['scan', 'policy', 'apply'\]\)/.test(fn), true);
check('…and every declared action is handled', ['scan', 'policy', 'apply'].every((a) => fn.includes(`'${a}'`)), true);
check('…and refuses anything else rather than ignoring it', /Unknown health action/.test(fn), true);
check('the scan itself is a shared helper, not inlined twice', /scanSite\(user, projectId/.test(fn), true);

const scanLib = read('server/src/lib/siteScan.js');
check('the scan is forced only when asked', /wpHealth\(conn, \{ force \}\)/.test(scanLib), true);
check('the site is asked for its version before blaming the plugin', /wpStatus\(conn\.siteUrl\)/.test(scanLib), true);
check('the derivations are computed server-side and travel with the payload', /summary: summarise\(scan\)/.test(scanLib) && /attention: attention\(scan\)/.test(scanLib), true);
check('the derivations travel with EVERY scan, including a scheduled one', /findings: findings\(scan\)/.test(scanLib) && /can_apply: canApply\(scan\)/.test(scanLib), true);

const client = read('server/src/lib/wpPlugin.js');
check('the health endpoint is a signed POST, not a public GET', /wpCall\(conn, 'health'/.test(client), true);
check('the minimum plugin version is declared once', /MIN_HEALTH_PLUGIN_VERSION = '0\.6\.0'/.test(client), true);

const widget = read('server/src/lib/widgetToken.js');
check('a widget token with the deploy scope can scan', /deploy: \['wordPressDeploy', 'siteHealth'\]/.test(widget), true);

const plugin = read('wp-plugin/morpheus/includes/class-health.php');
check('the plugin loads the admin includes WordPress\'s tests need', /wp-admin\/includes\/admin\.php/.test(plugin), true);
// Core stores a direct test as a method-name SUFFIX; calling it as a callable
// fatals (that is how this was found). Both shapes must be handled.
check('a core test string is resolved to get_test_<name>()', /'get_test_' \. \$entry/.test(plugin), true);
check('a plugin-registered callable is used directly', /is_callable\( \$entry \)/.test(plugin), true);
check('the scan caches, so a panel open does not re-scan the site', /set_transient\( \$cache_key/.test(plugin), true);
check('a forced scan bypasses the cache', /if \( ! \$force \) \{/.test(plugin), true);
// WordPress's own scheduled_events test already answers this; a second answer
// with a different severity is worse than one (this duplicate existed and
// disagreed: critical vs recommended for the same fact).
check('the cron check is not duplicated', /morpheus_cron/.test(plugin), false);
check('the async tests WordPress cannot let us run are reported', /async_not_run/.test(plugin), true);

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nA health screen is believed. A wrong verdict here is worse than no screen.\n')
  process.exit(1)
}
console.log('all good\n')
