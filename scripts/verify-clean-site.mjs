// CLEAN MY SITE: the rules that decide what an operator is told, and what a
// single press is allowed to change on a live site.
//
// WHY THIS EXISTS
//
// A screen that says "cleaned" when nothing happened is worse than no button, and
// this feature removes files from someone's shop. So the four rules are asserted
// as BEHAVIOUR wherever a rule can be made pure, and as source contracts where it
// crosses into PHP:
//
//   1. NEVER DELETE — QUARANTINE. Every removal renames, and the operator is
//      told the backup's name. Asserted: a result with no `quarantined` rows
//      produces no "cleaned" evidence at all, and the PHP mechanisms contain a
//      rename and no delete of the file they move.
//   2. TWO PRESSES, NOT ONE. The scan is its own signed request with its own
//      cache, it does not run when the panel opens, and one press applies only
//      the safe set. Asserted: the plugin's switch, and the app's action name
//      against it.
//   3. ANYTHING RISKY IS `guided`. A modified core file is reported and can
//      never enter the safe set. Asserted on the payload, and the safe set's
//      membership is asserted to come from the SITE's answer rather than a list
//      in this repo — a second list would be a second rule.
//   4. BOUNDED, AND HONEST ABOUT WHAT IT SKIPPED. A skipped check appears in the
//      summary and carries its reason and how far it got.
//
// The imported module is pure (it imports only the equally pure lib/siteHealth.js)
// so this runs in CI's no-install guards job — see verify-guards-no-install.mjs,
// which fails the job if that stops being true.
//
// Run:  node scripts/verify-clean-site.mjs
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CLEAN_ACTION, FIX_ACTION, CLEAN_FINDING_IDS,
  cleanFindings, cleanSummary, cleanLimits, safeSet, reportOnly,
  cleanQuarantineEvidence, cleanUndoLine,
} from '../server/src/lib/siteClean.js';
// The attempt record is turned into the operator's sentence by the same pure
// module the health panel's findings go through — asserted here as BEHAVIOUR,
// because "a recorded attempt must not read as a success" is a rule, not a
// string.
import { attemptRecord, attemptLine } from '../server/src/lib/siteHealth.js';
// Pure and dependency-free on purpose: this is the app half of the guided-step
// link rule, and testing the REAL function here is stronger than any regex over
// its source. See lib/siteLink.js for why it exists at all.
import { resolveSiteLink } from '../src/lib/siteLink.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(REPO, p), 'utf8');
/** Strip PHP comments, so a rule that only appears in prose cannot satisfy a check. */
const stripPhp = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/[^\n]*/g, '$1');

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

// The four ids the plugin's registry marks `auto`. Two of them read `good` in the
// fixture below (nothing to clean), so the PRESS is smaller than the registry —
// that difference is asserted on purpose, further down.
const AUTO_IDS = ['morpheus_public_debug_log', 'morpheus_root_config_backup', 'morpheus_stale_robots_txt', 'morpheus_uploads_php'];
const AUTO_ASKING_IDS = ['morpheus_root_config_backup', 'morpheus_uploads_php'];
const GUIDED_IDS = ['morpheus_admin_users', 'morpheus_core_checksums', 'morpheus_cron_unattributed', 'morpheus_mu_plugins', 'morpheus_plugin_checksums', 'morpheus_recent_files'];

/** A site answer shaped exactly as class-clean.php builds one. */
const find = (id, status, kind, extra = {}) => ({
  id,
  label: `Finding ${id}`,
  status,
  description: `${id} description`,
  fix: kind ? { kind, label: 'Do it', does: 'what it does', steps: kind === 'guided' ? [{ text: 'a step', link: '/wp-admin/' }] : [] } : undefined,
  ...extra,
});

const SCAN = {
  generated_at: '2026-09-23T00:00:00+00:00',
  duration_ms: 4210,
  limits: { seconds: 4.21, hash_files: 3224, hash_files_cap: 4000, uploads_scanned: 900, uploads_cap: 6000, package_plugins: 1, package_plugins_cap: 3, package_bytes: 133795, package_bytes_cap: 4194304 },
  skipped: [],
  findings: [
    find('morpheus_uploads_php', 'critical', 'auto', { details: [{ file: 'wp-content/uploads/2026/09/x.php', size: 812, mtime_iso: '2026-09-22T01:00:00+00:00' }] }),
    find('morpheus_root_config_backup', 'critical', 'auto'),
    find('morpheus_core_checksums', 'critical', 'guided'),
    find('morpheus_plugin_checksums', 'critical', 'guided'),
    find('morpheus_recent_files', 'recommended', 'guided'),
    find('morpheus_mu_plugins', 'recommended', 'guided'),
    find('morpheus_admin_users', 'good', 'guided'),
    find('morpheus_cron_unattributed', 'good', 'guided'),
    find('morpheus_public_debug_log', 'good', 'auto'),
    find('morpheus_stale_robots_txt', 'good', 'auto'),
  ],
};

console.log('\n1. the safe set is the `auto` findings that ask for something');

const safe = safeSet(cleanFindings(SCAN));
check('the safe set is the attention-worthy auto findings and nothing else', [...new Set(safe.map((f) => f.id))].sort(), AUTO_ASKING_IDS);
// A check that PASSED must not cause a change. Both of these are `auto` in the
// registry and read `good` here ("the debug log is not readable over the web",
// "there is no stale robots.txt") — pressing would rename a file in response to
// nothing being wrong. They keep their individual FIX control; they are not in
// the bulk press.
check('a `good` finding is never in the safe set', safe.some((f) => f.status === 'good'), false);
check('an `unknown` finding is never in the safe set', safeSet(cleanFindings({ findings: [find('morpheus_public_debug_log', 'unknown', 'auto')] })), []);

// THE MAPPER'S DEFENSIVE DEFAULT. A finding that arrives with NO status is an
// unanswered question, not a pass: with the default flipped to 'good' it counts
// as a check that succeeded, which is the false-success shape this whole feature
// exists to avoid. Found by mutation — `|| 'unknown'` flipped to `|| 'good'`
// passed this guard until these two checks existed.
const noStatus = cleanSummary({ findings: [{ id: 'morpheus_uploads_php' }] });
check('a finding with no status counts as unknown', noStatus.unknown, 1);
check('…and never as good', noStatus.good, 0);
check('…so it is not in the safe set either',
  safeSet(cleanFindings({ findings: [{ id: 'morpheus_uploads_php' }] })), []);
check('a `guided` auto-looking finding is never in the safe set', safe.some((f) => f.fix.kind !== 'auto'), false);
check('the registry still has four automatic fixes', AUTO_IDS.length, 4);
check('a modified core file is NEVER in the safe set', safe.some((f) => f.id === 'morpheus_core_checksums'), false);
check('a modified plugin file is NEVER in the safe set', safe.some((f) => f.id === 'morpheus_plugin_checksums'), false);
check('an admin-account finding is never in the safe set', safe.some((f) => f.id === 'morpheus_admin_users'), false);
check('a cron finding is never in the safe set', safe.some((f) => f.id === 'morpheus_cron_unattributed'), false);
check('a recently-changed-file finding is never in the safe set', safe.some((f) => f.id === 'morpheus_recent_files'), false);
check('the guided findings are reported separately', [...new Set(reportOnly(cleanFindings(SCAN)).map((f) => f.id))].sort(), [...GUIDED_IDS].sort());

// The set comes from the SITE's answer, not from a list here. If the plugin ever
// downgrades a fix to `guided`, the press must shrink with no change on this side.
const downgraded = safeSet(cleanFindings({
  findings: [find('morpheus_uploads_php', 'critical', 'guided'), find('morpheus_stale_robots_txt', 'critical', 'auto')],
}));
check('a site that marks a fix guided removes it from the safe set', downgraded.map((f) => f.id), ['morpheus_stale_robots_txt']);
check('a finding with no fix at all is not in the safe set', safeSet(cleanFindings({ findings: [find('morpheus_uploads_php', 'critical', null)] })), []);
check('an empty scan yields an empty safe set', safeSet(cleanFindings({})), []);
// A kind this module has never heard of normalises to no fix rather than to a
// button — the health panel's rule, reused rather than re-decided.
check('an unknown fix kind is refused, not rendered', safeSet(cleanFindings({ findings: [find('morpheus_uploads_php', 'critical', 'magic')] })), []);
check('a guided fix with no steps is refused', cleanFindings({ findings: [find('morpheus_admin_users', 'good', 'guided', { fix: { kind: 'guided', label: 'x' } })] })[0].fix, null);

console.log('\n2. worst-first, counted, and never scored');

const ordered = cleanFindings(SCAN);
check('critical findings come first', ordered.slice(0, 4).every((f) => f.status === 'critical'), true);
check('recommended come next', ordered.slice(4, 6).every((f) => f.status === 'recommended'), true);
check('good come last', ordered.slice(6).every((f) => f.status === 'good'), true);
check('no finding is lost in the mapper', ordered.length, SCAN.findings.length);
check('every finding keeps its action', ordered.every((f) => !!f.fix || !SCAN.findings.find((x) => x.id === f.id).fix), true);
// The mapper is the ONLY path from the plugin's scan to a button. If it dropped
// `fix`, the whole engine would be invisible while working perfectly.
check('the mapper carries the fix through', ordered.find((f) => f.id === 'morpheus_uploads_php').fix.kind, 'auto');
check('…and the details the finding is built from', ordered.find((f) => f.id === 'morpheus_uploads_php').details.length, 1);
check('ordering is stable for equal severities', cleanFindings(SCAN).map((f) => f.id), ordered.map((f) => f.id));

const sum = cleanSummary(SCAN);
check('critical count', sum.critical, 4);
check('recommended count', sum.recommended, 2);
check('good count', sum.good, 4);
check('cleanable is the size of the safe set, not of the auto registry', sum.cleanable, 2);
check('the summary has no score, percentage or grade', Object.keys(sum).some((k) => /score|percent|grade|rating|health_index/i.test(k)), false);
check('…and no such field is in the shape', Object.keys(sum).sort(), ['cleanable', 'critical', 'good', 'headline', 'recommended', 'skipped', 'total', 'unknown']);
check('the headline names what can be quarantined', /2 of them can be quarantined here/.test(sum.headline), true);
const nothingAtAll = cleanSummary({ findings: [] });
check('an empty scan is not reported as a clean site', /not the same as a clean site/.test(nothingAtAll.headline), true);
const allGood = cleanSummary({ findings: [find('morpheus_core_checksums', 'good', 'guided')] });
check('a good site has no attention finding', cleanFindings({ findings: allGood.total ? [find('morpheus_core_checksums', 'good', 'guided')] : [] }).filter((f) => f.status === 'critical' || f.status === 'recommended'), []);
check('a good site says so plainly', allGood.headline, 'Nothing was found to clean, and nothing needs reviewing.');

console.log('\n3. bounded, and honest about what it skipped');

const none = cleanLimits({});
check('a scan with no limits and no skips has no caveat', none.hasLimits, false);
check('…and no skipped list', none.skipped, []);
check('…and a missing limits block does not throw', cleanLimits(undefined).measured, []);

const capped = cleanLimits({
  limits: { seconds: 12.5, hash_files: 4000, hash_files_cap: 4000, package_plugins: 0, package_plugins_cap: 3, package_bytes: 0, package_bytes_cap: 4194304 },
  skipped: [{ check: 'core_checksums', reason: 'hit its cap', reached: 4000, of: 3224 }],
});
check('a skipped check produces the caveat', /not a clean bill of health/.test(capped.caveat), true);
check('…and the reason is carried through, not summarised away', capped.skipped[0].reason, 'hit its cap');
check('…with how far it got', [capped.skipped[0].reached, capped.skipped[0].of], [4000, 3224]);
check('the measured numbers include the time it took', /12\.5s/.test(capped.measured.join(' ')), true);
check('…and the core cap it ran under', /4000 of a maximum 4000 core files/.test(capped.measured.join(' ')), true);
check('…and the package cap it ran under', /cap 3/.test(capped.measured.join(' ')), true);
check('a skip with no reason still gets a sentence', cleanLimits({ skipped: [{ check: 'x' }] }).skipped[0].reason, 'the site did not say why this check did not finish');
check('a skip is counted in the summary, not hidden', /1 check could not finish/.test(cleanSummary({ findings: SCAN.findings, skipped: capped.skipped }).headline), true);
check('the summary counts skips from the raw payload', cleanSummary({ findings: SCAN.findings, skipped: [{}] }).skipped, 1);

console.log('\n4. quarantine evidence: no "cleaned" without an undo');

check('a fix with no quarantined rows yields no evidence', cleanQuarantineEvidence({ ok: true, verified: true }, 'morpheus_uploads_php'), null);
check('…even when the site called it a success', cleanQuarantineEvidence({ ok: true, did: 'renamed 1 file' }, 'morpheus_uploads_php'), null);
check('a finding this module does not own yields no evidence', cleanQuarantineEvidence({ quarantined: [{ file: 'a', backup: 'a.bak', verified: true }] }, 'some_other_finding'), null);
const ev = cleanQuarantineEvidence({
  quarantined: [
    { file: 'wp-content/uploads/x.php', backup: '/home/u/x.php.morpheus-bak-20260923120000', verified: true, restored: false },
    { file: 'wp-content/uploads/y.php', backup: '/home/u/y.php.morpheus-bak-20260923120000', verified: true, restored: false },
  ],
}, 'morpheus_uploads_php');
check('two quarantined files are both reported', ev.count, 2);
check('…and every backup path is kept, not collapsed to a count', ev.files.map((f) => f.backup).length, 2);
check('allVerified is true only when every file verified', ev.allVerified, true);
const putBack = cleanQuarantineEvidence({
  quarantined: [{ file: 'x', backup: 'x.bak', verified: false, restored: true }],
}, 'morpheus_uploads_php');
check('a file the site put back is not counted as quarantined', putBack.allVerified, false);
check('…and that is stated', /put back/.test(cleanUndoLine(putBack)), true);
const line = cleanUndoLine(ev);
check('the undo names the original file', /wp-content\/uploads\/x\.php/.test(line), true);
check('…and the backup it became', /x\.php\.morpheus-bak-20260923120000/.test(line), true);
check('…and says nothing was deleted', /nothing deleted/.test(line), true);
check('no evidence means no undo line', cleanUndoLine(null), null);

console.log('\n5. the cross-boundary contract (app action names vs the plugin\'s switch)');

const phpRest = read('wp-plugin/morpheus/includes/class-rest.php');
const phpClean = read('wp-plugin/morpheus/includes/class-clean.php');
const phpFixes = read('wp-plugin/morpheus/includes/class-fixes.php');
const phpBootstrap = read('wp-plugin/morpheus/morpheus.php');
const jsClient = read('server/src/lib/wpPlugin.js');
const jsScan = read('server/src/lib/siteScan.js');
const jsHandler = read('server/src/functions/siteHealth.js');

check('the app\'s clean action has one name', CLEAN_ACTION, 'clean');
check('…and the fix action is the existing one', FIX_ACTION, 'fix');
// The plugin switches on the action that arrived in the signed body. A rename on
// either side is not an error shape the operator can read — it is a health scan
// where a clean scan was asked for, which reads as "nothing found".
check('the plugin switches on that exact action', /'clean' === \$action/.test(phpRest), true);
check('…and only runs the clean scan for it', /if \( 'clean' === \$action \)[\s\S]{0,400}Morpheus_Clean::scan\( \$force \)/.test(phpRest), true);
// The refusal names the actions the route answers, so the message has to grow with
// them (it said "health or clean" until the error-log action arrived). Matched as
// "names health … names clean" rather than as one frozen sentence, because the
// claim is that the refusal is specific, not that its wording never changes —
// verify-site-health.mjs separately pins the route to EXACTLY these three.
check('…and refuses an action it does not know, by name', /action must be health[^']*clean/.test(phpRest), true);
check('the app sends that action to the same route', /wpCall\(conn, 'health', \{ action: 'clean'/.test(jsClient), true);
check('…from the clean scan helper', /wpClean\(conn, \{ force \}\)/.test(jsScan), true);
check('…and the handler has a branch for it', /action === 'clean'/.test(jsHandler), true);
check('…declared in the one action set', /ACTIONS = new Set\(\[[^\]]*'clean'/.test(jsHandler), true);

// The ids are the contract between the scan, the registry and this module. A
// finding the scan emits with no registry entry is UNMAPPED at runtime — a
// description with no action — and a registry entry with no mechanism is a
// NO_MECHANISM the operator only meets by pressing the button.
const registryBlock = phpFixes.slice(phpFixes.indexOf('public static function registry()'), phpFixes.indexOf('public static function for_id'));
const registryIds = [...registryBlock.matchAll(/^\t\t\t'([a-z0-9_]+)'\s*=>\s*array\(/gm)].map((m) => m[1]);
const registryKind = (id) => {
  const start = registryBlock.indexOf(`'${id}'`);
  if (start < 0) return null;
  const next = registryBlock.slice(start + 1).search(/\n\t\t\t'[a-z0-9_]+'\s*=>\s*array\(/);
  const body = next < 0 ? registryBlock.slice(start) : registryBlock.slice(start, start + 1 + next);
  // The LAST 'kind' in the entry, because that is what PHP resolves a duplicate
  // string key to. Taking the first would let a later `'kind' => 'guided'` change
  // the behaviour while this guard still read `auto` — which is exactly how a
  // mutation exposed it.
  const kinds = [...body.matchAll(/'kind'\s*=>\s*'([a-z]+)'/g)].map((m) => m[1]);
  return kinds.length ? kinds[kinds.length - 1] : null;
};
check('the registry parsed (parser sanity)', registryIds.length > 20, true);
const emittedIds = [...new Set([...phpClean.matchAll(/self::finding\(\s*'(morpheus_[a-z0-9_]+)'/g)].map((m) => m[1]))].sort();
// Every id except the robots one, which is CLass-health's finding included here
// rather than re-implemented — the two screens must not be able to disagree
// about whether a stale physical robots.txt is being served.
const ROBOTS_FROM_HEALTH = 'morpheus_stale_robots_txt';
check('the clean scan emits every id this module knows', emittedIds, [...CLEAN_FINDING_IDS].filter((id) => id !== ROBOTS_FROM_HEALTH).sort());
check('…and includes the robots finding from the health scan rather than duplicating it', /Morpheus_Health::robots_finding\(\)/.test(phpClean), true);
check('…which is public on the health class', /public static function robots_finding\(\)/.test(read('wp-plugin/morpheus/includes/class-health.php')), true);
check('every emitted id has a registry entry (no UNMAPPED finding)', emittedIds.filter((id) => !registryIds.includes(id)), []);
check('the ids this module sends back all exist in the registry', CLEAN_FINDING_IDS.filter((id) => !registryIds.includes(id)), []);
check('the safe set in the registry is exactly these four', registryIds.filter((id) => CLEAN_FINDING_IDS.includes(id) && registryKind(id) === 'auto').sort(), AUTO_IDS);
check('every risky id is `guided` in the registry', GUIDED_IDS.map((id) => [id, registryKind(id)]), GUIDED_IDS.map((id) => [id, 'guided']));
check('no clean id is `updates` or `none`', CLEAN_FINDING_IDS.map((id) => registryKind(id)).filter((k) => k !== 'auto' && k !== 'guided'), []);

console.log('\n6. the plugin\'s own rules');

// Rule 2, as code: the clean scan is a separate action, is cached, and the light
// health scan does not call it. A panel open runs the health scan — if clean had
// been folded into it, every open would checksum the site.
check('the clean scan is not called from the health scan', /Morpheus_Clean::scan/.test(read('wp-plugin/morpheus/includes/class-health.php')), false);
check('its own action is the only caller of the scanner', [...phpRest.matchAll(/Morpheus_Clean::scan\( \$force \)/g)].length, 1);
check('it caches, so a re-open re-reads rather than re-hashes', /set_transient\( self::CACHE_KEY/.test(phpClean), true);
check('a forced scan bypasses the cache', /if \( ! \$force \) \{/.test(phpClean), true);
check('the cache is its own key, not the health scan\'s', /CACHE_KEY = 'morpheus_clean_scan'/.test(phpClean), true);
check('the module is loaded by the plugin bootstrap', /require_once MORPHEUS_DIR \. 'includes\/class-clean\.php'/.test(phpBootstrap), true);
// "At or beyond", not equality: pinning the exact version made this check fail
// the first time an unrelated change bumped the plugin, which is a gate failing
// for a reason that is not the code. The claim is that the release that ADDED
// the clean action is in, and — since the served-bytes rule and the attempt
// record change what a scan can be trusted to say — that the current build is
// past it.
const versionOf = (src) => (src.match(/MORPHEUS_VERSION',\s*'([\d.]+)'/) || [, ''])[1];
const atLeast = (v, min) => {
  const a = String(v).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
};
check('the plugin version moved for the new action', atLeast(versionOf(phpBootstrap), '0.8.4'), true);
check('…and past it for the served-bytes rule and the attempt record', atLeast(versionOf(phpBootstrap), '0.8.5'), true);
check('the app names the release that added it', /MIN_CLEAN_PLUGIN_VERSION = '0\.8\.4'/.test(jsClient), true);
// A build older than that IGNORES the body and answers a health scan with no
// `findings` — "nothing found" would be the worst possible reading of that.
check('a stale plugin is caught by the payload shape, not assumed', /Array\.isArray\(scan\.findings\)/.test(jsScan) && /PLUGIN_TOO_OLD/.test(jsScan), true);
// Our own plugin directory is excluded from the recent-files list — it changed
// when this plugin was installed. The exclusion must be slash-bounded: a bare
// prefix also matched any plugin whose directory STARTS with "morpheus", which
// silently dropped real plugins from the check (the harness's fixture plugin is
// what caught it).
check('our own plugin is excluded from recent-files by a bounded path', /trailingslashit\( trailingslashit\( self::slash\(/.test(phpClean), true);
check('the scan writes only its own cache', /file_put_contents|rename\(|unlink\(|wp_delete_file/.test(stripPhp(phpClean.slice(phpClean.indexOf('public static function scan('), phpClean.indexOf('public static function forget(')))), false);

// Rule 4, as code: every expensive loop names a cap constant AND uses it.
for (const cap of ['MAX_HASH_FILES', 'HASH_TIME_BUDGET', 'MAX_UPLOADS_FILES', 'UPLOADS_TIME_BUDGET', 'RECENT_TIME_BUDGET', 'MAX_RECENT_FILES', 'PACKAGE_PLUGINS_CAP', 'PACKAGE_BYTES_CAP', 'PACKAGE_TIME_BUDGET']) {
  check(`${cap} is declared and enforced`, new RegExp(`const ${cap}\\b`).test(phpClean) && new RegExp(`self::${cap}\\b`).test(phpClean), true);
}
check('hitting a cap is recorded as a skip', /self::skip\(\s*\n?\s*\$skipped,/.test(phpClean), true);
check('the payload carries what was skipped', /'skipped'\s*=>\s*\$skipped/.test(phpClean), true);
check('…and the limits it ran under', /'limits'\s*=>\s*\$limits/.test(phpClean), true);
check('…and what the pass cost', /'duration_ms'/.test(phpClean), true);

// The core checksum check has to load the admin helper it depends on. Without it
// the FIRST test is a fatal undefined function with no output at all — the trap
// class-health.php documents and that this scan would have hit again.
check('core checksums use WordPress\'s own published list', /get_core_checksums\( \$version, \$locale \)/.test(phpClean), true);
check('…and load the admin include that provides it', /wp-admin\/includes\/'\s*\.\s*\$file/.test(phpClean), true);
check('…and load update.php specifically', /'update\.php'/.test(phpClean), true);
// "Could not verify" must never read as "clean".
check('an unfetchable checksum list is an unanswered question, not a pass', /could not verify WordPress/.test(phpClean) && /'unknown'/.test(phpClean), true);

// Rule 1, as code: rename, never delete. Scoped to the quarantine functions, so
// write_atomic()'s temp-file unlink cannot satisfy or trip these.
const quarantineBodies = [
  ['quarantine_file', phpFixes.slice(phpFixes.indexOf('private static function quarantine_file('), phpFixes.indexOf('private static function quarantine_result('))],
  ['fix_quarantine_uploads_php', phpFixes.slice(phpFixes.indexOf('private static function fix_quarantine_uploads_php('), phpFixes.indexOf('private static function fix_quarantine_root_config_backups('))],
  ['fix_quarantine_root_config_backups', phpFixes.slice(phpFixes.indexOf('private static function fix_quarantine_root_config_backups('), phpFixes.indexOf('private static function fix_quarantine_public_debug_log('))],
  ['fix_quarantine_public_debug_log', phpFixes.slice(phpFixes.indexOf('private static function fix_quarantine_public_debug_log('), phpFixes.indexOf('private static function quarantine_file('))],
];
for (const [name, body] of quarantineBodies) {
  const src = stripPhp(body);
  check(`${name}: the body was found to assert against`, src.length > 200, true);
  check(`${name}: it never deletes the file it quarantines`, /unlink\(|wp_delete_file|file_put_contents\( *\$file/.test(src), false);
}
check('the move is a rename', /@rename\( \$file, \$dest \)/.test(stripPhp(quarantineBodies[0][1])), true);
check('…and the timestamp is UTC, so two sites read the same', /gmdate\( 'YmdHis' \)/.test(stripPhp(phpFixes)), true);
check('the backup is verified byte-for-byte before the move is trusted', /md5_file\( \$dest \) === \$digest/.test(stripPhp(phpFixes)), true);
check('…and the original path must be empty', /is_file\( \$file \) \)/.test(stripPhp(phpFixes)), true);
check('a file that did not verify is renamed straight back', /@rename\( \$dest, \$file \)/.test(stripPhp(phpFixes)), true);
check('a served file is re-requested over HTTP and must stop answering', /self::fetch_public\( add_query_arg\( 'morpheus-verify'/.test(stripPhp(phpFixes)), true);
check('a file still being served is put back and said so', /still returns its contents/.test(phpFixes), true);
check('the quarantine target prefers somewhere OUTSIDE the web root', /dirname\( rtrim\( str_replace/.test(stripPhp(phpFixes)), true);
check('…and falls back to the plugin\'s own protected state directory', /MORPHEUS_STATE_DIR \) \. 'quarantine'/.test(stripPhp(phpFixes)), true);
check('…refusing when nothing writable is available', /there is nowhere Morpheus may put the file/.test(phpFixes), true);
// The rename is not a quarantine if it leaves the same bytes readable under a
// longer name. A file that was being SERVED is only moved into a path the site
// serves if that path can be shown to refuse it — the branch the harness runs
// twice, once with a deny rule and once without.
check('a served file is only quarantined if the backup is provably not served', /probe_serves\( \$target\['url'\], \$digest \)/.test(stripPhp(phpFixes)), true);
check('…and an unanswerable check refuses rather than guessing', /could not confirm that/.test(phpFixes) && /stops handing the file out/.test(phpFixes), true);
check('…and a served backup is renamed straight back', /\$give_back\( 'the backup would be just as readable at '/.test(phpFixes), true);
check('the fix re-enumerates instead of trusting the cached scan', /Morpheus_Clean::uploads_php_files\(\)/.test(stripPhp(phpFixes)) && /Morpheus_Clean::root_config_backup_files\(\)/.test(stripPhp(phpFixes)), true);
check('…and refuses when the file is already gone, rather than reporting a success', /is no longer there/.test(phpFixes) && /any more — something removed it since the scan/.test(phpFixes), true);
// The caller names a finding, never a path. This is what stops a leaked widget
// token turning /fix into arbitrary file moves on a customer's site.
// The undo is only real if the site's answer carries the files it moved. The
// harness proves the behaviour end to end; this is the cheap source half, so a
// refactor that empties the list cannot pass unnoticed on the way to the harness.
check('the fix result carries the files it moved', /'quarantined'\s*=>\s*\$rows/.test(stripPhp(phpFixes)), true);
check('…and each row names the backup it became', /'backup'\s*=>\s*\$q\['backup'\]/.test(stripPhp(phpFixes)), true);
check('…and the app reads them into the undo line', /cleanQuarantineEvidence\(res\.data, finding\)/.test(jsHandler), true);
// H12's class, one file over: an identifier that is USED and never imported
// resolves fine at parse time and throws at the first request that reaches it.
// `isPluginTooOld` sat that way on main in this exact branch — every fix against a
// site answering a non-200 died with "isPluginTooOld is not defined" instead of the
// sentence the operator needs. The browser caught it; this keeps it caught.
for (const helper of ['isPluginTooOld']) {
  check(`${helper} is imported wherever it is used`, new RegExp(`import \\{[^}]*\\b${helper}\\b[^}]*\\} from`).test(jsHandler), true);
}
check('the app sends only the finding id', /wpCall\(conn, 'fix', \{ id \}\)/.test(jsClient), true);
check('the quarantine target is chosen by the plugin, not sent by the caller', /quarantine_target\( \$file \)/.test(stripPhp(phpFixes)) && !/body\['path'\]/.test(phpRest), true);

// Every mechanism a registry entry names must exist, or the operator meets
// NO_MECHANISM only by pressing the button.
const switchBlock = phpFixes.slice(phpFixes.indexOf('switch ( $entry[\'fix\'] )'), phpFixes.indexOf('default:', phpFixes.indexOf('switch ( $entry[\'fix\'] )')));
const mechanisms = [...new Set([...registryBlock.matchAll(/'fix'\s*=>\s*'([a-z_]+)'/g)].map((m) => m[1]))];
check('the registry names mechanisms (parser sanity)', mechanisms.length > 4, true);
check('every mechanism has a case in the switch', mechanisms.filter((m) => !switchBlock.includes(`case '${m}':`)), []);
check('every case names a mechanism the registry uses', [...switchBlock.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]).filter((m) => !mechanisms.includes(m)), []);
check('an unknown mechanism is refused, not ignored', /The registry names a mechanism that does not exist/.test(phpFixes), true);

// Rule 3, as code: the clean fixes are reported and the mechanism list has no
// entry for the guided ids at all — so there is nothing to press that would try.
check('no guided clean finding has a mechanism behind it', GUIDED_IDS.map((id) => registryBlock.slice(registryBlock.indexOf(`'${id}'`)).match(/'fix'\s*=>/)), GUIDED_IDS.map(() => null));
check('a guided finding is refused by apply(), with a code', /'NOT_AUTOMATIC'/.test(phpFixes), true);

console.log('\n7. the app\'s half');

const ui = read('src/components/matrix/website/HealthTab.jsx');
check('the panel has the section', /<Section title="CLEAN MY SITE"/.test(ui), true);
check('the scan is never run by an effect — only by a press', /useEffect\([^)]*\)[\s\S]{0,200}runClean\(/.test(ui), false);
check('…and the press exists', /onClick=\{\(\) => runClean\(true\)\}/.test(ui), true);
check('a declined clean is not shown as cleaned', /scan returned no checks at all/.test(read('server/src/lib/siteClean.js')), true);
// One press, one request per finding, sequential by construction.
const cleanSafeBody = ui.slice(ui.indexOf('const runCleanSafe = async () =>'), ui.indexOf('const setField ='));
check('the safe run was found to assert against', cleanSafeBody.length > 400, true);
check('the safe run takes its targets from the SERVER\'s safe set', /const targets = \(clean\?\.cleanable \|\| \[\]\)/.test(cleanSafeBody), true);
// …and never from the full findings list, which would put a guided finding —
// a modified core file, an account, a cron hook — one press away.
check('…and never from the full findings list', /clean\?\.findings/.test(cleanSafeBody), false);
check('…one at a time, never in parallel', /for \(let i = 0; i < targets\.length/.test(cleanSafeBody) && !/Promise\.all/.test(cleanSafeBody), true);
check('…stopping between findings, never mid-request', /if \(cancelled\(\)\) break;/.test(cleanSafeBody), true);
check('…and re-scanning both surfaces when it is done', /await runClean\(true\);/.test(cleanSafeBody) && /await run\(true\);/.test(cleanSafeBody), true);
check('the confirm names what will be quarantined before anything is sent', /QUARANTINE \{cleanableIds\.length\}/.test(ui) && /Nothing has been sent yet/.test(ui), true);
// The count on the button and the list in the confirm both come from the SAME
// derived set, and that set must be the server's safe set. Deriving it from the
// full findings list would put a guided finding — a modified core file, an
// account, a cron hook — inside a single press.
// The buttons on screen must agree with the set the bulk press applies: a `good`
// finding is rendered WITHOUT its fix control, so nothing offers to change a site
// in response to a check that passed.
check('a clean finding that reads good is rendered without a press', /clean-clear-\$\{t\.id\}-\$\{i\}`\} t=\{t\} quiet withFix=\{false\}/.test(ui), true);
check('the press count comes from the server\'s safe set', /const cleanableIds = \(clean\?\.cleanable \|\| \[\]\)\.map\(\(f\) => f\.id\);/.test(ui), true);
check('…and never from the full findings list', /clean\?\.findings[^\n]*map\(\(f\) => f\.id\)/.test(ui), false);
check('the button is offered only when the safe set is non-empty', /\(clean\.summary\?\.cleanable \|\| 0\) > 0/.test(ui), true);
check('what was skipped is rendered, not just counted', /What this scan did not reach/.test(ui), true);
check('the panel says the scan does not run on its own', /runs only when you ask/.test(ui), true);
// The two surfaces that mount this tab, so a dock-only or panel-only feature is
// caught here rather than by an operator who cannot find the button.
const panel = read('src/components/matrix/WebsitePanel.jsx');
const embed = read('src/pages/Embed.jsx');
check('the WEBSITE panel mounts the tab that carries it', /website\/HealthTab/.test(panel), true);
check('the dock mounts the same tab', /website\/HealthTab/.test(embed), true);

console.log('\n8. every guided step link points at the CUSTOMER site, never at the app');

// The bug this guard was written for: every guided step in class-fixes.php
// carried a root-relative path, the panel rendered it in an href, and the value
// resolved against the ORIGIN THE APP IS LOADED FROM — morpheus.nz — so it hit
// the app's own catch-all route and showed Morpheus's "Page Not Found / the AI
// hasn't implemented this page yet" screen. The operator clicking a link to
// their own site was told the page did not exist.
//
// Both halves are asserted because they ship separately: the plugin must send
// absolute URLs, AND the app must not depend on that being true.
const linkValues = [...stripPhp(registryBlock).matchAll(/'link'\s*=>\s*([^\n]+)/g)]
  .map((m) => m[1].replace(/[\s,]+$/, ''));
check('the guided-step links were parsed out of the PHP (parser sanity)', linkValues.length >= 10, true);
// A literal beginning with `/` is the exact defect. Parsed out of the source (and
// out of the comment-stripped source), so a comment mentioning the old path
// cannot satisfy it and a rewording cannot hide it.
const rootRelative = linkValues.filter((v) => /^['"]\//.test(v));
check('…and none is a root-relative path', rootRelative, []);
// Everything else must be built by a helper that respects where the site's
// admin actually lives. `admin_url()` is the one for a wp-admin screen and is
// what the bug report asked for; home_url()/site_url() cover the site root.
const notSiteBuilt = linkValues.filter((v) => !/^['"]https?:\/\//.test(v)
  && !/^(admin_url|home_url|site_url)\s*\(/.test(v));
check('…and every one is built from a site-URL helper or is absolute', notSiteBuilt, []);
check('the wp-admin links use admin_url(), not a hard-coded /wp-admin/',
  linkValues.filter((v) => /^admin_url\(/.test(v)).length >= 12, true);
// The one link a finding with no screen of its own gets (the Site Health
// fallback, injected below the registry) is a guided step like any other.
check('…including the Site Health fallback link', linkValues.some((v) => /admin_url\( 'site-health\.php' \)/.test(v)), true);

// THE OTHER PLACE PLUGIN URLS REACH THE APP. `class-health.php::links()` lifts
// core's own action hrefs into the findings list, and core's filter can hand it a
// root-relative one — its own comment says so. The app resolves a leading '/' as
// a second line of defence, so removing this resolution does NOT break the
// product: a mutation deleting it passed this guard, which is exactly why the
// plugin must not be allowed to rely on the app. Asserted here rather than left
// to the app-side checks, because "it happens to be caught downstream" is how
// this bug class came back once already.
const healthLinksBody = (() => {
  const src = stripPhp(read('wp-plugin/morpheus/includes/class-health.php'));
  const i = src.indexOf('function links(');
  return i < 0 ? '' : src.slice(i, i + 2000);
})();
check('the health class links() body was located (parser sanity)', healthLinksBody.length > 200, true);
check('…and it resolves a root-relative core action href against the site',
  /strpos\(\s*\$url,\s*'\/'\s*\)/.test(healthLinksBody) && /home_url\(\s*\$url\s*\)/.test(healthLinksBody), true);

// The app half, as BEHAVIOUR: the real resolver, not a regex over its source.
check('a root-relative step link resolves against the connected site',
  resolveSiteLink('/wp-admin/users.php?role=administrator', 'https://shop.example'), 'https://shop.example/wp-admin/users.php?role=administrator');
check('…and a trailing slash on the site URL does not double up',
  resolveSiteLink('/wp-admin/x.php', 'https://shop.example/'), 'https://shop.example/wp-admin/x.php');
check('an absolute step link is left exactly as the site sent it',
  resolveSiteLink('https://shop.example/wp-admin/x.php', 'https://shop.example'), 'https://shop.example/wp-admin/x.php');
// A protocol-relative value is not "already absolute" for our purposes: it must
// not be able to send the operator to a third-party origin from a link the site
// sent us.
check('a protocol-relative value cannot navigate off the customer site',
  resolveSiteLink('//evil.example/x', 'https://shop.example'), 'https://shop.example//evil.example/x');
check('with no connected site there is nothing to resolve against',
  resolveSiteLink('/wp-admin/x.php', ''), '/wp-admin/x.php');
check('a missing link stays missing', resolveSiteLink(null, 'https://shop.example'), null);
check('an empty link stays empty', resolveSiteLink('', 'https://shop.example'), '');

// …and the panel actually USES it. A correct resolver nothing calls is the
// "declared and never read" shape (verification card): the module tests above
// would stay green while the page kept the bug.
check('the panel imports the resolver', /import \{ resolveSiteLink \} from '@\/lib\/siteLink'/.test(ui), true);
check('the guided step link renders through it', /href=\{resolveSiteLink\(s\.link, siteUrl\)\}/.test(ui), true);
check('a core action link renders through it too', /href=\{resolveSiteLink\(l\.url, siteUrl\)\}/.test(ui), true);
check('the panel resolves against the connected site, not a constant', /const siteUrl = site\?\.url \|\| ''/.test(ui), true);
check('the site URL is threaded to the fix box that renders the step',
  /onJumpToUpdates=\{onJumpToUpdates\} siteName=\{siteName\} siteUrl=\{siteUrl\}/.test(ui), true);
check('…and to every Finding that renders a step link',
  (ui.match(/siteName=\{siteName\} siteUrl=\{siteUrl\}/g) || []).length >= 4, true);

// ── the stale-robots finding reaches the CLEAN MY SITE press ────────────────
//
// Morpheus_Health::robots_check() returns a finding with no `fix` of its own;
// Morpheus_Fixes::annotate() attaches the registry's by id. The clean scan
// appends that finding and then annotates, so the finding the press sees is
// `auto` — and the app's safe set takes it when it ASKS for something and drops
// it when it reads `good`. A `good` finding has nothing to quarantine, and a
// press that renamed a file in response to a passed check is the change this
// whole feature refuses to make.
check('the clean scan annotates the robots finding with its registry fix',
  /Morpheus_Health::robots_finding\(\)/.test(phpClean) && /Morpheus_Fixes::annotate\( \$findings \)/.test(phpClean), true);
const robotsFix = { kind: 'auto', label: 'Quarantine the stale robots.txt', does: 'x' };
const staleRobots = safeSet(cleanFindings({ findings: [{ id: 'morpheus_stale_robots_txt', status: 'recommended', fix: robotsFix }] }));
check('a stale robots.txt IS offered for the press', staleRobots.map((f) => f.id), ['morpheus_stale_robots_txt']);
const goodRobots = safeSet(cleanFindings({ findings: [{ id: 'morpheus_stale_robots_txt', status: 'good', fix: robotsFix }] }));
check('a robots.txt that reads good is NOT offered for the press', goodRobots, []);

console.log('\n9. the debug log: a finding only when the URL serves THAT file');

// THE FALSE POSITIVE THIS SECTION EXISTS FOR. The check used to decide "readable
// over the web" from an HTTP 200 plus a body that looked like a PHP log. On a
// live site whose host answers EVERY path under wp-content with 200 and its own
// HTML page (`try_files … /index.php`, a custom 404 returning 200, a WAF
// interstitial), that reported a credential-shaped leak for a filename that was
// not being served at all — and a WordPress error page rendered while debugging
// contains the words "PHP Warning", so even the body-shape test was fooled.
//
// The rule is the one the robots.txt check already used: fetch the site's own
// URL and compare the bytes it returns with the bytes on disk. A file that is
// not what the URL serves is debris, not a leak.
const cleanCode = stripPhp(phpClean);
const debugStateFn = phpClean.slice(
  phpClean.indexOf('public static function debug_log_state('),
  phpClean.indexOf('public static function served_is_the_file('),
);
const servedRuleFn = phpClean.slice(
  phpClean.indexOf('public static function served_is_the_file('),
  phpClean.indexOf('private static function public_debug_log('),
);
const debugCheckFn = phpClean.slice(
  phpClean.indexOf('private static function public_debug_log('),
  phpClean.indexOf('// ── 4. Core checksums'),
);
check('the debug-log state function was parsed (parser sanity)', debugStateFn.length > 400, true);
check('…the rule it decides with', servedRuleFn.length > 200, true);
check('…and the check that reports it', debugCheckFn.length > 400, true);

check('the rule is the served BYTES, not the status or a body shape', /morpheus_bodies_match\(/.test(stripPhp(servedRuleFn)), true);
check('…compared with the bytes read from disk', /file_get_contents\( \$file/.test(stripPhp(debugStateFn)), true);
check('…fetched from the file\'s own URL, cache defeated', /self::fetch\( add_query_arg\( 'morpheus-verify'/.test(stripPhp(debugStateFn)), true);
check('…and deciding NOTHING when the site does not answer', /null === \$served[\s\S]{0,160}?return null;/.test(stripPhp(debugStateFn)), true);
check('…and nothing when the file cannot be read', /! is_string\( \$on_disk \)[\s\S]{0,80}?return null;/.test(stripPhp(debugStateFn)), true);
// The two verdicts, each tied to the branch that reaches it — a literal inside a
// branch that cannot run is exactly the shape that passes while behaviour is gone.
check('a file that is not what the URL serves is `good`, not a finding', /empty\( \$state\['served'\] \)[\s\S]{0,400}?'good'/.test(stripPhp(debugCheckFn)), true);
check('…and the description says so in the operator\'s words', /not being served over the web/.test(phpClean), true);
check('a file the URL DOES serve is critical', /return self::finding\([\s\S]*?'critical'/.test(stripPhp(debugCheckFn)), true);
check('an empty log has nothing to leak', /empty\( \$state\['empty'\] \)/.test(stripPhp(debugCheckFn)), true);
check('an unanswered question is `unknown`, not a pass', /null === \$state[\s\S]{0,500}?'unknown'/.test(stripPhp(debugCheckFn)), true);
// The old heuristic must be GONE, not merely bypassed: left in place it is a
// second rule for the same fact, waiting to be called again.
check('the old body-shape heuristic is gone from the scanner', /looks_like_log/.test(cleanCode), false);

// The scan and the fix must ask the SAME question. The owner's experience was a
// scan that said critical and a fix that answered NOT_SERVED — two rules for one
// fact, disagreeing in front of him. The fix now calls the scan's own function.
const debugFixFn = phpFixes.slice(
  phpFixes.indexOf('private static function fix_quarantine_public_debug_log('),
  phpFixes.indexOf('private static function quarantine_file('),
);
check('the debug-log fix was parsed (parser sanity)', debugFixFn.length > 500, true);
check('the fix asks the scan\'s own function rather than a second rule', /Morpheus_Clean::debug_log_state\(\)/.test(stripPhp(debugFixFn)), true);
check('…refusing NOT_SERVED when the URL serves something else', /empty\( \$state\['served'\] \)[\s\S]{0,200}?'NOT_SERVED'/.test(stripPhp(debugFixFn)), true);
check('…refusing to guess when the site will not answer', /null === \$state[\s\S]{0,200}?'UNKNOWN'/.test(stripPhp(debugFixFn)), true);
check('…and no longer deciding readability from a body shape', /body_is_log/.test(stripPhp(phpFixes)), false);
// ONE definition of "the URL is serving this file", shared with robots.txt.
check('the comparison is the shared one, not a second implementation',
  /function morpheus_bodies_match\(/.test(read('wp-plugin/morpheus/includes/helpers.php')), true);
check('…and the SEO module delegates to it rather than keeping a copy',
  /return morpheus_bodies_match\( \$a, \$b \);/.test(stripPhp(read('wp-plugin/morpheus/includes/seo/class-seo.php'))), true);

console.log('\n10. the sentence appended to WordPress\'s debug test is the VERIFIED one');

// The other half of the same mistake: the finding appears under WordPress Site
// Health · Security with Morpheus's own sentence appended, and that sentence
// claimed "readable over the web" from nothing at all. The scan must attach the
// answer it actually measured, and the registry must not carry the claim.
const healthCode = stripPhp(read('wp-plugin/morpheus/includes/class-health.php'));
check('the health scan writes the verified sentence onto the debug test', /describe_public_debug_log\( \$tests \)/.test(healthCode), true);
check('…from the same served-bytes function the clean scan uses', /debug_log_state\(\)/.test(healthCode), true);
check('…after the tests ran and BEFORE annotation (so the sentence is the one attached)',
  healthCode.indexOf('describe_public_debug_log( $tests )') > 0
  && healthCode.indexOf('describe_public_debug_log( $tests )') < healthCode.indexOf('Morpheus_Fixes::annotate( $tests )'), true);
const debugEntry = registryBlock.slice(registryBlock.indexOf("'debug_enabled'"), registryBlock.indexOf("'woocommerce_secure_connection'"));
check('the registry entry was parsed (parser sanity)', debugEntry.length > 200, true);
check('the registry does not claim the log is readable over the web', /readable over the web/.test(debugEntry), false);
check('…and annotate() prefers the scan\'s verified sentence when it has one',
  /action_does/.test(stripPhp(phpFixes)) && /'' !== \$verified \? \$verified : \$entry\['does'\]/.test(stripPhp(phpFixes)), true);
// A per-finding sentence the panel never reads is the "declared and never read"
// shape: annotate() has to be the thing that turns it into `fix.does`.
check('…which is what the panel renders', /'does'\s*=>\s*'' !== \$verified/.test(stripPhp(phpFixes)), true);

console.log('\n11. a refused attempt leaves a record, and a record is never a claim');

// THE SECOND FAULT. The debug.log fix correctly declined to move a file nobody
// was being served — and nothing on screen said so. The panel rescanned, the
// same count came back, and a working refusal was indistinguishable from a
// broken button. The record is written by the plugin (the only thing that acts
// on the site), returned with the finding, and survives a reload.
check('the record is one option, capped',
  /ATTEMPTS_OPTION = 'morpheus_fix_attempts'/.test(stripPhp(phpFixes)) && /MAX_ATTEMPTS = \d+/.test(stripPhp(phpFixes)), true);
// EVERY mechanism, not just the debug log: the robots.txt quarantine and every
// future fix write the same record.
check('every mechanism records its attempt, refusals included', /self::record_attempt\( \$id, \$result \);/.test(stripPhp(phpFixes)), true);
// ONE call site, after the switch, on the result the mechanism produced — so a
// fix added later cannot quietly skip the record.
const applyCode = stripPhp(phpFixes);
const applySwitch = applyCode.slice(applyCode.indexOf("switch ( $entry['fix'] )"), applyCode.indexOf('self::record_attempt( $id, $result );'));
check('…from one place, on the mechanism\'s own result, before it is returned',
  (applyCode.match(/self::record_attempt\( \$id, \$result \);/g) || []).length === 1
  && /self::record_attempt\( \$id, \$result \);\s*\n\s*return \$result;/.test(applyCode), true);
check('…and no mechanism returns before it does', /case '[a-z_]+':\s*\n\s*return self::/.test(applySwitch), false);
check('the record is written by the fix, never by a scan', /update_option\( self::ATTEMPTS_OPTION/.test(stripPhp(phpFixes)), true);
check('…and the clean scan still writes nothing but its cache',
  /update_option\( *self::ATTEMPTS_OPTION/.test(cleanCode) || /update_option\( *Morpheus_Fixes::ATTEMPTS_OPTION/.test(cleanCode), false);
check('a later run REPLACES the earlier record for the same id (last attempt, not history)', /\$all\[ \$id \] = array\(/.test(stripPhp(phpFixes)), true);
check('the cap keeps the newest records', /array_slice\( \$all, 0, self::MAX_ATTEMPTS, true \)/.test(stripPhp(phpFixes)), true);
// Truthfulness, as code: only an explicit `done` is a success, and `done` has to
// be earned by ok + verified + not-restored + no error.
check('an unknown outcome reads as a refusal, never as done', /'done' === \( \$row\['outcome'\] \?\? '' \)/.test(stripPhp(phpFixes)), true);
check('`done` has to be earned: ok, verified, not restored, no error',
  /empty\( \$result\['ok'\] \)[\s\S]{0,300}?empty\( \$result\['restored'\] \)[\s\S]{0,300}?false !== \$result\['verified'\][\s\S]{0,200}?empty\( \$result\['error'\] \)/.test(stripPhp(phpFixes)), true);
for (const field of ["'outcome'", "'code'", "'message'", "'at'"]) {
  check(`the record carries ${field}`, new RegExp(`${field}\\s*=>`).test(stripPhp(phpFixes)), true);
}
check('both scans return it with the finding',
  /Morpheus_Fixes::attach_attempts\( \$findings \)/.test(cleanCode)
  && /Morpheus_Fixes::attach_attempts\( \$tests \)/.test(healthCode), true);
check('a finding with no record simply has none', /isset\( \$attempts\[ \$id \] \)/.test(stripPhp(phpFixes)), true);

console.log('\n12. the panel shows the record as a record');

// The app half, as BEHAVIOUR on the real functions.
const refused = { outcome: 'refused', code: 'NOT_SERVED', message: 'The debug log is not being served at https://shop.example/wp-content/debug.log — the host answers with something that is not this file.', at: '2026-09-23T12:00:00+00:00' };
check('a refusal is a refusal, in the site\'s own words, with its code and time',
  attemptLine(refused),
  'Last attempt refused (2026-09-23 12:00 UTC) [NOT_SERVED]: The debug log is not being served at https://shop.example/wp-content/debug.log — the host answers with something that is not this file.');
check('a done attempt is the only thing that reads as success', /^Last successful fix/.test(attemptLine({ outcome: 'done', message: 'renamed 1 file with a timestamp — nothing was deleted' })), true);
check('…and a refusal never reads as success', /success/i.test(attemptLine(refused)), false);
check('an UNKNOWN outcome is not a success', /^Last attempt refused/.test(attemptLine({ outcome: 'wat', message: 'something' })), true);
check('a missing outcome is not a success', /^Last attempt refused/.test(attemptLine({ message: 'something' })), true);
check('a record with no message falls back to its code, never to a success',
  attemptLine({ outcome: 'refused', code: 'NOT_SERVED' }),
  'Last attempt refused [NOT_SERVED]: the site answered NOT_SERVED');
check('a record with nothing in it is no line at all', [attemptLine(null), attemptLine({}), attemptLine('nonsense')], [null, null, null]);
check('an invalid timestamp does not invent one', attemptLine({ outcome: 'refused', message: 'x', at: 'not-a-date' }), 'Last attempt refused: x');
check('the record is sanitised, and an unknown outcome is kept as a refusal',
  attemptRecord({ outcome: 'done', message: '  x  ', at: '2026-09-23T12:00:00+00:00', code: 7 }),
  { outcome: 'done', code: null, message: 'x', at: '2026-09-23T12:00:00+00:00' });

// It must travel on the finding the panel renders, and must not change what the
// finding IS — a record is not a result.
const recorded = cleanFindings({
  findings: [{
    id: 'morpheus_public_debug_log',
    label: 'The debug log is not readable over the web',
    status: 'good',
    fix: { kind: 'auto', label: 'Quarantine the public debug log', does: 'x', steps: [] },
    last_attempt: refused,
  }],
})[0];
check('the clean mapper carries the record onto the finding', recorded.last_attempt?.outcome, 'refused');
check('…and the sentence the panel renders', /^Last attempt refused/.test(recorded.attempt_line), true);
check('…without touching the finding\'s own status', recorded.status, 'good');
check('…so a `good` finding with a record is still not in the safe set',
  safeSet([recorded]), []);
check('…and a record does not change the counts',
  cleanSummary({ findings: [{ id: 'morpheus_public_debug_log', status: 'good', fix: { kind: 'auto' }, last_attempt: refused }] }).good, 1);
check('a `done` record does not lift an unanswered finding into the safe set',
  safeSet(cleanFindings({ findings: [{ id: 'morpheus_public_debug_log', status: 'unknown', fix: { kind: 'auto' }, last_attempt: { outcome: 'done', message: 'x' } }] })), []);
// …and the panel must actually render it, on a finding that has no press. A
// server field nothing draws is the same silence this change exists to remove.
check('the panel renders the record on a finding row', /<LastAttempt line=\{t\.attempt_line\}/.test(ui), true);
check('…outside the withFix guard, so a passed check shows its refusal too',
  ui.indexOf('<LastAttempt line={t.attempt_line}') < ui.indexOf('{t.fix && withFix ? ('), true);

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nCLEAN MY SITE removes files from a live site. A wrong verdict here is worse than no button.\n');
  process.exit(1);
}
console.log('clean-site rules hold.\n');
