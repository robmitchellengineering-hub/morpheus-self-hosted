<?php
/**
 * Does one-click updating actually work — through WordPress's OWN upgrader?
 *
 * tests/harness.php asserts the channel's logic: the version comparison, the
 * transient WordPress reads, and that a mismatched hash is refused. That is not
 * the same claim as "an operator taps Update now and gets the new code", so
 * this boots WordPress and runs the real thing, in the order that actually
 * happens on a live site:
 *
 *   1. an OLD version of a plugin is installed (that is always the situation —
 *      Plugin_Upgrader::bulk_upgrade() backs the old copy up before it writes
 *      the new one, and fails outright if there is nothing to back up),
 *   2. our channel advertises a newer version with the package's real SHA-256,
 *   3. Plugin_Upgrader::bulk_upgrade() runs exactly as wp-admin runs it,
 *   4. the installed version is now the new one,
 *   5. the same upgrade with a hash that does not match leaves the OLD version
 *      installed and reports why.
 *
 * Step 5 is the point of the whole exercise: a refused update must leave a
 * working plugin, not a half-installed one.
 *
 * WHY A FIXTURE PLUGIN AND NOT MORPHEUS ITSELF: the Morpheus plugin is mounted
 * from the host checkout here, and WordPress replaces a plugin by MOVING its
 * directory. Upgrading the real one would move files out of the repository. The
 * fixture lives in a fresh directory inside the sandbox, so nothing outside it
 * can be touched while every step that matters — our verify_download hook,
 * WordPress's download, unpack, backup and install — is the real code path.
 *
 *   wp-playground-cli php \
 *     --auto-mount ./wp-plugin/morpheus \
 *     --mount ./wp-plugin/morpheus/tests:/tests \
 *     -- /tests/harness-updates.php
 */

$wp_load = '/wordpress/wp-load.php';
if ( ! file_exists( $wp_load ) ) {
	fwrite( STDERR, "wp-load.php not found at $wp_load\n" );
	exit( 2 );
}
require $wp_load;

$pass = 0;
$fail = 0;
function ok( $cond, $label ) {
	global $pass, $fail;
	if ( $cond ) { $pass++; echo "  PASS  $label\n"; }
	else         { $fail++; echo "  FAIL  $label\n"; }
}

echo "\n== one-click update: through WordPress's real upgrader ==\n";

if ( ! class_exists( 'Morpheus_Updates' ) ) {
	echo "  (the Morpheus plugin is not active in this boot — cannot test the channel)\n";
	exit( 1 );
}

require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
require_once ABSPATH . 'wp-admin/includes/class-plugin-upgrader.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader-skin.php';
require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';

$tmp          = trailingslashit( get_temp_dir() );
$fixture_slug = 'morpheus-fixture';
$fixture_base = $fixture_slug . '/morpheus-fixture.php';
$fixture_dir  = WP_PLUGIN_DIR . '/' . $fixture_slug;
$zip_path     = $tmp . 'morpheus-wordpress-plugin.zip'; // the URL the hook matches on

/** Install the OLD version of the fixture plugin, as a live site would have. */
function morpheus_install_fixture( $dir, $version ) {
	if ( ! is_dir( $dir ) ) {
		wp_mkdir_p( $dir );
	}
	file_put_contents( $dir . '/morpheus-fixture.php', "<?php\n/**\n * Plugin Name: Morpheus Fixture\n * Version: {$version}\n */\n" );
	wp_clean_plugins_cache( false );
	return ( get_plugins()[ 'morpheus-fixture/morpheus-fixture.php' ]['Version'] ?? '' ) === $version;
}

/** Build the NEW package: one plugin folder, a chosen version. */
function morpheus_build_fixture_zip( $src_base, $zip_path, $version ) {
	$src = $src_base . '/morpheus-fixture';
	foreach ( glob( $src . '/*' ) ?: array() as $f ) { @unlink( $f ); }
	wp_mkdir_p( $src );
	file_put_contents( $src . '/morpheus-fixture.php', "<?php\n/**\n * Plugin Name: Morpheus Fixture\n * Version: {$version}\n */\n" );
	@unlink( $zip_path );
	$zip = new PclZip( $zip_path );
	$res = $zip->create( $src, PCLZIP_OPT_REMOVE_PATH, $src_base );
	return ! is_wp_error( $res ) && file_exists( $zip_path );
}

/** Offer one update through our channel and let wp-admin's upgrader do the rest. */
function morpheus_run_upgrade( $fixture_base, $package, $sha256 ) {
	$transient = new stdClass();
	$transient->last_checked = time();
	$transient->checked      = array();
	$transient->response     = array(
		$fixture_base => (object) array(
			'slug'            => 'morpheus-fixture',
			'plugin'          => $fixture_base,
			'new_version'     => '9.9.9',
			'package'         => $package,
			'morpheus_sha256' => $sha256,
		),
	);
	$transient->translations = array();
	$transient->no_update    = array();
	// set_site_transient runs pre_set_site_transient_update_plugins on the way
	// in, so our own offer_update() gets its turn — the real order of events.
	set_site_transient( 'update_plugins', $transient );

	$upgrader = new Plugin_Upgrader( new Automatic_Upgrader_Skin() );
	return $upgrader->bulk_upgrade( array( $fixture_base ) );
}

/**
 * The manifest, as this site would read it. A fixture, because the point is to
 * test the verification — a harness that reached the real morpheus.nz would
 * pass or fail depending on the network, and would verify against the wrong
 * package.
 */
$manifest = array(
	'version' => '9.9.9',
	'sha256'  => '',
	'url'     => 'https://morpheus.nz/morpheus-wordpress-plugin.zip',
);
add_filter( 'pre_http_request', function ( $pre, $args, $url ) use ( &$manifest ) {
	if ( strpos( $url, 'plugin-manifest.json' ) === false ) { return $pre; }
	if ( empty( $manifest['sha256'] ) ) { return new WP_Error( 'no_manifest', 'manifest fixture unavailable' ); }
	return array( 'headers' => array(), 'body' => json_encode( $manifest ), 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 9, 3 ); // before the package stub

/** Serve the package the way the real transport does: body AND streamed file. */
add_filter( 'pre_http_request', function ( $pre, $args, $url ) use ( $zip_path ) {
	if ( strpos( $url, 'morpheus-wordpress-plugin.zip' ) === false ) { return $pre; }
	if ( ! file_exists( $zip_path ) ) { return new WP_Error( 'no_fixture', 'fixture not built' ); }
	$body = file_get_contents( $zip_path );
	if ( ! empty( $args['filename'] ) ) { file_put_contents( $args['filename'], $body ); }
	return array( 'headers' => array(), 'body' => $body, 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 10, 3 );

WP_Filesystem();

$package_url = 'https://morpheus.nz/morpheus-wordpress-plugin.zip';
$installed_version = function () use ( $fixture_base ) {
	wp_clean_plugins_cache( false );
	return get_plugins()[ $fixture_base ]['Version'] ?? '';
};

// ── 1. the old version is installed, then updated ───────────────────────────
ok( morpheus_install_fixture( $fixture_dir, '1.0.0' ), 'the OLD version of the fixture plugin is installed' );
ok( morpheus_build_fixture_zip( $tmp . 'morpheus-fixture-src', $zip_path, '9.9.9' ), 'built the new package with PclZip' );
$real_sha = hash_file( 'sha256', $zip_path );
ok( is_string( $real_sha ) && strlen( $real_sha ) === 64, 'the package has a sha256' );

$manifest['sha256'] = $real_sha;
delete_transient( Morpheus_Updates::CACHE_KEY );

$result = morpheus_run_upgrade( $fixture_base, $package_url, $real_sha );
$entry  = is_array( $result ) ? ( $result[ $fixture_base ] ?? null ) : null;
ok( ! is_wp_error( $entry ), 'a verified package upgrades without error' . ( is_wp_error( $entry ) ? ' — ' . $entry->get_error_message() : '' ) );
// WP_Upgrader::run() returns an ARRAY describing the completed run on success
// (destination paths etc.), `false` on a soft failure and a WP_Error on a hard
// one — so "it worked" is an array with a destination, not `true`.
$inner = is_array( $entry ) ? $entry : null;
ok( is_array( $inner ) && ! empty( $inner['destination'] ), 'the upgrader returned a completed run (destination recorded)' . ( is_array( $inner ) ? '' : ' — got ' . gettype( $entry ) ) );
ok( $installed_version() === '9.9.9', 'the installed version is now the NEW one (one-click update works end to end)' );

// ── 2. a tampered package is refused, and the old version survives ──────────
ok( morpheus_install_fixture( $fixture_dir, '1.0.0' ), 'rolled the fixture back to the old version for the refusal test' );
ok( $installed_version() === '1.0.0', 'the old version is what a refused update has to protect' );

// The manifest still describes the REAL package; what changes is the bytes
// served. So this is exactly the tampered-mirror case.
$manifest['sha256'] = $real_sha;
delete_transient( Morpheus_Updates::CACHE_KEY );
$tampered_zip = $tmp . 'morpheus-wordpress-plugin.zip';
$original_zip = file_get_contents( $zip_path );
file_put_contents( $tampered_zip, $original_zip . 'tampered' ); // same URL, different bytes

$tampered       = morpheus_run_upgrade( $fixture_base, $package_url, $real_sha );
$tampered_entry = is_array( $tampered ) ? ( $tampered[ $fixture_base ] ?? null ) : null;
$tampered_inner = is_array( $tampered_entry ) ? ( $tampered_entry['result'] ?? null ) : $tampered_entry;
// A refusal comes back as a WP_Error (verified here, not assumed): a plain
// `false` would also count, so both shapes are accepted but neither silently.
$is_refused     = is_wp_error( $tampered_entry ) || is_wp_error( $tampered_inner ) || $tampered_inner === false;
ok( is_wp_error( $tampered_entry ), 'the refusal is reported as a WordPress error (not a silent failure)' );
ok( $is_refused, 'a package whose hash does not match FAILS the update' );
$msg = is_wp_error( $tampered_entry ) ? $tampered_entry->get_error_message()
	: ( is_wp_error( $tampered_inner ) ? $tampered_inner->get_error_message() : '' );
ok( strpos( (string) $msg, 'checksum' ) !== false, 'the refusal names the checksum, so the operator can act on it' );
ok( $installed_version() === '1.0.0', 'the site is still running the OLD version — a refused update broke nothing' );

file_put_contents( $tampered_zip, $original_zip ); // put the real package back

// ── 3. a package with no published checksum is refused too ──────────────────
ok( morpheus_install_fixture( $fixture_dir, '1.0.0' ), 'reset to the old version for the unverifiable case' );
$manifest['sha256'] = '';
delete_transient( Morpheus_Updates::CACHE_KEY );
$unverifiable = morpheus_run_upgrade( $fixture_base, $package_url, '' );
$unv_entry = is_array( $unverifiable ) ? ( $unverifiable[ $fixture_base ] ?? null ) : null;
$unv_inner = is_array( $unv_entry ) ? ( $unv_entry['result'] ?? null ) : $unv_entry;
ok( is_wp_error( $unv_entry ) || is_wp_error( $unv_inner ) || $unv_inner === false, 'an unverifiable package FAILS the update' );
ok( $installed_version() === '1.0.0', 'and the old version is still the one running' );

// ── 4. the guard is wired where it has to be ────────────────────────────────
ok( (bool) has_filter( 'upgrader_pre_download', array( 'Morpheus_Updates', 'verify_download' ) ), 'the verification hook is registered on the upgrader' );
ok( (bool) has_filter( 'pre_set_site_transient_update_plugins', array( 'Morpheus_Updates', 'offer_update' ) ), 'the update offer is registered where WordPress reads it' );

// tidy up: leave the sandbox as we found it
foreach ( glob( $fixture_dir . '/*' ) ?: array() as $f ) { @unlink( $f ); }
@rmdir( $fixture_dir );
$src = $tmp . 'morpheus-fixture-src/morpheus-fixture';
foreach ( glob( $src . '/*' ) ?: array() as $f ) { @unlink( $f ); }
@rmdir( $src );
@rmdir( $tmp . 'morpheus-fixture-src' );
@unlink( $zip_path );
delete_site_transient( 'update_plugins' );
wp_clean_plugins_cache( false );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
