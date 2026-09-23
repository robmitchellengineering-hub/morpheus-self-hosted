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
check('…and refuses an action it does not know, by name', /action must be health or clean/.test(phpRest), true);
check('the app sends that action to the same route', /wpCall\(conn, 'health', \{ action: 'clean'/.test(jsClient), true);
check('…from the clean scan helper', /wpClean\(conn, \{ force \}\)/.test(jsScan), true);
check('…and the handler has a branch for it', /action === 'clean'/.test(jsHandler), true);
check('…declared in the one action set', /'clean'\]/.test(jsHandler), true);

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
check('the plugin version moved for the new action', /MORPHEUS_VERSION', '0\.8\.4'/.test(phpBootstrap), true);
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

console.log(`\n${pass}/${pass + fail} checks passed`);
if (fail) {
  console.log('\nCLEAN MY SITE removes files from a live site. A wrong verdict here is worse than no button.\n');
  process.exit(1);
}
console.log('clean-site rules hold.\n');
