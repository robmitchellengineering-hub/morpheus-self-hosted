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
  normaliseFix, FIX_KINDS,
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
// Parsed, not pinned: the set has grown twice (policy, then apply, then fix) and
// an assertion listing them literally made each addition fail for the wrong
// reason. The invariant is that the set is declared in one place and that every
// member has a branch — a declared action with no handler is the real bug.
const actionsBlock = fn.match(/const ACTIONS = new Set\(\[([^\]]*)\]\)/);
const declared = actionsBlock ? [...actionsBlock[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
check('the handler declares its actions in one place', declared.length >= 4, true);
// `scan` is the DEFAULT: it has no branch because it is what happens when no
// other action matches, so demanding a branch for it failed on correct code.
// What matters is that every OTHER action is branched, and that the fall-through
// is still the scan.
const DEFAULT_ACTION = 'scan';
check('…every other declared action has a branch', declared.filter((a) => a !== DEFAULT_ACTION && !fn.includes(`action === '${a}'`)), []);
check('…and the default action is the one that scans', new RegExp(`scanSite\\(user, projectId, \\{ force: body\\?\\.force === true \\}\\)`).test(fn), true);
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
// The deploy scope is an explicit list on purpose: it is the whole granted privilege,
// and adding a function to it is a decision (see widgetToken.js). Uptime joined it on
// 2026-10-08 — it READS /status and records an observation in Morpheus's own table, and
// writes nothing to the site.
check('a widget token with the deploy scope can scan', /deploy: \['wordPressDeploy', 'siteHealth', 'siteUptime'\]/.test(widget), true);
// And the surface that uses it is the one that already shows a site's health, so the
// scope entry is not privilege handed out for a function nobody calls (H19's shape,
// one level up).
const uptimePanel = read('src/components/matrix/website/UptimePanel.jsx');
check('…and the uptime panel invokes exactly that function',
  [...new Set([...uptimePanel.matchAll(/functions\.invoke\(\s*'([A-Za-z0-9_]+)'/g)].map((m) => m[1]))], ['siteUptime']);
check('…and it is mounted on the health surface', /<UptimePanel\b/.test(read('src/components/matrix/website/HealthTab.jsx')), true);

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
// A test that can only fail where we run it is not a finding. WordPress's own
// `rest_availability` test attaches the CALLER'S login to a request the site makes
// to its own REST API, then asks for a context only a logged-in editor may see. A
// signed scan has no session, so that request carries no nonce, WordPress
// de-authenticates it by its own rule, and the answer is 401 on EVERY site no
// matter what the host does. It was reported as "something is intercepting
// /wp-json/ — usually a security plugin or the host", which sent the operator to
// their host about a finding Morpheus had manufactured. Found live 2026-10-08.
check('a test that measures the caller\'s session is skipped, not run',
  /if \( isset\( \$session_bound\[ \$id \] \) \) \{\s*continue;\s*\}/.test(plugin), true);
check('…and it is skipped by the list of session-bound ids', /\$session_bound\s*=\s*self::session_bound_tests\(\)/.test(plugin)
  && /'rest_availability' => /.test(plugin), true);
check('…and it is reported as NOT RUN, with the reason, rather than as a verdict',
  /array_merge\( self::async_tests\(\), self::session_bound_not_run\(\) \)/.test(plugin), true);
// The other half of the same claim: the copy that accused the host is gone.
// Comments are stripped first — the entry's own comment QUOTES the sentence it
// replaced while explaining why, and a raw scan collects that explanation as if it
// were still the copy (the trap verify-traffic.mjs and verify-seo.mjs both record).
const fixesPhp = read('wp-plugin/morpheus/includes/class-fixes.php')
  .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('…and nothing still blames a security plugin or the host for it', /Something is intercepting/.test(fixesPhp), false);

console.log('\n9. every finding can be acted on')

// The pure mapper is the ONLY path from the plugin's registry to a button, so if
// it drops `fix` the whole engine is invisible while working perfectly. (It did.)
const withFix = findings({
  tests: [{ id: 'php_version', label: 'PHP', status: 'recommended', fix: { kind: 'guided', label: 'Ask your host', does: 'x', steps: [{ text: 'step', link: '/wp-admin/site-health.php' }] } }],
  own_checks: [{ id: 'morpheus_file_editor', label: 'Editor', status: 'recommended', fix: { kind: 'auto', label: 'Disable it', does: 'y' } }],
});
check('the mapper carries an action through', withFix.every((f) => !!f.fix), true);
check('…with the kind intact', withFix.map((f) => f.fix.kind).sort(), ['auto', 'guided']);
check('…and the button label', withFix.find((f) => f.fix.kind === 'auto').fix.label, 'Disable it');
check('a finding with no action still comes through', findings({ tests: [{ id: 'x', label: 'X', status: 'good' }] })[0].fix, null);

// The site's RECORD of the last attempt at a finding travels with it, so a
// refusal the operator already met is on the row they are looking at — and it
// survives a reload because it comes from the scan, not from the panel. The
// sentence is derived from the site's own outcome/code/message by attemptLine();
// only an explicit `done` reads as success, and an absent record is no line at
// all rather than a reassuring one. (The clean scan's mapper is asserted in
// scripts/verify-clean-site.mjs; this is the health mapper's half.)
const recorded = findings({
  tests: [{ id: 'debug_enabled', label: 'Debug mode', status: 'recommended', last_attempt: { outcome: 'refused', code: 'NOT_SERVED', message: 'the host answers with something else', at: '2026-09-23T12:00:00+00:00' } }],
  own_checks: [{ id: 'morpheus_loopback', label: 'Loopback', status: 'good', last_attempt: { outcome: 'done', message: 'asked WordPress to run the overdue events' } }],
});
check('the health mapper carries the site\'s recorded attempt', recorded[0].last_attempt?.outcome, 'refused');
check('…as the sentence the panel renders', recorded[0].attempt_line, 'Last attempt refused (2026-09-23 12:00 UTC) [NOT_SERVED]: the host answers with something else');
check('…and the finding\'s own status is untouched by it', recorded[0].status, 'recommended');
check('a done record reads as the last successful fix', /^Last successful fix/.test(recorded[1].attempt_line), true);
check('a finding with no record carries no line', findings({ tests: [{ id: 'x', label: 'X', status: 'good' }] })[0].attempt_line, null);

// A button must never be built from something unrenderable.
check('the four kinds are the only ones', FIX_KINDS, ['auto', 'guided', 'updates', 'none']);
check('an unknown kind is refused, not rendered', normaliseFix({ kind: 'magic', label: 'x' }), null);
check('a guided fix with no steps is refused', normaliseFix({ kind: 'guided', label: 'x', steps: [] }), null);
check('…so "guide me" can never open nothing', normaliseFix({ kind: 'guided', label: 'x', steps: [{ text: '  ' }] }), null);
check('a guided fix with a step is kept', normaliseFix({ kind: 'guided', label: 'x', steps: [{ text: 'do this' }] }).steps.length, 1);
check('an empty step link becomes null, not ""', normaliseFix({ kind: 'guided', label: 'x', steps: [{ text: 's', link: '' }] }).steps[0].link, null);
check('a missing fix is null, not an empty object', normaliseFix(undefined), null);
check('a warning is carried when the action needs one', normaliseFix({ kind: 'auto', label: 'x', warning: 'careful' }).warning, 'careful');

// And the handler routes it to the site.
// Parsed, not pinned: the set grew again when CLEAN MY SITE arrived (`clean`),
// and an assertion listing members literally fails for the wrong reason each
// time. What must hold is that the set is declared in ONE place and every member
// is handled — the same shape as the loop above. Whether `clean` is safe is
// asserted in scripts/verify-clean-site.mjs, which owns that subject.
const actionSet = fn.match(/const ACTIONS = new Set\(\[([^\]]*)\]\)/);
const actionNames = actionSet ? [...actionSet[1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]) : [];
check('the action set is declared once and includes every moved action', ['scan', 'policy', 'apply', 'fix', 'updates', 'clean'].every((a) => actionNames.includes(a)), true);
check('…sending only the finding id to the site', /wpFix\(conn, finding\)/.test(fn), true);
check('…and refusing an empty id', /finding id required/.test(fn), true);
// A site declining (409) is an answer, not a failure.
check('a declined fix is not reported as an error', /res\.status !== 200 && res\.status !== 409/.test(fn), true);
check('a plugin too old is named', /PLUGIN_TOO_OLD/.test(fn), true);
check('the client sends nothing but the id', /wpCall\(conn, 'fix', \{ id \}\)/.test(read('server/src/lib/wpPlugin.js')), true);

// A fix that worked must not leave its own finding sitting on the screen. The
// panel re-reads the site after a successful fix and only FIX ALL opts out,
// because FIX ALL scans once when the whole run is over. Without this the
// finding stays there until an operator happens to find RESCAN, which is the
// dead end this screen exists to remove. Scoped to the two functions, so a
// scan elsewhere in the file cannot satisfy these.
const ui = read('src/components/matrix/website/HealthTab.jsx');
const fixBody = ui.slice(ui.indexOf('const applyFix = useCallback'), ui.indexOf('const jumpToUpdates'));
const fixAllBody = ui.slice(ui.indexOf('const runFixAll = async'), ui.indexOf('const setField ='));
check('the fix body was found to assert against', fixBody.length > 0, true);
check('a fix that worked re-reads the site itself', /if \(payload\.ok === true && opts\.rescan !== false\) await run\(true\);/.test(fixBody), true);
check('…exactly once, so the page does not scan in a loop', (fixBody.match(/await run\(true\)/g) || []).length, 1);
check('…and a declined or rejected fix re-checks nothing', /if \(payload\.ok === true &&/.test(fixBody) && !/^\s*await run\(true\);$/m.test(fixBody), true);
check('the rescan is a real dependency of the callback', /\}, \[projectId, run\]\)/.test(fixBody), true);
// The VARIABLE was renamed when FIX ALL moved onto the task runner (it carries a
// plain {id,label} now); the claim is that the loop still opts out of the per-item
// scan, so the assertion is on the option rather than on the argument's name.
check('FIX ALL opts out of the per-item scan', /applyFix\(\w+, \{ rescan: false \}\)/.test(fixAllBody), true);
check('…so nothing scans inside the loop', /applyFix\(f\)(?!,)/.test(fixAllBody), false);

// ── the plugin's own update channel ─────────────────────────────────────────
//
// A site could be told "nothing to update" when there was one: the published
// manifest is cached, and WordPress's own "Check again" re-runs the check
// against that same cached answer. Measured in a real WordPress — offer absent,
// still absent after a forced check, and only clearing the cache produced it.
// The escape hatch is a forced check, and it has to be honest about WHY it found
// nothing, because "no update available" to a question that could not be asked
// is what hid the problem.
const wpPluginSrc = read('server/src/lib/wpPlugin.js');
check('a forced update check exists', /export async function wpUpdates\(conn/.test(wpPluginSrc), true);
check('…sending only the action', /wpCall\(conn, 'updates', \{ action \}\)/.test(wpPluginSrc), true);
check('…and routes it to the site', /wpUpdates\(conn, \{ action: 'check' \}\)/.test(fn), true);
check('a build without the route is named, not reported as a failure', /UPDATES_UNSUPPORTED/.test(fn), true);
check('…with the action that actually works', /install the current plugin from morpheus\.nz once, by hand/i.test(fn), true);

const restSrc = read('wp-plugin/morpheus/includes/class-rest.php');
check('the plugin registers the route', /register_rest_route\( MORPHEUS_REST_NS, '\/updates'/.test(restSrc), true);
check('…and the handler verifies the signature', /function handle_updates[\s\S]{0,600}verified_body\( \$request \)/.test(restSrc), true);
check('the plugin refuses anything but a check', /The only update action is "check"/.test(restSrc), true);

const updSrc = read('wp-plugin/morpheus/includes/class-updates.php');
check('the check clears the plugin manifest cache', /delete_transient\( self::CACHE_KEY \)/.test(updSrc), true);
check('…and WordPress\u2019s own update transient', /delete_site_transient\( 'update_plugins' \)/.test(updSrc), true);
check('…and explains itself when the manifest cannot be read', /'reason'\s*=>\s*\$reachable \? null/.test(updSrc), true);
check('a failed read records why', /self::\$last_failure = /.test(updSrc), true);
check('the cache window can self-heal within an hour', /CACHE_TTL\s*=\s*HOUR_IN_SECONDS/.test(updSrc), true);

const setupSrc = read('src/components/matrix/website/SetupTab.jsx');
check('the panel can force the check', /action: 'updates'/.test(setupSrc), true);
check('…as a labelled action', /CHECK FOR UPDATES/.test(setupSrc), true);
check('the check result is always rendered when present', /\{upd && <UpdateCheckReport/.test(setupSrc), true);
check('an unreachable update server is reported as such', /could not read the published version list/.test(setupSrc), true);
// The zip is the one path a cache cannot take away, so it is no longer rendered
// only for pre-0.5.3 builds.
check('the zip is offered whatever the check says', /Always offered, whatever the check says/.test(setupSrc), true);

console.log('\n10. the error log is read, not just measured');

// THE OTHER HALF OF A CHECK THIS PLUGIN HAS ALWAYS HAD. `Morpheus_Clean::
// debug_log_state()` opens wp-content/debug.log to decide whether the web server is
// SERVING it, by comparing its bytes with the URL's. That answers "is this file a
// leak" and nothing else — so "what is breaking on my site?" had no answer anywhere
// in the product, in Morpheus or in wp-admin.
const healthSrc = read('wp-plugin/morpheus/includes/class-health.php');
const restLogSrc = read('wp-plugin/morpheus/includes/class-rest.php');
const pluginSrc = read('server/src/lib/wpPlugin.js');
const scanSrc = read('server/src/lib/siteScan.js');
const fnSrc = read('server/src/functions/siteHealth.js');
const panelSrc = read('src/components/matrix/website/ErrorLogPanel.jsx');

check('the plugin reads the log', /public static function log_tail\s*\(/.test(healthSrc), true);
// BOUNDED three ways, because a log is the one file on a site that can be gigabytes.
check('…seeking from the END, so the whole file is never read',
  /if \( \$read < \$size \) \{\s*@fseek\( \$fh, -\$read, SEEK_END \);/.test(healthSrc), true);
check('…with literal caps on bytes, lines and groups',
  /LOG_TAIL_BYTES\s*=\s*\d+/.test(healthSrc) && /LOG_TAIL_LINES\s*=\s*\d+/.test(healthSrc) && /LOG_MAX_GROUPS\s*=\s*\d+/.test(healthSrc), true);
check('…and every cap is REPORTED when it bites, never a silent truncation',
  /'truncated'\s*=>/.test(healthSrc) && /groups_total/.test(healthSrc) && /lines_read/.test(healthSrc) && /lines_in_tail/.test(healthSrc), true);
// Four different answers. The plugin names which one, so the panel can never render
// an empty list as "all clear" — the worst reading this feature could produce.
check('the nothing-to-read cases are named, not collapsed into "no errors"',
  ["'missing'", "'unreadable'", "'empty'"].every((s) => healthSrc.includes(s)), true);

// READ-ONLY, and that is the whole contract: a log is the operator's evidence, and
// deleting it is the one thing this feature must never do.
const logBody = healthSrc.slice(healthSrc.indexOf('public static function log_tail'));
check('the reader writes nothing at all', /unlink\(|fwrite\(|file_put_contents\(|rename\(|ftruncate\(/.test(logBody), false);
check('…and /health dispatches exactly health, clean and logs',
  [...new Set([...restLogSrc.matchAll(/'(health|clean|logs|clear|rotate|truncate|purge|delete)'\s*[!=]==\s*\$action/g)].map((m) => m[1]))].sort(),
  ['clean', 'health', 'logs']);
check('the app has a client for it', /export async function wpLogs\s*\(/.test(pluginSrc), true);
check('…posting the action on the one signed route', /wpCall\(conn, 'health', \{ action: 'logs'/.test(pluginSrc), true);
check('a payload that is not a log is refused, not read as "no errors"',
  /PLUGIN_TOO_OLD/.test(scanSrc) && /Array\.isArray\(log\.groups\)/.test(scanSrc), true);
check('…and the action is in the function\'s allow-list', /ACTIONS = new Set\(\[[^\]]*'logs'/.test(fnSrc), true);

// THE PANEL MUST NOT READ ON OPEN. A log tail is the one thing on this tab that can
// be megabytes, and opening a tab is not a request to read it.
//
// ⚠️ THE FIRST VERSION OF THIS CHECK WAS SATISFIED BY ITS OWN SUBJECT'S COMMENT.
// It grepped for `useEffect` in the file, and the component's doc-comment says "no
// useEffect, deliberately" — so it went red on a correct file and would have gone
// GREEN on a broken one that kept the sentence. H19's exact shape. Comments are now
// stripped first, and the claim is asserted twice: the hook is not imported, and no
// effect is called at all — the second is what the mutation below actually breaks.
const panelCode = panelSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
check('the panel imports no effect hook', /import\s*\{[^}]*useEffect[^}]*\}\s*from\s*'react'/.test(panelCode), false);
check('…and calls no effect at all', /useEffect\s*\(/.test(panelCode), false);
check('…and the fetch is wired to a press', /onClick=\{run\}/.test(panelCode) && /const run = async \(\)/.test(panelCode), true);
check('…rendering the plugin\'s own reason rather than an empty list',
  /NOT_READ/.test(panelSrc) && /not_read/.test(panelSrc), true);
check('…and offering no way to clear or delete the log', /clear the log|CLEAR LOG|DELETE/i.test(panelSrc), false);

console.log(`\n${pass}/${pass + fail} checks passed`)
if (fail) {
  console.log('\nA health screen is believed. A wrong verdict here is worse than no screen.\n')
  process.exit(1)
}
console.log('all good\n')
