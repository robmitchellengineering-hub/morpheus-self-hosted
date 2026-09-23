<?php
/**
 * CLEAN MY SITE, against a real WordPress with real fixtures on disk.
 *
 * WHY THIS HARNESS EXISTS
 *
 * The clean scan is the only part of this plugin that moves files around on
 * someone's live site, and its whole promise is negative: nothing is deleted, a
 * changed core file is never touched, and a scan that could not check something
 * says so instead of reporting clean. None of that can be asserted by reading
 * source, so this boots WordPress, plants the four things a compromise leaves
 * behind, and drives the real code:
 *
 *   1. the SCAN finds each fixture — a PHP file in uploads/, a wp-config.php.bak
 *      and a .env in the site root, a mu-plugin, an unattributable cron hook, a
 *      core file that does not match its published checksum — and reports each
 *      with the file's name in its evidence;
 *   2. a GOOD site produces no attention-worthy finding, so the check is not a
 *      permanent alarm (asserted against the same boot with the fixtures gone);
 *   3. the QUARANTINE fixes RENAME rather than delete: the original path is
 *      empty, the backup is byte-identical, the result names the backup, and
 *      renaming it back restores the file exactly;
 *   4. the GUIDED findings are refused by apply() and the file they name is left
 *      untouched — the one thing this feature must never do is re-download core
 *      or delete an account on an automated pass;
 *   5. the SCAN IS BOUNDED and says what it skipped, with numbers;
 *   6. the signed /health route DISPATCHES on the action, so `clean` reaches
 *      Morpheus_Clean and a health scan does not.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 * It never reaches wordpress.org. The core checksum list is served as a fixture
 * through WordPress's own `pre_http_request` seam, so the assertion is about OUR
 * comparison and not about the weather at api.wordpress.org (and a test that
 * reaches a live third party is not a test).
 *
 * Run it in a real WordPress (WASM PHP, no Docker):
 *
 *   npx --yes @wp-playground/cli@latest php --php 8.2 --wp latest --verbosity quiet \
 *     --auto-mount ./wp-plugin/morpheus \
 *     --mount ./wp-plugin/morpheus/tests:/tests \
 *     -- /tests/harness-clean.php
 */

$wp_load = '/wordpress/wp-load.php';
if ( ! file_exists( $wp_load ) ) {
	fwrite( STDERR, "wp-load.php not found at $wp_load\n" );
	exit( 2 );
}
require $wp_load;

if ( ! class_exists( 'Morpheus_Clean' ) ) {
	$morpheus_main = WP_PLUGIN_DIR . '/morpheus/morpheus.php';
	if ( file_exists( $morpheus_main ) ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once $morpheus_main;
	}
}
if ( ! class_exists( 'Morpheus_Clean' ) ) {
	$dir = ( defined( 'MORPHEUS_DIR' ) ? MORPHEUS_DIR : WP_PLUGIN_DIR . '/morpheus/' ) . 'includes/';
	foreach ( array( 'class-health.php', 'class-clean.php', 'class-maintenance.php', 'class-fixes.php' ) as $f ) {
		if ( file_exists( $dir . $f ) ) {
			require_once $dir . $f;
		}
	}
}

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/update.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';

$pass    = 0;
$fail    = 0;
$skipped = 0;

function ok( $cond, $label ) {
	global $pass, $fail;
	if ( $cond ) { $pass++; echo "  PASS  $label\n"; }
	else         { $fail++; echo "  FAIL  $label\n"; }
}

/** A condition this boot cannot create is SKIPPED, never passed silently. */
function skip( $label, $why ) {
	global $skipped;
	$skipped++;
	echo "  SKIP  $label — $why\n";
}

function section( $label ) {
	echo "\n== $label ==\n";
	flush();
}

function morpheus_clean_rmtree( $dir ) {
	if ( ! is_dir( $dir ) ) {
		return;
	}
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ( $it as $info ) {
		$info->isDir() ? @rmdir( $info->getPathname() ) : @unlink( $info->getPathname() );
	}
	@rmdir( $dir );
}

/** Find one finding by id in a scan payload. */
function clean_finding( $scan, $id ) {
	foreach ( (array) ( $scan['findings'] ?? array() ) as $f ) {
		if ( ( $f['id'] ?? '' ) === $id ) {
			return $f;
		}
	}
	return null;
}

/** True when any evidence row for a finding names this path. */
function clean_names( $finding, $needle ) {
	foreach ( (array) ( $finding['details'] ?? array() ) as $row ) {
		if ( false !== strpos( (string) ( $row['file'] ?? '' ), $needle ) ) {
			return true;
		}
	}
	return false;
}

echo "\nCLEAN MY SITE harness — real WordPress, real files on disk\n";

// ── the fixture site ────────────────────────────────────────────────────────
//
// Every fixture is created HERE and removed at the end, so this boot leaves the
// WordPress it ran in exactly as it found it.

$uploads    = wp_upload_dir();
$uploads_ok = ! empty( $uploads['basedir'] ) && wp_mkdir_p( $uploads['basedir'] . '/2026/09' );
$injected   = $uploads['basedir'] . '/2026/09/morpheus-fixture-injected.php';
$plain      = $uploads['basedir'] . '/2026/09/morpheus-fixture-image.jpg';
$bak        = ABSPATH . 'wp-config.php.bak';
$envfile    = ABSPATH . '.env';
$debuglog   = WP_CONTENT_DIR . '/debug.log';
$mudir      = ( defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins' );
$mufile     = $mudir . '/morpheus-fixture-mu.php';
// Deliberately NOT starting with "morpheus": a hook is attributed to a plugin
// whose slug it contains, and a fixture named after ours would be attributed to
// us and never exercise the unattributed path.
$cron_hook  = 'zz_harness_leftover_task';

$injected_body = "<?php // morpheus fixture: an injected file, not a real one\n";
$bak_body      = "<?php\ndefine( 'DB_PASSWORD', 'fixture-not-a-real-secret' );\n";
$env_body      = "FIXTURE_ONLY=not-a-real-secret\n";
$log_body      = "[23-Sep-2026 12:00:00 UTC] PHP Warning:  fixture line for the clean harness\n";

if ( $uploads_ok ) {
	file_put_contents( $injected, $injected_body );
	file_put_contents( $plain, "not php\n" );
}
file_put_contents( $bak, $bak_body );
file_put_contents( $envfile, $env_body );
file_put_contents( $debuglog, $log_body );
if ( wp_mkdir_p( $mudir ) ) {
	file_put_contents( $mufile, "<?php // morpheus fixture mu-plugin\n" );
}
// A recently-modified file to be found by the recent-files check: everything
// else under core is backdated so the assertion is about the rule, not about the
// clock. Only this one file is touched.
$recent_fixture = WP_PLUGIN_DIR . '/harness-fixture-recent/plugin.php';
wp_mkdir_p( dirname( $recent_fixture ) );
file_put_contents( $recent_fixture, "<?php // morpheus fixture: a recently changed plugin file\n" );

// An unattributable cron hook: scheduled, with nothing registered on it.
wp_schedule_single_event( time() + 3600, $cron_hook, array( 'x' ) );

// ── the core checksum list, as a fixture ────────────────────────────────────
//
// Served through WordPress's own pre_http_request seam so this harness never
// reaches wordpress.org. Two real core files are named: one with its TRUE md5
// (so a match is proved, not assumed) and one with a deliberately WRONG md5 (so
// the modified-file path is exercised on a real file on disk).
$core_modified = 'wp-includes/version.php';
$core_intact   = 'wp-includes/functions.php';
$core_extra    = 'wp-includes/morpheus-fixture-core.php'; // listed, missing on disk

$GLOBALS['morpheus_checksum_fixture'] = array(
	'checksums' => array(
		$core_intact   => md5_file( ABSPATH . $core_intact ),
		$core_modified => str_repeat( '0', 32 ), // never matches: "modified"
		$core_extra    => str_repeat( '1', 32 ), // never present: "missing"
	),
);
$serve_checksums = function ( $pre, $args, $url ) {
	if ( false === strpos( (string) $url, 'core/checksums' ) ) {
		return $pre;
	}
	return array(
		'headers'  => array(),
		'body'     => wp_json_encode( $GLOBALS['morpheus_checksum_fixture'] ),
		'response' => array( 'code' => 200, 'message' => 'OK' ),
		'cookies'  => array(),
		'filename' => null,
	);
};
add_filter( 'pre_http_request', $serve_checksums, 10, 3 );

// ── 1. the scan ─────────────────────────────────────────────────────────────

section( '1. the scan finds each fixture, with the file named in the evidence' );

$start = microtime( true );
$scan  = Morpheus_Clean::scan( true );
$wall  = microtime( true ) - $start;

ok( is_array( $scan ) && ! empty( $scan['findings'] ), 'the clean scan returned findings' );
ok( empty( $scan['unmapped'] ), 'no finding is left without a registered action' . ( empty( $scan['unmapped'] ) ? '' : ' — ' . wp_json_encode( $scan['unmapped'] ) ) );

$up = clean_finding( $scan, 'morpheus_uploads_php' );
ok( null !== $up, 'uploads: the finding is produced' );
ok( 'critical' === ( $up['status'] ?? '' ), 'uploads: a PHP file in the media library is critical' );
ok( $uploads_ok ? clean_names( $up, 'morpheus-fixture-injected.php' ) : false, 'uploads: the injected file is named in the evidence' );
ok( $up && ! clean_names( $up, 'morpheus-fixture-image.jpg' ), 'uploads: the non-PHP file next to it is NOT flagged' );
ok( 'auto' === ( $up['fix']['kind'] ?? '' ), 'uploads: the fix is automatic (a rename with an undo)' );

$cfg = clean_finding( $scan, 'morpheus_root_config_backup' );
ok( null !== $cfg, 'site root: the finding is produced' );
ok( 'critical' === ( $cfg['status'] ?? '' ), 'site root: a credential backup is critical' );
ok( clean_names( $cfg, 'wp-config.php.bak' ), 'site root: wp-config.php.bak is named' );
ok( clean_names( $cfg, '.env' ), 'site root: .env is named' );
ok( 'auto' === ( $cfg['fix']['kind'] ?? '' ), 'site root: the fix is automatic' );

$dbg = clean_finding( $scan, 'morpheus_public_debug_log' );
ok( null !== $dbg, 'debug log: the finding is produced' );
if ( 'critical' === ( $dbg['status'] ?? '' ) ) {
	ok( true, 'debug log: a publicly readable log is critical' );
	ok( clean_names( $dbg, 'debug.log' ), 'debug log: the file is named' );
} else {
	// The built-in PHP server Playground uses may refuse to hand out a .log. That
	// is a property of THIS harness, not of the check, so it is reported as a
	// skip with the status the scan actually returned.
	skip( 'debug log: a publicly readable log is critical', 'this boot serves wp-content/debug.log with status "' . ( $dbg['status'] ?? 'unknown' ) . '", so public readability could not be exercised here' );
}

$mu = clean_finding( $scan, 'morpheus_mu_plugins' );
ok( null !== $mu, 'mu-plugins: the finding is produced' );
ok( clean_names( $mu, 'morpheus-fixture-mu.php' ), 'mu-plugins: every file is inventoried, including the fixture' );
ok( 'guided' === ( $mu['fix']['kind'] ?? '' ), 'mu-plugins: reported, never applied' );

$core = clean_finding( $scan, 'morpheus_core_checksums' );
ok( null !== $core, 'core: the finding is produced' );
ok( 'critical' === ( $core['status'] ?? '' ), 'core: a file that does not match its checksum is critical' );
ok( clean_names( $core, $core_modified ), 'core: the modified file is named' );
ok( ! clean_names( $core, $core_intact ), 'core: the file whose checksum MATCHES is not named' );
ok( clean_names( $core, $core_extra ), 'core: a listed file missing from disk is reported separately' );
ok( 'guided' === ( $core['fix']['kind'] ?? '' ), 'core: reported, never applied (re-downloading core is not automated)' );

$cron = clean_finding( $scan, 'morpheus_cron_unattributed' );
ok( null !== $cron, 'cron: the finding is produced' );
ok( clean_names( $cron, $cron_hook ), 'cron: the hook with no callback is named' );
ok( 'guided' === ( $cron['fix']['kind'] ?? '' ), 'cron: reported, never unscheduled automatically' );

$admins = clean_finding( $scan, 'morpheus_admin_users' );
ok( null !== $admins, 'admins: the finding is produced' );
ok( ( $admins['details'] ?? array() ) !== array(), 'admins: the admin-capable accounts are listed' );
ok( 'guided' === ( $admins['fix']['kind'] ?? '' ), 'admins: reported, never removed automatically' );

$recent = clean_finding( $scan, 'morpheus_recent_files' );
ok( null !== $recent, 'recent files: the finding is produced' );
ok( clean_names( $recent, 'harness-fixture-recent' ), 'recent files: the file changed just now is named' );
ok( 'guided' === ( $recent['fix']['kind'] ?? '' ), 'recent files: a changed file is listed, not touched' );

$robots = clean_finding( $scan, 'morpheus_stale_robots_txt' );
ok( null !== $robots, 'robots: CLEAN MY SITE includes the existing robots.txt finding rather than competing with it' );

// ── 2. bounded, and honest about it ─────────────────────────────────────────

section( '2. the scan is bounded, and says what it did not reach' );

ok( isset( $scan['limits'] ) && is_array( $scan['limits'] ), 'the payload carries the limits it ran under' );
ok( (int) ( $scan['limits']['hash_files'] ?? 0 ) > 0, 'the core pass reports how many files it hashed (' . (int) ( $scan['limits']['hash_files'] ?? 0 ) . ')' );
ok( (int) ( $scan['limits']['hash_files_cap'] ?? 0 ) > 0, '…and the cap it ran under (' . (int) ( $scan['limits']['hash_files_cap'] ?? 0 ) . ')' );
ok( (int) ( $scan['duration_ms'] ?? 0 ) > 0, 'the payload reports what the pass cost in milliseconds (' . (int) ( $scan['duration_ms'] ?? 0 ) . ')' );
ok( (float) ( $scan['limits']['seconds'] ?? 0 ) > 0, '…and in seconds (' . (float) ( $scan['limits']['seconds'] ?? 0 ) . ')' );
printf( "        measured: %d ms wall, hash_files=%d/%d, uploads_scanned=%d, duration_ms=%d\n",
	(int) round( $wall * 1000 ),
	(int) ( $scan['limits']['hash_files'] ?? 0 ),
	(int) ( $scan['limits']['hash_files_cap'] ?? 0 ),
	(int) ( $scan['limits']['uploads_scanned'] ?? 0 ),
	(int) ( $scan['duration_ms'] ?? 0 )
);
ok( is_array( $scan['skipped'] ?? null ), 'the payload carries what was skipped' );
$skip_names = array_column( (array) $scan['skipped'], 'check' );
ok( in_array( 'plugin_checksums', $skip_names, true ), 'a check that could not run is listed as skipped, not omitted (Morpheus itself is not on wordpress.org)' );
$morpheus_skip = null;
foreach ( (array) $scan['skipped'] as $s ) {
	if ( 'plugin_checksums' === ( $s['check'] ?? '' ) && false !== strpos( (string) ( $s['reason'] ?? '' ), 'Morpheus itself' ) ) {
		$morpheus_skip = $s;
	}
}
ok( null !== $morpheus_skip && ! empty( $morpheus_skip['reason'] ), '…and the skip says WHY, in words' );

// ── 3. a second scan is the cached one ──────────────────────────────────────

section( '3. the scan caches, so a panel re-open does not re-hash the site' );

$cached = Morpheus_Clean::scan( false );
ok( ( $cached['cached'] ?? null ) === true, 'a repeat scan is served from the cache' );
ok( ( $scan['cached'] ?? null ) === false, 'a forced scan says it was not cached' );

// ── 4. quarantine, never delete ─────────────────────────────────────────────
//
// TWO BRANCHES OF ONE THIRD-PARTY CONDITIONAL, because the honest answer differs
// and only one of them is the happy path:
//
//   * a file whose DANGER IS EXECUTION (a .php under uploads/) is disarmed by the
//     rename itself — the backup's name is not executable — so no HTTP check
//     applies;
//   * a file whose DANGER IS BEING READ (a .bak, a .env, a public log) is only
//     quarantined if the new location is provably not served. On a server whose
//     deny rules Morpheus cannot rely on, the honest answer is to REFUSE and put
//     the file back rather than leave the same bytes readable under a longer
//     name. This harness runs both: first without a deny rule (expect a refusal),
//     then with one (expect the quarantine).

section( '4. the quarantine fixes RENAME — and a rollback restores' );

function clean_qrow( $result, $needle ) {
	foreach ( (array) ( $result['quarantined'] ?? array() ) as $row ) {
		if ( false !== strpos( (string) ( $row['file'] ?? '' ), $needle ) ) {
			return $row;
		}
	}
	return null;
}

// ── 4a. uploads/ PHP: execution is the danger, so the rename is the fix ─────
$before_bytes = is_file( $injected ) ? file_get_contents( $injected ) : '';
$r1 = Morpheus_Fixes::apply( 'morpheus_uploads_php' );
ok( ! empty( $r1['ok'] ), 'uploads: the quarantine ran (code ' . ( $r1['code'] ?? '—' ) . ')' );
$row1 = clean_qrow( $r1, 'morpheus-fixture-injected.php' );
ok( null !== $row1, 'uploads: the result names the file it moved' );
ok( null !== $row1 && ! empty( $row1['backup'] ), 'uploads: …and the backup it became, which is the operator\'s undo' );
ok( null !== $row1 && preg_match( '/\.morpheus-bak-\d{14}$/', (string) $row1['backup'] ) === 1, 'uploads: the backup carries a UTC timestamp' );
ok( ! is_file( $injected ), 'uploads: the original path is empty — it cannot be requested or run' );
ok( null !== $row1 && is_file( (string) $row1['backup'] ), 'uploads: the backup exists — nothing was deleted' );
ok( null !== $row1 && file_get_contents( (string) $row1['backup'] ) === $before_bytes, 'uploads: …and is byte-identical to what was there' );
ok( is_file( $plain ), 'uploads: the non-PHP file beside it was not touched' );

if ( null !== $row1 ) {
	$restored = @rename( (string) $row1['backup'], $injected );
	ok( $restored && is_file( $injected ) && file_get_contents( $injected ) === $before_bytes, 'uploads: a rollback restores the file exactly' );
	@rename( $injected, (string) $row1['backup'] );
}

// ── 4b. a served file, on a server Morpheus cannot prove is safe → REFUSE ───
$bak_bytes = file_get_contents( $bak );
$env_bytes = file_get_contents( $envfile );
$r2_refused = Morpheus_Fixes::apply( 'morpheus_root_config_backup' );
ok( empty( $r2_refused['ok'] ), 'site root: without a deny rule the quarantine is REFUSED rather than leaving a readable copy (code ' . ( $r2_refused['code'] ?? '—' ) . ')' );
ok( false !== strpos( (string) ( $r2_refused['error'] ?? '' ), 'just as readable' ) || false !== strpos( (string) ( $r2_refused['error'] ?? '' ), 'could not confirm' ), 'site root: …and says why, in the operator\'s words' );
ok( is_file( $bak ) && file_get_contents( $bak ) === $bak_bytes, 'site root: the wp-config backup is back in the site root, byte-identical — nothing was left changed' );
ok( is_file( $envfile ) && file_get_contents( $envfile ) === $env_bytes, 'site root: …and so is .env' );

// ── 4c. the same file, where the quarantine directory is denied over HTTP ────
// This is the Apache case: `wp-content/morpheus-state/quarantine/.htaccess` (which
// the plugin writes) makes the URL answer 403 rather than hand out the file. It is
// simulated here through WordPress's own pre_http_request seam, because the
// Playground server serves every path and has no deny rules at all — which is
// exactly why 4b above is the honest answer there.
$deny_quarantine = function ( $pre, $args, $url ) {
	if ( false === strpos( (string) $url, 'morpheus-state/quarantine' ) ) {
		return $pre;
	}
	return array(
		'headers'  => array(),
		'body'     => '',
		'response' => array( 'code' => 403, 'message' => 'Forbidden' ),
		'cookies'  => array(),
		'filename' => null,
	);
};
add_filter( 'pre_http_request', $deny_quarantine, 10, 3 );

$r2 = Morpheus_Fixes::apply( 'morpheus_root_config_backup' );
ok( ! empty( $r2['ok'] ), 'site root: with the backup directory denied, the quarantine runs (code ' . ( $r2['code'] ?? '—' ) . ')' );
$row_bak = clean_qrow( $r2, 'wp-config.php.bak' );
$row_env = clean_qrow( $r2, '.env' );
ok( null !== $row_bak, 'site root: wp-config.php.bak is reported as moved' );
ok( null !== $row_env, 'site root: .env is reported as moved' );
ok( ! is_file( $bak ) && ! is_file( $envfile ), 'site root: neither file is at its served path any more' );
ok( null !== $row_bak && is_file( (string) $row_bak['backup'] ), 'site root: the wp-config backup exists at the new name' );
ok( null !== $row_bak && file_get_contents( (string) $row_bak['backup'] ) === $bak_bytes, 'site root: …byte-identical to the original' );
ok( null !== $row_env && is_file( (string) $row_env['backup'] ) && file_get_contents( (string) $row_env['backup'] ) === $env_bytes, 'site root: .env is byte-identical at the new name' );

if ( null !== $row_bak && null !== $row_env ) {
	$back_bak = @rename( (string) $row_bak['backup'], $bak );
	$back_env = @rename( (string) $row_env['backup'], $envfile );
	ok( $back_bak && $back_env, 'site root: a rollback restores both files' );
	ok( file_get_contents( $bak ) === $bak_bytes && file_get_contents( $envfile ) === $env_bytes, '…with their exact contents' );
	@rename( $bak, (string) $row_bak['backup'] );
	@rename( $envfile, (string) $row_env['backup'] );
}

// ── 4d. the public debug log, both branches ─────────────────────────────────
if ( is_file( $debuglog ) ) {
	$log_bytes = file_get_contents( $debuglog );
	$r3 = Morpheus_Fixes::apply( 'morpheus_public_debug_log' );
	ok( ! empty( $r3['ok'] ), 'debug log: with the backup directory denied, the log is quarantined' );
	$row_log = clean_qrow( $r3, 'debug.log' );
	ok( null !== $row_log, 'debug log: the backup is named in the result' );
	ok( ! is_file( $debuglog ), 'debug log: the log is no longer at the served path' );
	ok( null !== $row_log && is_file( (string) $row_log['backup'] ) && file_get_contents( (string) $row_log['backup'] ) === $log_bytes, 'debug log: …and the backup is byte-identical — nothing deleted' );
	if ( null !== $row_log ) {
		@rename( (string) $row_log['backup'], $debuglog );
		ok( is_file( $debuglog ), 'debug log: a rollback restores it' );
		// Away again, and this time ask the honest question without the deny rule:
		// the log must be refused rather than moved to a path the server serves.
		remove_filter( 'pre_http_request', $deny_quarantine, 10 );
		$r3b = Morpheus_Fixes::apply( 'morpheus_public_debug_log' );
		ok( empty( $r3b['ok'] ), 'debug log: without a deny rule it is REFUSED, not moved somewhere still readable (code ' . ( $r3b['code'] ?? '—' ) . ')' );
		ok( is_file( $debuglog ) && file_get_contents( $debuglog ) === $log_bytes, 'debug log: …and the log is exactly where it was' );
		add_filter( 'pre_http_request', $deny_quarantine, 10, 3 );
		@rename( $debuglog, (string) $row_log['backup'] );
	}
	remove_filter( 'pre_http_request', $deny_quarantine, 10 );
} else {
	skip( 'debug log: quarantine', 'no wp-content/debug.log to quarantine in this boot' );
}

// ── 4e. the debug log is judged by the BYTES served, not by the status ──────
//
// THE FALSE POSITIVE THIS SECTION EXISTS FOR. A host whose front controller
// answers EVERY path under wp-content with 200 and its own HTML page — a
// `try_files … /index.php` rule, a custom 404 that returns 200, a WAF
// interstitial — serves a body for a file that is not there. The old check read
// that body (it contained the words "PHP Warning", from a WP error page) as a
// leak. The rule now is the one the robots.txt check uses: the URL's bytes
// against the file's bytes.
//
// The host is simulated through WordPress's own `pre_http_request` seam, so the
// assertion is about OUR comparison and not about Playground's static router.
// The stub is STATEFUL on purpose: it serves the log while the file is on disk
// and 404s once it has been moved, which is what a real web server does — a
// stub that kept saying 200 would make the fix's own after-the-fact check
// refuse, and the harness would be testing the stub.

section( '4e. the debug log: the URL\'s bytes decide, not the status' );

// 4d moved the fixture away; put it back for this section.
file_put_contents( $debuglog, $log_body );

$fallback_body = '<!doctype html><html><body><h1>Page not found</h1><p>PHP Warning: this page is a stack trace, not the log</p></body></html>';

/** A host that answers every wp-content path with its own HTML page. */
$serve_fallback = function ( $pre, $args, $url ) use ( $fallback_body ) {
	// The quarantined backup's URL also contains "debug.log"; that probe is the
	// deny rule's business (see 4c), not this stub's.
	if ( false === strpos( (string) $url, 'debug.log' ) || false !== strpos( (string) $url, 'morpheus-bak' ) ) {
		return $pre;
	}
	return array( 'headers' => array(), 'body' => $fallback_body, 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
};
/** A host that serves the file while it exists, and 404s after it is moved. */
$serve_log = function ( $pre, $args, $url ) use ( $debuglog, $log_body ) {
	if ( false === strpos( (string) $url, 'debug.log' ) || false !== strpos( (string) $url, 'morpheus-bak' ) ) {
		return $pre;
	}
	$there = is_file( $debuglog );
	return array(
		'headers'  => array(),
		'body'     => $there ? $log_body : 'Not Found',
		'response' => array( 'code' => $there ? 200 : 404, 'message' => $there ? 'OK' : 'Not Found' ),
		'cookies'  => array(),
		'filename' => null,
	);
};

// The rule itself, directly — a pure function, so a failure here is the rule and
// not the boot.
ok( Morpheus_Clean::served_is_the_file( $log_body, $log_body ) === true, 'the rule: a URL returning the file IS serving it' );
ok( Morpheus_Clean::served_is_the_file( $log_body, $log_body . "\n" ) === true, 'the rule: a trailing newline from a proxy is still the file' );
ok( Morpheus_Clean::served_is_the_file( $log_body, $fallback_body ) === false, 'the rule: an HTML error page is NOT the file, whatever status it arrived with' );
ok( Morpheus_Clean::served_is_the_file( $log_body, '' ) === false, 'the rule: an empty response is NOT the file' );
ok( Morpheus_Clean::served_is_the_file( '', $fallback_body ) === false, 'the rule: an empty file has nothing to leak' );

// Clear only THIS finding's record — 4d already attempted it several times. The
// other findings' records are kept on purpose: they are what proves the record
// is not a debug-log special case.
$left = Morpheus_Fixes::attempts();
unset( $left['morpheus_public_debug_log'] );
update_option( Morpheus_Fixes::ATTEMPTS_OPTION, $left, false );

// (a) the owner's host: 200, a 12 KB HTML page, and no file being served.
add_filter( 'pre_http_request', $serve_fallback, 10, 3 );
Morpheus_Clean::forget();
$scan_fallback = Morpheus_Clean::scan( true );
$dbg_fallback  = clean_finding( $scan_fallback, 'morpheus_public_debug_log' );
ok( null !== $dbg_fallback, 'fallback host: the check still runs (a check that vanishes reads as a pass)' );
ok( 'good' === ( $dbg_fallback['status'] ?? '' ), 'fallback host: NO finding — the file exists and is not what the URL serves (got "' . ( $dbg_fallback['status'] ?? '—' ) . '")' );
ok( false !== strpos( (string) ( $dbg_fallback['description'] ?? '' ), 'not being served over the web' ), 'fallback host: …and the description says so in the operator\'s words' );
ok( ! isset( $dbg_fallback['last_attempt'] ), 'fallback host: with nothing ever attempted there is no record to show' );

// (b) the same file, and a URL that really is handing it out.
remove_filter( 'pre_http_request', $serve_fallback, 10 );
add_filter( 'pre_http_request', $serve_log, 10, 3 );
Morpheus_Clean::forget();
$scan_served = Morpheus_Clean::scan( true );
$dbg_served  = clean_finding( $scan_served, 'morpheus_public_debug_log' );
ok( 'critical' === ( $dbg_served['status'] ?? '' ), 'served: a URL returning the log\'s own bytes IS a finding (got "' . ( $dbg_served['status'] ?? '—' ) . '")' );
ok( clean_names( $dbg_served, 'debug.log' ), 'served: …naming the file' );

// ── 4f. a refused attempt is recorded, survives the scan, and is replaced ───

section( '4f. a refused fix records its attempt, and a later success replaces it' );

// The refusal first: the host is answering with something that is not the log,
// so the fix must decline rather than move a file nobody is being served.
remove_filter( 'pre_http_request', $serve_log, 10 );
add_filter( 'pre_http_request', $serve_fallback, 10, 3 );
$log_bytes_before = file_get_contents( $debuglog );
$r4 = Morpheus_Fixes::apply( 'morpheus_public_debug_log' );
ok( empty( $r4['ok'] ), 'refusal: the fix declines (code ' . ( $r4['code'] ?? '—' ) . ')' );
ok( 'NOT_SERVED' === ( $r4['code'] ?? '' ), 'refusal: …with the NOT_SERVED code the panel understands' );
ok( is_file( $debuglog ) && file_get_contents( $debuglog ) === $log_bytes_before, 'refusal: …and the log is exactly where it was' );

$attempts = Morpheus_Fixes::attempts();
$rec      = $attempts['morpheus_public_debug_log'] ?? null;
ok( is_array( $rec ), 'record: the refusal left a record' );
ok( 'refused' === ( $rec['outcome'] ?? '' ), 'record: …as a refusal, never as a done' );
ok( 'NOT_SERVED' === ( $rec['code'] ?? '' ), 'record: …carrying the code' );
ok( false !== strpos( (string) ( $rec['message'] ?? '' ), 'not being served' ), 'record: …and the site\'s own reason, in words' );
ok( ! empty( $rec['at'] ), 'record: …and when it happened' );
// NOT special-cased to the debug log: the earlier quarantine attempts are in the
// same record, which is the whole point of putting it in apply().
ok( isset( $attempts['morpheus_uploads_php'] ), 'record: another fix\'s attempt is recorded too (this is not a debug-log special case)' );
ok( isset( $attempts['morpheus_root_config_backup'] ), 'record: …and so is the config-backup one' );

// The SCAN returns it with the finding — which is what makes it survive a reload
// and what the panel renders on the row.
Morpheus_Clean::forget();
$scan_refused = Morpheus_Clean::scan( true );
$dbg_refused  = clean_finding( $scan_refused, 'morpheus_public_debug_log' );
ok( 'good' === ( $dbg_refused['status'] ?? '' ), 'record: the finding\'s own status is unchanged by a record (a record is not a claim)' );
ok( 'refused' === ( $dbg_refused['last_attempt']['outcome'] ?? '' ), 'record: the scan carries the refusal on the finding' );
ok( 'NOT_SERVED' === ( $dbg_refused['last_attempt']['code'] ?? '' ), 'record: …with its code' );
ok( false !== strpos( (string) ( $dbg_refused['last_attempt']['message'] ?? '' ), 'not being served' ), 'record: …and its reason' );

// And a later SUCCESS replaces it: a fix that starts working must stop being
// shown as refused.
remove_filter( 'pre_http_request', $serve_fallback, 10 );
add_filter( 'pre_http_request', $serve_log, 10, 3 );
add_filter( 'pre_http_request', $deny_quarantine, 10, 3 );
$r5 = Morpheus_Fixes::apply( 'morpheus_public_debug_log' );
$row5 = clean_qrow( $r5, 'debug.log' );
ok( ! empty( $r5['ok'] ) && null !== $row5, 'success: with the URL serving it, the log is quarantined' );
ok( ! is_file( $debuglog ), 'success: …and is no longer at the served path' );
$rec2 = Morpheus_Fixes::attempts()['morpheus_public_debug_log'] ?? null;
ok( 'done' === ( $rec2['outcome'] ?? '' ), 'record: the success REPLACED the refusal' );
ok( 'NOT_SERVED' !== ( $rec2['code'] ?? '' ), 'record: …and the old refusal code is gone, not merged' );
Morpheus_Clean::forget();
$scan_done = Morpheus_Clean::scan( true );
$dbg_done  = clean_finding( $scan_done, 'morpheus_public_debug_log' );
ok( 'done' === ( $dbg_done['last_attempt']['outcome'] ?? '' ), 'record: the fresh scan carries the success' );
ok( 'good' === ( $dbg_done['status'] ?? '' ), 'record: …and the finding is still judged by the check, not by the record' );

// (c) WordPress's own debug test is annotated with the VERIFIED answer, not a
// fixed sentence. `action_does` is the seam; annotate() is what turns it into
// the `fix.does` the panel renders.
$by_hand = array( array( 'id' => 'debug_enabled', 'label' => 'Debug mode', 'status' => 'recommended', 'action_does' => 'SENTENCE THE SCAN MEASURED' ) );
Morpheus_Fixes::annotate( $by_hand );
ok( 'SENTENCE THE SCAN MEASURED' === ( $by_hand[0]['fix']['does'] ?? '' ), 'annotation: annotate() uses the scan\'s verified sentence' );
ok( ! array_key_exists( 'action_does', $by_hand[0] ), 'annotation: …and the raw seam does not leak into the payload' );
$fallback_annotated = array( array( 'id' => 'debug_enabled', 'label' => 'Debug mode', 'status' => 'recommended' ) );
Morpheus_Fixes::annotate( $fallback_annotated );
ok( false === strpos( (string) ( $fallback_annotated[0]['fix']['does'] ?? '' ), 'readable over the web' ), 'annotation: the registry fallback makes no readability claim' );

// The live scan: present only when WordPress registers its debug test, which is
// the same conditional the panel meets.
remove_filter( 'pre_http_request', $serve_log, 10 );
add_filter( 'pre_http_request', $serve_fallback, 10, 3 );
file_put_contents( $debuglog, $log_body ); // re-create, so the fallback host has a file to not serve
$health_fallback = Morpheus_Health::scan( true );
$debug_test      = null;
foreach ( (array) ( $health_fallback['tests'] ?? array() ) as $t ) {
	if ( 'debug_enabled' === ( $t['id'] ?? '' ) ) {
		$debug_test = $t;
	}
}
if ( null === $debug_test ) {
	skip( 'annotation: WordPress\'s debug_enabled test was annotated from the verified answer', 'this boot does not register core\'s debug_enabled test, so there is no WordPress finding to annotate' );
} else {
	$does = (string) ( $debug_test['fix']['does'] ?? '' );
	ok( '' !== $does, 'annotation: the WordPress debug test carries Morpheus\'s sentence' );
	ok( false === strpos( $does, 'readable over the web' ), 'annotation: …which does NOT claim the log is readable' );
	ok( false !== strpos( $does, 'not being served over the web' ), 'annotation: …and says what was verified about this host' );
}

// Leave the filters and the fixture the way this harness found them.
remove_filter( 'pre_http_request', $serve_fallback, 10 );
remove_filter( 'pre_http_request', $deny_quarantine, 10 );
@rename( (string) ( $row5['backup'] ?? '' ), $debuglog );
delete_option( Morpheus_Fixes::ATTEMPTS_OPTION );

// ── 5. the guided findings are refused, and nothing is touched ──────────────

section( '5. a modified core file is reported and NEVER touched' );

$core_mtime = filemtime( ABSPATH . $core_modified );
$core_hash  = md5_file( ABSPATH . $core_modified );
foreach ( array( 'morpheus_core_checksums', 'morpheus_plugin_checksums', 'morpheus_admin_users', 'morpheus_cron_unattributed', 'morpheus_recent_files' ) as $id ) {
	$r = Morpheus_Fixes::apply( $id );
	ok( ( $r['code'] ?? '' ) === 'NOT_AUTOMATIC', "guided: $id is refused by apply(), with a code" );
	ok( empty( $r['ok'] ), "guided: $id changed nothing" );
}
ok( md5_file( ABSPATH . $core_modified ) === $core_hash && filemtime( ABSPATH . $core_modified ) === $core_mtime, 'the modified core file is byte-for-byte and second-for-second unchanged' );
ok( function_exists( 'get_user_by' ) && get_user_by( 'login', 'admin' ) instanceof WP_User, 'the administrator account still exists' );
$cron_after = _get_cron_array();
$still_scheduled = false;
foreach ( (array) $cron_after as $events ) {
	if ( isset( $events[ $cron_hook ] ) ) {
		$still_scheduled = true;
	}
}
ok( $still_scheduled, 'the unattributed cron hook is still scheduled — Morpheus did not unschedule it' );

$unknown = Morpheus_Fixes::apply( 'not_a_real_finding' );
ok( ( $unknown['code'] ?? '' ) === 'NO_FIX', 'an unknown finding is refused, not guessed at' );

// ── 6. the safe set is exactly the auto entries, and nothing else ───────────

section( '6. the safe set is exactly the registry\'s `auto` entries' );

$auto = array();
$guided = array();
foreach ( Morpheus_Fixes::registry() as $id => $entry ) {
	if ( 0 !== strpos( $id, 'morpheus_' ) || ! in_array( $id, array(
		'morpheus_uploads_php', 'morpheus_root_config_backup', 'morpheus_public_debug_log',
		'morpheus_stale_robots_txt', 'morpheus_core_checksums', 'morpheus_plugin_checksums',
		'morpheus_mu_plugins', 'morpheus_admin_users', 'morpheus_cron_unattributed',
		'morpheus_recent_files',
	), true ) ) {
		continue;
	}
	if ( 'auto' === ( $entry['kind'] ?? '' ) ) {
		$auto[] = $id;
	} elseif ( 'guided' === ( $entry['kind'] ?? '' ) ) {
		$guided[] = $id;
	}
}
sort( $auto );
sort( $guided );
ok( $auto === array( 'morpheus_public_debug_log', 'morpheus_root_config_backup', 'morpheus_stale_robots_txt', 'morpheus_uploads_php' ), 'exactly four clean findings are automatic: ' . implode( ', ', $auto ) );
ok( count( $guided ) === 6, 'the other six are guided: ' . implode( ', ', $guided ) );
// Every automatic entry must explain itself — an auto fix whose effect is not
// spelled out is one the operator cannot consent to.
$no_explanation = array();
foreach ( Morpheus_Fixes::registry() as $id => $entry ) {
	if ( 'auto' === ( $entry['kind'] ?? '' ) && empty( $entry['does'] ) ) {
		$no_explanation[] = $id;
	}
}
ok( $no_explanation === array(), 'every automatic fix explains what it will do', $no_explanation );

// The stale-robots finding's action is attached BY ID, not carried by the check.
// Morpheus_Health::robots_check() returns the finding with no `fix` key of its
// own; Morpheus_Fixes::annotate() is what gives it the registry's quarantine.
// Assert that mechanism directly, because a registry entry the annotation never
// reaches is a finding with no press that looks perfectly mapped in source.
$robots_bare     = array( array( 'id' => 'morpheus_stale_robots_txt', 'status' => 'recommended', 'label' => 'robots.txt is built by WordPress' ) );
$robots_unmapped = Morpheus_Fixes::annotate( $robots_bare );
ok( ( $robots_bare[0]['fix']['kind'] ?? '' ) === 'auto', 'robots: annotate() attaches the automatic quarantine to the finding by id' );
ok( ( $robots_bare[0]['fix']['label'] ?? '' ) === 'Quarantine the stale robots.txt', 'robots: …and it is the quarantine the registry names' );
ok( $robots_unmapped === array(), 'robots: …so the finding is never counted UNMAPPED' );
// A `good` robots finding is annotated too — the STATUS is what keeps it out of
// the press, in the app's safe set (scripts/verify-clean-site.mjs), so the plugin
// must not be the place that decides it.
$robots_good = array( array( 'id' => 'morpheus_stale_robots_txt', 'status' => 'good' ) );
Morpheus_Fixes::annotate( $robots_good );
ok( array_key_exists( 'fix', $robots_good[0] ), 'robots: annotate() attaches the fix even when the check reads good' );

// ── 6b. every guided step link is an absolute URL on THIS site ──────────────
//
// The defect this pins down: every guided step carried a root-relative
// '/wp-admin/…'. The Morpheus app renders the value straight into an href, so a
// path resolves against the ORIGIN THE APP IS LOADED FROM — morpheus.nz — hits
// the app's own catch-all route, and shows Morpheus's "Page Not Found / the AI
// hasn't implemented this page yet" screen. The operator clicking a link to
// their own site was told the page did not exist. `admin_url()` also respects a
// site whose wp-admin does not live at /wp-admin/, which a literal cannot.
//
// Asserted on the REAL registry, walking the actual link values — a text search
// that a comment can satisfy is not a check.

section( '6b. every guided step link is an absolute URL on this site' );

$site_host = wp_parse_url( home_url(), PHP_URL_HOST );
$relative  = array();
$offsite   = array();
$links     = 0;
foreach ( Morpheus_Fixes::registry() as $id => $entry ) {
	foreach ( (array) ( $entry['steps'] ?? array() ) as $step ) {
		$link = (string) ( $step['link'] ?? '' );
		if ( '' === $link ) {
			continue;
		}
		$links++;
		$parts = wp_parse_url( $link );
		if ( empty( $parts['scheme'] ) || empty( $parts['host'] ) ) {
			$relative[] = $id . ' → ' . $link;
		} elseif ( 0 !== strcasecmp( (string) $parts['host'], (string) $site_host ) ) {
			$offsite[] = $id . ' → ' . $link;
		}
	}
}
ok( $links >= 10, "the registry's guided step links were found to assert against ($links)" );
ok( $relative === array(), 'no guided step link is a root-relative path' . ( $relative ? ' — ' . implode( ', ', $relative ) : '' ) );
ok( $offsite === array(), 'every guided step link is on this site' . ( $offsite ? ' — ' . implode( ', ', $offsite ) : '' ) );
ok( ! empty( wp_parse_url( home_url(), PHP_URL_HOST ) ), 'this boot has a site host to compare against (parser sanity)' );

// ── 7. a good site produces no attention-worthy finding ─────────────────────
//
// THE FIXTURES ARE REMOVED and the site is made to look like a site that has been
// running rather than one installed five minutes ago. That second half matters:
// "recently changed" and "an admin registered this week" are TRUE of a fresh
// WordPress and would fire on every install, which is exactly why the check has
// to be asserted against a settled site rather than a brand-new one — otherwise
// this section proves nothing about the rule and only about the boot.

section( '7. with the fixtures gone, a settled site needs nothing' );

// Remove every fixture. This is the "good site" the checks must not alarm on.
@unlink( $injected );
@unlink( $plain );
@unlink( $debuglog );
@unlink( $mufile );
@rmdir( $mudir );
@unlink( $recent_fixture );
@rmdir( dirname( $recent_fixture ) );
// wp_unschedule_hook, NOT wp_clear_scheduled_hook: the latter only clears events
// whose args match the (empty) default, and this fixture was scheduled WITH args —
// so the hook survived and section 7 failed on its own fixture. The harness caught
// its own bug the same way it catches the plugin's.
if ( function_exists( 'wp_unschedule_hook' ) ) {
	wp_unschedule_hook( $cron_hook );
} else {
	wp_clear_scheduled_hook( $cron_hook, array( 'x' ) );
}
foreach ( array( 'wp-config.php.bak', '.env' ) as $name ) {
	foreach ( glob( dirname( untrailingslashit( ABSPATH ) ) . '/' . $name . '.morpheus-bak-*' ) ?: array() as $left ) {
		@unlink( $left );
	}
}
// The quarantine directory this boot's fixes used, so nothing this harness made
// is left behind for a later scan to see.
foreach ( glob( trailingslashit( MORPHEUS_STATE_DIR ) . 'quarantine/*.morpheus-bak-*' ) ?: array() as $left ) {
	@unlink( $left );
}
// The simulation of a modified core file goes with them: this site's core is now
// asked about with its REAL hashes, so the only thing left being asserted is
// whether the comparison itself is right.
$GLOBALS['morpheus_checksum_fixture'] = array(
	'checksums' => array(
		$core_intact   => md5_file( ABSPATH . $core_intact ),
		$core_modified => md5_file( ABSPATH . $core_modified ),
	),
);

// Backdate the trees so the site reads as one that has been running. The mounted
// plugin directory is skipped deliberately — it is this repository, and touching
// it would rewrite the mtimes of the working tree.
$skip_morpheus = trailingslashit( wp_normalize_path( WP_PLUGIN_DIR ) ) . 'morpheus';
$old_time      = time() - ( 30 * DAY_IN_SECONDS );
$touched       = 0;
$touch_start   = microtime( true );
$roots         = array( ABSPATH . 'wp-admin', ABSPATH . 'wp-includes', WP_PLUGIN_DIR, get_theme_root() );
foreach ( glob( ABSPATH . '*.php' ) ?: array() as $top ) {
	@touch( $top, $old_time );
}
foreach ( $roots as $root ) {
	if ( ! is_dir( $root ) ) {
		continue;
	}
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::SELF_FIRST
	);
	foreach ( $it as $info ) {
		if ( $info->isDir() ) {
			continue;
		}
		if ( 0 === strpos( wp_normalize_path( $info->getPathname() ), $skip_morpheus ) ) {
			continue;
		}
		@touch( $info->getPathname(), $old_time );
		$touched++;
	}
}
printf( "        backdated %d files in %d ms, so this site reads as settled\n", $touched, (int) round( ( microtime( true ) - $touch_start ) * 1000 ) );

// The administrator account was created at install time, which is minutes ago.
$wpdb->update( $wpdb->users, array( 'user_registered' => gmdate( 'Y-m-d H:i:s', $old_time ) ), array( 'ID' => 1 ) );
clean_health_flush_user_cache();
function clean_health_flush_user_cache() {
	wp_cache_flush();
}

Morpheus_Clean::forget();
$good = Morpheus_Clean::scan( true );
$attention = array_values( array_filter( (array) $good['findings'], function ( $f ) {
	return in_array( $f['status'] ?? '', array( 'critical', 'recommended' ), true );
} ) );
$attention_report = array_map( function ( $f ) {
	return $f['id'] . ':' . $f['status'] . ' (' . wp_json_encode( array_column( (array) ( $f['details'] ?? array() ), 'file' ) ) . ')';
}, $attention );
ok( $attention === array(), 'a settled site with no fixtures produces no attention-worthy finding' . ( $attention ? ' — got: ' . implode( ', ', $attention_report ) : '' ) );
ok( ! empty( $good['findings'] ), '…and the scan still returned its checks, so this is not a vacuous pass' );
$statuses = array_unique( array_column( $good['findings'], 'status' ) );
ok( count( array_diff( $statuses, array( 'good', 'recommended', 'critical', 'unknown' ) ) ) === 0, 'every status is one the panel knows' );
$good_ids = array_column( $good['findings'], 'id' );
ok( in_array( 'morpheus_uploads_php', $good_ids, true ) && 'good' === clean_finding( $good, 'morpheus_uploads_php' )['status'], 'the uploads check is still present and now reads good' );
ok( 'good' === clean_finding( $good, 'morpheus_root_config_backup' )['status'], 'the site-root check reads good once the copies are gone' );
ok( 'good' === clean_finding( $good, 'morpheus_core_checksums' )['status'], 'the core check reads good when every checksum matches' );
ok( 'good' === clean_finding( $good, 'morpheus_admin_users' )['status'], 'the admin check reads good once no account is newly registered' );
ok( 'good' === clean_finding( $good, 'morpheus_recent_files' )['status'], 'the recent-files check reads good once nothing has changed for a month' );

// ── 8. the signed route dispatches on the action ─────────────────────────────

section( '8. the signed /health route dispatches on the action' );

$secret = 'clean-harness-secret';
update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), array( 'webhook_secret' => $secret, 'armed' => 0 ) ) );

function clean_health_req( $body, $secret ) {
	$body['at'] = gmdate( 'c' );
	$raw        = wp_json_encode( $body );
	$r          = new WP_REST_Request( 'POST', '/morpheus/v1/health' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

$clean_res = clean_health_req( array( 'action' => 'clean', 'force' => true ), $secret );
ok( $clean_res->get_status() === 200, 'action=clean answers 200' );
$clean_body = $clean_res->get_data();
ok( is_array( $clean_body['findings'] ?? null ), '…with a clean payload (it has a findings list), not a health one' );
ok( array_key_exists( 'tests', $clean_body ) === false, '…and it is NOT a health scan' );

$health_res = clean_health_req( array( 'force' => true ), $secret );
$health_body = $health_res->get_data();
ok( $health_res->get_status() === 200, 'no action answers 200' );
ok( is_array( $health_body['tests'] ?? null ) && ! isset( $health_body['findings'] ), '…with a health payload, so the default did not change' );

$bad_res = clean_health_req( array( 'action' => 'scrub' ), $secret );
ok( $bad_res->get_status() === 400, 'an unknown action is refused rather than answered with a scan' );
ok( ( $bad_res->get_data()['error'] ?? '' ) === 'unknown_action', '…with the code the app already understands' );

ok( clean_health_req( array( 'action' => 'clean' ), 'wrong-secret' )->get_status() === 401, 'a bad signature is still 401 — the clean action did not open the route up' );

// `force` must reach the scan itself: this was declared in the app, accepted by
// the route and DROPPED before the scan, so RESCAN returned a cached answer for
// five minutes and read as fresh.
Morpheus_Health::scan( true );                       // prime the health cache
$health_forced = clean_health_req( array( 'force' => true ), $secret )->get_data();
ok( ( $health_forced['cached'] ?? null ) === false, 'a forced health scan actually bypasses the cache' );

delete_option( 'morpheus_settings' );
delete_transient( Morpheus_Clean::CACHE_KEY );

echo "\n";
if ( $skipped > 0 ) {
	echo "  ($skipped skipped — see the SKIP lines above)\n";
}
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
