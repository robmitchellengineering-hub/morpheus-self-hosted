<?php
/**
 * Does the maintenance executor refuse to update what it cannot undo?
 *
 * tests/harness-updates.php proves that WordPress's own Plugin_Upgrader installs
 * a verified package end to end. That is the happy path of a DIFFERENT question.
 * This harness drives Morpheus_Maintenance, whose whole job is the opposite:
 * never touch a target it cannot put back, and never claim success it did not
 * verify.
 *
 * What it asserts, in a real WordPress:
 *
 *   1. plan() reports without writing — no backup directory, no new files
 *   2. a MAJOR core release is refused, with a reason, and never listed as a
 *      target (injected through WordPress's own core-update transient filter)
 *   3. a minor core release on the same major version IS a target
 *   4. apply( dry_run ) changes nothing and says so
 *   5. one real snapshot() + restore() round-trip on a fixture plugin: the
 *      snapshot is taken, data.txt is modified, restore() puts the known bytes
 *      back — including a file in a subdirectory
 *   6. snapshot() refuses an id that escapes its root (plugin and theme), and
 *      restore()/delete_snapshot() refuse a path outside the backup directory
 *   7. apply() refuses BAD_TARGET, TOO_MANY, and CANNOT_WRITE — the last by
 *      seeding Morpheus_Health's own scan cache with an unwritable host
 *   8. backups() lists the snapshot, then cleanup
 *
 * It deliberately does NOT run a real plugin update: that needs an installable
 * package and a writable plugins tree, and harness-updates.php already owns that
 * ground. The one real write here is the snapshot/restore round-trip, which is
 * the part of the contract nothing else exercises.
 *
 * Run it in a real WordPress (WASM PHP, no Docker):
 *
 *   npx --yes @wp-playground/cli@latest php --php 8.2 --wp latest --verbosity quiet \
 *     --auto-mount ./wp-plugin/morpheus \
 *     --mount ./wp-plugin/morpheus/tests:/tests \
 *     -- /tests/harness-maintenance.php
 */

$wp_load = '/wordpress/wp-load.php';
if ( ! file_exists( $wp_load ) ) {
	fwrite( STDERR, "wp-load.php not found at $wp_load\n" );
	exit( 2 );
}
require $wp_load;

// The plugin is mounted and activated for this boot (--auto-mount). If this
// boot did not activate it, load it from where the mount put it: this harness
// is about Morpheus_Maintenance, not about activation.
if ( ! class_exists( 'Morpheus_Health' ) ) {
	$morpheus_main = WP_PLUGIN_DIR . '/morpheus/morpheus.php';
	if ( file_exists( $morpheus_main ) ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		require_once $morpheus_main;
	}
}
if ( ! class_exists( 'Morpheus_Maintenance' ) ) {
	$morpheus_class = ( defined( 'MORPHEUS_DIR' ) ? MORPHEUS_DIR : WP_PLUGIN_DIR . '/morpheus/' ) . 'includes/class-maintenance.php';
	if ( file_exists( $morpheus_class ) ) {
		require_once $morpheus_class;
	}
}

// The plugin bootstrap adds admin_includes() itself; the harness needs the
// upgrader classes on hand for the comments it reads, exactly as the
// convention in harness-updates.php does.
require_once ABSPATH . 'wp-admin/includes/file.php';
require_once ABSPATH . 'wp-admin/includes/misc.php';
require_once ABSPATH . 'wp-admin/includes/plugin.php';
require_once ABSPATH . 'wp-admin/includes/update.php';
require_once ABSPATH . 'wp-admin/includes/admin.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
require_once ABSPATH . 'wp-admin/includes/class-plugin-upgrader.php';
require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader-skin.php';
require_once ABSPATH . 'wp-admin/includes/class-pclzip.php';

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

/** A deterministic listing of a tree: relative path => 'dir' or byte size. */
function morpheus_tree_list( $dir ) {
	$out = array();
	if ( ! is_dir( $dir ) ) {
		return $out;
	}
	$base = trailingslashit( wp_normalize_path( $dir ) );
	$it   = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::SELF_FIRST
	);
	foreach ( $it as $info ) {
		$rel = ltrim( substr( wp_normalize_path( $info->getPathname() ), strlen( $base ) ), '/' );
		$out[ $rel ] = $info->isDir() ? 'dir' : (string) $info->getSize();
	}
	ksort( $out );
	return $out;
}

function morpheus_rmtree( $dir ) {
	if ( ! is_dir( $dir ) ) {
		return;
	}
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ( $it as $info ) {
		if ( $info->isDir() && ! $info->isLink() ) { @rmdir( $info->getPathname() ); }
		else { @unlink( $info->getPathname() ); }
	}
	@rmdir( $dir );
}

/**
 * Install the fixture plugin, as a live site would have it. Small on purpose:
 * one main file, a data file the round-trip modifies, and one file inside a
 * subdirectory so restore() has to recurse.
 */
function morpheus_install_fixture( $dir, $version, $known ) {
	if ( ! is_dir( $dir . '/lib' ) ) {
		wp_mkdir_p( $dir . '/lib' );
	}
	file_put_contents( $dir . '/morpheus-fixture.php', "<?php\n/**\n * Plugin Name: Morpheus Fixture\n * Version: {$version}\n */\n" );
	file_put_contents( $dir . '/data.txt', $known );
	file_put_contents( $dir . '/lib/extra.txt', 'nested-content-before-update' );
	wp_clean_plugins_cache( false );
	$all = get_plugins();
	return ( $all['morpheus-fixture/morpheus-fixture.php']['Version'] ?? '' ) === $version;
}

/** One core update object, shaped the way WordPress's transient holds them. */
function morpheus_fake_core_update( $current, $offered ) {
	$package = 'https://example.invalid/wordpress-' . $offered . '.zip';
	return (object) array(
		'response'        => 'upgrade',
		'current'         => $current,
		'version'         => $offered,
		'locale'          => 'en_US',
		'package'         => $package,
		'download'        => $package,
		'partial_version' => false,
		'packages'        => (object) array(
			'full'        => $package,
			'no_content'  => $package,
			'new_bundled' => $package,
			'partial'     => false,
			'rollback'    => false,
		),
	);
}

echo "\n==== Morpheus_Maintenance ====\n";
flush();

ok( class_exists( 'Morpheus_Health' ), 'Morpheus_Health is loaded (the host verdict this class reuses)' );
ok( class_exists( 'Morpheus_Maintenance' ), 'Morpheus_Maintenance is loaded' );
if ( ! class_exists( 'Morpheus_Maintenance' ) ) {
	echo "\n==== $pass passed, $fail failed ====\n";
	exit( 1 );
}

$fixture_slug = 'morpheus-fixture';
$fixture_base = $fixture_slug . '/morpheus-fixture.php';
$fixture_dir  = WP_PLUGIN_DIR . '/' . $fixture_slug;
$known        = 'known-content-42';
$snapshot     = null;

$uploads    = wp_upload_dir();
$backup_dir = trailingslashit( wp_normalize_path( $uploads['basedir'] ) ) . Morpheus_Maintenance::BACKUP_DIRNAME;

// ── 1. plan() is read-only ──────────────────────────────────────────────────
section( '1. plan() reports without writing' );
// wp_upload_dir() can create the uploads directory itself; prime it before the
// "before" listing so that WordPress's own side effect is not blamed on plan().
$before = morpheus_tree_list( $uploads['basedir'] );
$plan   = Morpheus_Maintenance::plan();
$after  = morpheus_tree_list( $uploads['basedir'] );

ok( is_array( $plan ) && isset( $plan['targets'] ) && is_array( $plan['targets'] ), 'plan() returns targets' );
ok( is_array( $plan ) && isset( $plan['refused'] ) && is_array( $plan['refused'] ), 'plan() returns refused' );
ok( is_array( $plan ) && isset( $plan['ok'] ) && true === $plan['ok'], 'plan() reports ok' );
ok( is_array( $plan ) && isset( $plan['can_apply'] ) && is_bool( $plan['can_apply'] ), 'plan() reports can_apply as a boolean' );
ok( is_array( $plan ) && isset( $plan['blockers'] ) && is_array( $plan['blockers'] ), 'plan() lists blockers' );
ok( ! file_exists( $backup_dir ), 'plan() did not create the backup directory (' . $backup_dir . ')' );
ok( $before === $after, 'plan() left wp-content/uploads exactly as it found it' );
echo '     (installed WordPress ' . get_bloginfo( 'version' ) . ', ZipArchive ' . ( class_exists( 'ZipArchive' ) ? 'present' : 'MISSING' ) . ")\n";

// ── 2 & 3. the core major/minor rule ────────────────────────────────────────
section( '2-3. core: a major bump is refused, a minor release is a target' );
$installed  = (string) get_bloginfo( 'version' );
$parts      = explode( '.', $installed );
$next_major = ( (int) $parts[0] + 1 ) . '.0';
$next_minor = (int) $parts[0] . '.' . ( isset( $parts[1] ) ? (int) $parts[1] : 0 ) . '.' . ( ( isset( $parts[2] ) ? (int) $parts[2] : 0 ) + 1 );

$inject_core = function ( $pre, $transient ) use ( $installed, $next_major, $next_minor ) {
	if ( 'update_core' !== $transient ) {
		return $pre;
	}
	$fake            = new stdClass();
	$fake->last_checked    = time();
	$fake->version_checked = $installed;
	$fake->translations    = array();
	$fake->updates         = array(
		morpheus_fake_core_update( $installed, $next_major ),
		morpheus_fake_core_update( $installed, $next_minor ),
	);
	return $fake;
};
add_filter( 'pre_site_transient_update_core', $inject_core, 99, 2 );
$plan = Morpheus_Maintenance::plan();
remove_filter( 'pre_site_transient_update_core', $inject_core, 99 );

$core_targets = array();
$core_refused = array();
$major_offered = false;
foreach ( (array) $plan['targets'] as $t ) {
	if ( isset( $t['kind'] ) && 'core_minor' === $t['kind'] ) { $core_targets[] = $t; }
	if ( isset( $t['new_version'] ) && $next_major === $t['new_version'] ) { $major_offered = true; }
}
foreach ( (array) $plan['refused'] as $r ) {
	if ( isset( $r['kind'] ) && 'core_major' === $r['kind'] ) { $core_refused[] = $r; }
}

ok( count( $core_targets ) === 1, 'exactly one core update is offered as a target' );
ok( count( $core_targets ) === 1 && $next_minor === $core_targets[0]['new_version'], 'the minor release ' . $next_minor . ' is the target (same major version)' );
ok( count( $core_targets ) === 1 && 'core' === $core_targets[0]['id'], 'the core target is identified as id "core"' );
ok( ! $major_offered, 'the major release ' . $next_major . ' never appears in targets' );
ok( count( $core_refused ) === 1, 'exactly one core update is refused' );
ok( count( $core_refused ) === 1 && $next_major === $core_refused[0]['new_version'], 'the major release ' . $next_major . ' is the one refused' );
$reason = count( $core_refused ) === 1 ? (string) $core_refused[0]['reason'] : '';
ok( '' !== $reason && false !== stripos( $reason, 'major' ), 'the refusal says why, in words a site owner can read' );
ok( '' !== $reason && false !== stripos( $reason, $next_major ), 'the refusal names the version it will not apply' );

// ── 4. dry run writes nothing ───────────────────────────────────────────────
section( '4. apply( dry_run ) reports without writing' );
ok( morpheus_install_fixture( $fixture_dir, '1.0.0', $known ), 'the fixture plugin is installed at version 1.0.0' );

$inject_plugin = function ( $pre, $transient ) use ( $fixture_base ) {
	if ( 'update_plugins' !== $transient ) {
		return $pre;
	}
	$fake              = new stdClass();
	$fake->last_checked = time();
	$fake->checked      = array( $fixture_base => '1.0.0' );
	$fake->no_update    = array();
	$fake->translations = array();
	$fake->response     = array(
		$fixture_base => (object) array(
			'slug'        => 'morpheus-fixture',
			'plugin'      => $fixture_base,
			'new_version' => '9.9.9',
			'package'     => 'https://example.invalid/morpheus-fixture-9.9.9.zip',
		),
	);
	return $fake;
};
add_filter( 'pre_site_transient_update_plugins', $inject_plugin, 99, 2 );
$before = morpheus_tree_list( WP_PLUGIN_DIR );
$result = Morpheus_Maintenance::apply( array( array( 'kind' => 'plugin', 'id' => $fixture_base ) ), array( 'dry_run' => true ) );
$after  = morpheus_tree_list( WP_PLUGIN_DIR );
remove_filter( 'pre_site_transient_update_plugins', $inject_plugin, 99 );

$row = ( is_array( $result ) && isset( $result['results'][0] ) && is_array( $result['results'][0] ) ) ? $result['results'][0] : array();
ok( is_array( $result ) && ! empty( $result['ok'] ), 'apply() ran; per-target problems live in results' );
ok( is_array( $result ) && isset( $result['dry_run'] ) && true === $result['dry_run'], 'the return says dry_run' );
ok( $before === $after, 'a dry run changed nothing in the plugin directory' );
ok( ! file_exists( $backup_dir ), 'a dry run did not create the backup directory' );
ok( isset( $row['to'] ) && '9.9.9' === $row['to'], 'the dry run read the offered version from WordPress (9.9.9)' );
ok( empty( $row['updated'] ) && empty( $row['verified'] ) && empty( $row['restored'] ), 'the dry run does not claim an update, a verification or a restore' );

// ── 5. one real snapshot() + restore() round-trip ───────────────────────────
section( '5. snapshot() + restore() round-trip on a fixture' );
if ( ! class_exists( 'ZipArchive' ) ) {
	skip( 'snapshot/restore round-trip', 'this PHP has no ZipArchive, so Morpheus would refuse to update at all' );
} else {
	$snapshot = Morpheus_Maintenance::snapshot( 'plugin', $fixture_base );
	$snap_msg = is_wp_error( $snapshot ) ? ' — ' . $snapshot->get_error_message() : '';
	ok( ! is_wp_error( $snapshot ), 'snapshot() took a backup of the fixture' . $snap_msg );
	ok( is_array( $snapshot ) && ! empty( $snapshot['bytes'] ) && $snapshot['bytes'] > 0, 'the snapshot archive is non-empty (' . ( is_array( $snapshot ) ? $snapshot['bytes'] : 0 ) . ' bytes)' );

	$snapshot_path = ( is_array( $snapshot ) && isset( $snapshot['file'] ) ) ? trailingslashit( $backup_dir ) . $snapshot['file'] : '';
	ok( '' !== $snapshot_path && file_exists( $snapshot_path ), 'the snapshot exists on disk in the backup directory' );
	ok( is_array( $snapshot ) && isset( $snapshot['file'] ) && 0 === strpos( $snapshot['file'], 'plugin-morpheus-fixture-1.0.0-' ), 'it is named <kind>-<slug>-<version>-<timestamp>.zip (' . ( is_array( $snapshot ) ? $snapshot['file'] : 'none' ) . ')' );
	ok( file_exists( $backup_dir . '/index.php' ) && file_exists( $backup_dir . '/.htaccess' ), 'the backup directory is protected (index.php + .htaccess)' );

	if ( is_array( $snapshot ) && isset( $snapshot['file'] ) ) {
		file_put_contents( $fixture_dir . '/data.txt', 'MODIFIED-AFTER-SNAPSHOT' );
		file_put_contents( $fixture_dir . '/lib/extra.txt', 'ALSO-MODIFIED' );
		ok( 'MODIFIED-AFTER-SNAPSHOT' === file_get_contents( $fixture_dir . '/data.txt' ), 'data.txt was modified after the snapshot was taken' );

		$restore  = Morpheus_Maintenance::restore( 'plugin', $fixture_base, $snapshot['file'] );
		$res_msg  = is_wp_error( $restore ) ? ' — ' . $restore->get_error_message() : '';
		ok( true === $restore, 'restore() put the snapshot back' . $res_msg );
		ok( $known === file_get_contents( $fixture_dir . '/data.txt' ), 'data.txt is back to the known string after restore' );
		ok( file_exists( $fixture_dir . '/morpheus-fixture.php' ), 'the plugin main file is back after restore' );
		ok( 'nested-content-before-update' === file_get_contents( $fixture_dir . '/lib/extra.txt' ), 'a file inside a subdirectory was restored too' );
	}
}

// ── 6. path boundaries ──────────────────────────────────────────────────────
section( '6. a path that escapes its root is refused' );
foreach ( array( 'plugin', 'theme' ) as $kind ) {
	$escaped = Morpheus_Maintenance::snapshot( $kind, '../../../etc' );
	ok( is_wp_error( $escaped ), 'snapshot( ' . $kind . ', "../../../etc" ) is refused' );
	ok( is_wp_error( $escaped ) && false !== stripos( $escaped->get_error_message(), 'outside' ), 'the refusal for ' . $kind . ' says the path is outside its directory' );
}
$bad_restore = Morpheus_Maintenance::restore( 'plugin', $fixture_base, '../../../../etc/passwd' );
ok( is_wp_error( $bad_restore ), 'restore() refuses a snapshot path outside the backup directory' );

// ── 7. whole-call refusals ──────────────────────────────────────────────────
section( '7. apply() refuses what it cannot do' );
$bad = Morpheus_Maintenance::apply( array( array( 'kind' => 'database', 'id' => 'wp_posts' ) ), array( 'dry_run' => true ) );
ok( is_array( $bad ) && isset( $bad['ok'] ) && false === $bad['ok'], 'an unknown target kind is refused' );
ok( is_array( $bad ) && isset( $bad['code'] ) && 'BAD_TARGET' === $bad['code'], 'the code is BAD_TARGET' );
ok( is_array( $bad ) && isset( $bad['error'] ) && strlen( (string) $bad['error'] ) > 40, 'the refusal is a sentence a site owner can read' );

$major_target = Morpheus_Maintenance::apply( array( array( 'kind' => 'core_major', 'id' => 'core' ) ), array( 'dry_run' => true ) );
ok( is_array( $major_target ) && isset( $major_target['code'] ) && 'BAD_TARGET' === $major_target['code'], 'a caller cannot smuggle a major core update in as a target kind' );

$many = array();
for ( $i = 0; $i <= Morpheus_Maintenance::MAX_TARGETS; $i++ ) {
	$many[] = array( 'kind' => 'plugin', 'id' => 'plugin-' . $i . '/plugin-' . $i . '.php' );
}
$too_many = Morpheus_Maintenance::apply( $many, array( 'dry_run' => true ) );
ok( is_array( $too_many ) && isset( $too_many['code'] ) && 'TOO_MANY' === $too_many['code'], 'more than MAX_TARGETS (' . Morpheus_Maintenance::MAX_TARGETS . ') is refused' );

// Simulate a host that cannot write. The host verdict arrives through
// Morpheus_Health's own cached scan, so seed that cache and put it back after.
$real_scan = get_transient( 'morpheus_health_scan' );
set_transient( 'morpheus_health_scan', array(
	'host'  => array(
		'can_update_files' => false,
		'blockers'         => array( 'DISALLOW_FILE_MODS is set in wp-config.php, which forbids all file changes from WordPress' ),
	),
	'tests' => array(),
), 60 );
$blocked = Morpheus_Maintenance::apply( array( array( 'kind' => 'plugin', 'id' => $fixture_base ) ), array( 'dry_run' => true ) );
if ( false === $real_scan ) {
	delete_transient( 'morpheus_health_scan' );
} else {
	set_transient( 'morpheus_health_scan', $real_scan, 300 );
}
ok( is_array( $blocked ) && isset( $blocked['code'] ) && 'CANNOT_WRITE' === $blocked['code'], 'a host that cannot write files is refused with CANNOT_WRITE' );
ok( is_array( $blocked ) && isset( $blocked['error'] ) && false !== strpos( (string) $blocked['error'], 'DISALLOW_FILE_MODS' ), 'the refusal repeats the host\'s own reason back to the caller' );

// ── 8. backups() before cleanup ─────────────────────────────────────────────
section( '8. backups() lists the snapshots on disk' );
$list  = Morpheus_Maintenance::backups();
$names = array();
foreach ( (array) $list as $b ) {
	if ( isset( $b['name'] ) ) { $names[] = $b['name']; }
}
ok( is_array( $list ) && count( $list ) > 0, 'backups() lists at least one snapshot' );
ok( is_array( $snapshot ) && isset( $snapshot['file'] ) && in_array( $snapshot['file'], $names, true ), 'backups() lists the snapshot taken in test 5' );
$first = ( is_array( $list ) && isset( $list[0] ) && is_array( $list[0] ) ) ? $list[0] : array();
ok( isset( $first['name'], $first['size'], $first['mtime'] ) && $first['size'] > 0 && $first['mtime'] > 0, 'each entry carries a name, a size and an mtime' );

// ── cleanup ─────────────────────────────────────────────────────────────────
section( 'cleanup' );
if ( is_array( $snapshot ) && isset( $snapshot['file'] ) ) {
	$deleted = Morpheus_Maintenance::delete_snapshot( $snapshot['file'] );
	ok( true === $deleted, 'delete_snapshot() removed the snapshot it took' );
	$names = array();
	foreach ( (array) Morpheus_Maintenance::backups() as $b ) {
		if ( isset( $b['name'] ) ) { $names[] = $b['name']; }
	}
	ok( ! in_array( $snapshot['file'], $names, true ), 'the snapshot is gone from backups()' );
}
ok( is_wp_error( Morpheus_Maintenance::delete_snapshot( '/etc/passwd' ) ), 'delete_snapshot() refuses a file that is not one of its .zip snapshots' );
ok( is_wp_error( Morpheus_Maintenance::delete_snapshot( '../../../../etc/morpheus.zip' ) ), 'delete_snapshot() refuses a name that resolves outside the backup directory' );

morpheus_rmtree( $fixture_dir );
@unlink( $backup_dir . '/index.php' );
@unlink( $backup_dir . '/.htaccess' );
@rmdir( $backup_dir );
ok( ! file_exists( $fixture_dir ), 'the fixture plugin was removed' );
ok( ! file_exists( $backup_dir ), 'the backup directory was removed' );

echo "\n";
if ( $skipped > 0 ) {
	echo "  ($skipped skipped — see the SKIP lines above)\n";
}
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
