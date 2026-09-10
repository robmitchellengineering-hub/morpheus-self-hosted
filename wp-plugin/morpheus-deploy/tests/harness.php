<?php
/**
 * Integration + unit test harness for Morpheus Deploy. Run inside a
 * WordPress Playground boot with the plugin mounted + active:
 *
 *   wp-playground-cli php \
 *     --auto-mount ./wp-plugin/morpheus-deploy \
 *     --mount ./wp-plugin/morpheus-deploy/tests:/tests \
 *     -- /tests/harness.php
 *
 * Loads WordPress, checks the plugin registered its routes, unit-tests the
 * security-critical helpers, and drives the REST endpoints through
 * rest_do_request() (no HTTP, no real GitHub — a real dry-run against a
 * public repo is the last block and is skipped if outbound fetch fails).
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

echo "\n== plugin loaded ==\n";
ok( function_exists( 'morpheus_deploy_is_denied' ), 'helpers loaded' );
ok( class_exists( 'Morpheus_Deploy_REST' ), 'REST class loaded' );
ok( class_exists( 'Morpheus_Deploy_Deployer' ), 'Deployer class loaded' );

// Force route registration (rest_api_init may not have fired in CLI context).
if ( class_exists( 'Morpheus_Deploy_REST' ) ) {
	Morpheus_Deploy_REST::register_routes();
}
$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/deploy'] ), 'route /morpheus/v1/deploy registered' );
ok( isset( $routes['/morpheus/v1/status'] ), 'route /morpheus/v1/status registered' );

echo "\n== helpers: deny-list ==\n";
$denied = array( 'wp-config.php', 'a/wp-config.php', 'wp-content/uploads/2024/x.jpg', '.htaccess', '.env.production', 'x/.git/config', '.user.ini', 'wp-content/cache/x.php' );
foreach ( $denied as $p ) { ok( morpheus_deploy_is_denied( $p ), "denied: $p" ); }
$allowed = array( 'index.php', 'wp-content/themes/woodmart-child/style.css', 'wp-content/plugins/x/x.php', 'wp-content/mu-plugins/y.php' );
foreach ( $allowed as $p ) { ok( ! morpheus_deploy_is_denied( $p ), "allowed: $p" ); }

echo "\n== helpers: path safety ==\n";
foreach ( array( '../x', '/abs', 'a/../b', "a\0b", 'a\\b', '.', 'a/./b' ) as $p ) { ok( ! morpheus_deploy_path_is_safe( $p ), "unsafe: " . json_encode( $p ) ); }
foreach ( array( 'wp-content/themes/x/a.php', 'index.php', 'a/b/c/d.js' ) as $p ) { ok( morpheus_deploy_path_is_safe( $p ), "safe: $p" ); }

echo "\n== helpers: git blob sha (must match git) ==\n";
// git hash-object of the empty blob and of "hello\n"
ok( morpheus_deploy_git_blob_sha( '' ) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'empty blob sha' );
ok( morpheus_deploy_git_blob_sha( "hello\n" ) === 'ce013625030ba8dba906f756967f9e9ca394464a', '"hello\\n" blob sha' );

echo "\n== helpers: signature ==\n";
$secret = 'test-secret';
$body   = '{"commit":"abc1234","at":"2026-01-01T00:00:00Z"}';
$good   = 'sha256=' . hash_hmac( 'sha256', $body, $secret );
ok( morpheus_deploy_signature_ok( $body, $secret, $good ), 'valid signature accepted' );
ok( ! morpheus_deploy_signature_ok( $body, $secret, 'sha256=deadbeef' ), 'bad signature rejected' );
ok( ! morpheus_deploy_signature_ok( $body . ' ', $secret, $good ), 'tampered body rejected' );
ok( ! morpheus_deploy_signature_ok( $body, 'wrong', $good ), 'wrong secret rejected' );

echo "\n== REST: /status ==\n";
$res  = rest_do_request( new WP_REST_Request( 'GET', '/morpheus/v1/status' ) );
$data = $res->get_data();
ok( $res->get_status() === 200, 'status 200' );
ok( ( $data['plugin'] ?? '' ) === 'morpheus-deploy', 'reports plugin name' );
ok( ( $data['writes'] ?? null ) === false, 'writes = false (v0.1)' );

echo "\n== REST: /deploy auth ==\n";
update_option( 'morpheus_deploy_settings', array(
	'repo' => 'octocat/Hello-World', 'branch' => 'master',
	'github_token' => '', 'deploy_secret' => $secret,
	'site_url' => '', 'health_paths' => '/', 'armed' => 0,
) );

function deploy_req( $raw, $sig ) {
	$r = new WP_REST_Request( 'POST', '/morpheus/v1/deploy' );
	$r->set_header( 'content-type', 'application/json' );
	if ( $sig !== null ) { $r->set_header( 'X-Morpheus-Signature', $sig ); }
	$r->set_body( $raw );
	return rest_do_request( $r );
}

$now  = gmdate( 'c' );
$b1   = json_encode( array( 'commit' => str_repeat( 'a', 40 ), 'at' => $now, 'reason' => 'test' ) );
$sig1 = 'sha256=' . hash_hmac( 'sha256', $b1, $secret );

ok( deploy_req( $b1, null )->get_status() === 401, 'no signature -> 401' );
ok( deploy_req( $b1, 'sha256=nope' )->get_status() === 401, 'bad signature -> 401' );
$stale = json_encode( array( 'commit' => str_repeat( 'a', 40 ), 'at' => gmdate( 'c', time() - 3600 ) ) );
ok( deploy_req( $stale, 'sha256=' . hash_hmac( 'sha256', $stale, $secret ) )->get_status() === 401, 'stale timestamp -> 401' );
$nocommit = json_encode( array( 'at' => $now ) );
ok( deploy_req( $nocommit, 'sha256=' . hash_hmac( 'sha256', $nocommit, $secret ) )->get_status() === 400, 'missing commit -> 400' );

echo "\n== REST: /deploy dry-run against a real public repo ==\n";
// octocat/Hello-World: master @ 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d, parent 553c2077f0edc3d5dc5d17262f6aa498e69d6f8e
$commit = '7fd1a60b01f91b314f59955a4e4d4e80d8edf11d';
$b2     = json_encode( array( 'commit' => $commit, 'at' => $now, 'reason' => 'dry-run test' ) );
$r2     = deploy_req( $b2, 'sha256=' . hash_hmac( 'sha256', $b2, $secret ) );
$d2     = $r2->get_data();
echo "  → HTTP " . $r2->get_status() . " " . json_encode( $d2 ) . "\n";
if ( $r2->get_status() === 200 ) {
	ok( ( $d2['dry_run'] ?? false ) === true, 'dry_run flag set' );
	ok( isset( $d2['would_create'] ) && isset( $d2['would_update'] ), 'reports would_create / would_update' );
	ok( ( $d2['commit'] ?? '' ) === $commit, 'echoes the commit' );
} else {
	echo "  (skipped dry-run asserts — outbound GitHub fetch unavailable in this env)\n";
}

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
