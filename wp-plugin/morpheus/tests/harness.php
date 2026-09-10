<?php
/**
 * Integration + unit test harness for the Morpheus plugin. Run inside a
 * WordPress Playground boot with the plugin mounted + active:
 *
 *   wp-playground-cli php \
 *     --auto-mount ./wp-plugin/morpheus \
 *     --mount ./wp-plugin/morpheus/tests:/tests \
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
ok( function_exists( 'morpheus_is_denied' ), 'helpers loaded' );
ok( class_exists( 'Morpheus_REST' ), 'REST class loaded' );
ok( class_exists( 'Morpheus_Deploy' ), 'Deployer class loaded' );

// Force route registration (rest_api_init may not have fired in CLI context).
if ( class_exists( 'Morpheus_REST' ) ) {
	Morpheus_REST::register_routes();
}
$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/deploy'] ), 'route /morpheus/v1/deploy registered' );
ok( isset( $routes['/morpheus/v1/status'] ), 'route /morpheus/v1/status registered' );

echo "\n== helpers: deny-list ==\n";
$denied = array( 'wp-config.php', 'a/wp-config.php', 'wp-content/uploads/2024/x.jpg', '.htaccess', '.env.production', 'x/.git/config', '.user.ini', 'wp-content/cache/x.php' );
foreach ( $denied as $p ) { ok( morpheus_is_denied( $p ), "denied: $p" ); }
$allowed = array( 'index.php', 'wp-content/themes/woodmart-child/style.css', 'wp-content/plugins/x/x.php', 'wp-content/mu-plugins/y.php' );
foreach ( $allowed as $p ) { ok( ! morpheus_is_denied( $p ), "allowed: $p" ); }

echo "\n== helpers: path safety ==\n";
foreach ( array( '../x', '/abs', 'a/../b', "a\0b", 'a\\b', '.', 'a/./b' ) as $p ) { ok( ! morpheus_path_is_safe( $p ), "unsafe: " . json_encode( $p ) ); }
foreach ( array( 'wp-content/themes/x/a.php', 'index.php', 'a/b/c/d.js' ) as $p ) { ok( morpheus_path_is_safe( $p ), "safe: $p" ); }

echo "\n== helpers: git blob sha (must match git) ==\n";
// git hash-object of the empty blob and of "hello\n"
ok( morpheus_git_blob_sha( '' ) === 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391', 'empty blob sha' );
ok( morpheus_git_blob_sha( "hello\n" ) === 'ce013625030ba8dba906f756967f9e9ca394464a', '"hello\\n" blob sha' );

echo "\n== helpers: signature ==\n";
$secret = 'test-secret';
$body   = '{"commit":"abc1234","at":"2026-01-01T00:00:00Z"}';
$good   = 'sha256=' . hash_hmac( 'sha256', $body, $secret );
ok( morpheus_signature_ok( $body, $secret, $good ), 'valid signature accepted' );
ok( ! morpheus_signature_ok( $body, $secret, 'sha256=deadbeef' ), 'bad signature rejected' );
ok( ! morpheus_signature_ok( $body . ' ', $secret, $good ), 'tampered body rejected' );
ok( ! morpheus_signature_ok( $body, 'wrong', $good ), 'wrong secret rejected' );

echo "\n== REST: /status ==\n";
$res  = rest_do_request( new WP_REST_Request( 'GET', '/morpheus/v1/status' ) );
$data = $res->get_data();
ok( $res->get_status() === 200, 'status 200' );
ok( ( $data['plugin'] ?? '' ) === 'morpheus', 'reports plugin name' );
ok( ( $data['writes'] ?? null ) === false, 'writes = false when not armed' );
update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), array( 'armed' => 1 ) ) );
$armed = rest_do_request( new WP_REST_Request( 'GET', '/morpheus/v1/status' ) )->get_data();
ok( ( $armed['writes'] ?? null ) === true && ( $armed['armed'] ?? null ) === true, 'writes = true when armed' );
delete_option( 'morpheus_settings' );

echo "\n== REST: /deploy auth ==\n";
update_option( 'morpheus_settings', array(
	'repo' => 'octocat/Hello-World', 'branch' => 'master',
	'github_token' => '', 'webhook_secret' => $secret,
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

// ── v0.2: the armed write path ─────────────────────────────────────────────
//
// A fake GitHub client feeds a canned change set + file contents so the
// deploy can be driven against a scratch site root and every write / delete
// / snapshot / rollback asserted.

class Fake_GitHub {
	public $commit_sha;
	public $files;    // path => content  (the state at $commit_sha)
	public $changes;  // [ { path, status, sha } ]
	public $override_content = array(); // path => raw bytes to return instead (corruption test)

	public function commit( $sha ) { return array( 'parents' => array( array( 'sha' => 'PARENT' ) ) ); }
	public function compare( $base, $head ) { return $this->changes; }
	public function file( $rel, $ref ) {
		if ( array_key_exists( $rel, $this->override_content ) ) { return $this->override_content[ $rel ]; }
		if ( array_key_exists( $rel, $this->files ) ) { return $this->files[ $rel ]; }
		return new WP_Error( 'not_found', "no fake content for $rel" );
	}
}

function blob( $c ) { return morpheus_git_blob_sha( $c ); }
function mkroot() {
	$d = sys_get_temp_dir() . '/md-' . substr( md5( microtime() . mt_rand() ), 0, 10 );
	mkdir( $d, 0777, true );
	return $d;
}
function seed( $root, array $files ) {
	foreach ( $files as $rel => $content ) {
		$full = $root . '/' . $rel;
		@mkdir( dirname( $full ), 0777, true );
		file_put_contents( $full, $content );
	}
}
function rmrf( $d ) {
	if ( ! is_dir( $d ) ) { return; }
	foreach ( new RecursiveIteratorIterator( new RecursiveDirectoryIterator( $d, FilesystemIterator::SKIP_DOTS ), RecursiveIteratorIterator::CHILD_FIRST ) as $f ) {
		$f->isDir() ? @rmdir( $f->getPathname() ) : @unlink( $f->getPathname() );
	}
	@rmdir( $d );
}

$SETTINGS = array( 'repo' => 'acme/site', 'branch' => 'main', 'github_token' => '', 'webhook_secret' => 't', 'site_url' => '', 'health_paths' => '', 'armed' => 1 );

echo "\n== deploy: happy path ==\n";
$root = mkroot();
seed( $root, array(
	'wp-content/themes/t/style.css' => "old css\n",
	'old.txt'                       => "delete me\n",
	'wp-config.php'                 => "SECRET\n",
) );
$fg = new Fake_GitHub();
$fg->files = array(
	'content/home.json'            => '{"title":"Hi"}',
	'wp-content/themes/t/style.css'=> "new css\n",
	'wp-config.php'                => "HACKED\n",
);
$fg->changes = array(
	array( 'path' => 'content/home.json',             'status' => 'added',    'sha' => blob( '{"title":"Hi"}' ) ),
	array( 'path' => 'wp-content/themes/t/style.css', 'status' => 'modified', 'sha' => blob( "new css\n" ) ),
	array( 'path' => 'wp-config.php',                 'status' => 'modified', 'sha' => blob( "HACKED\n" ) ),
	array( 'path' => 'old.txt',                       'status' => 'removed',  'sha' => null ),
);
$healthy_url = home_url(); // the running Playground WP — a real 200
$d  = new Morpheus_Deploy( array_merge( $SETTINGS, array( 'site_url' => $healthy_url ) ), $root, $fg );
$r  = $d->deploy( 'C0MM1T', 'happy' );
ok( is_array( $r ) && ! empty( $r['deployed'] ), 'deployed: true' );
ok( empty( $r['rolled_back'] ), 'not rolled back' );
ok( file_get_contents( "$root/content/home.json" ) === '{"title":"Hi"}', 'new file written' );
ok( file_get_contents( "$root/wp-content/themes/t/style.css" ) === "new css\n", 'changed file updated' );
ok( ! file_exists( "$root/old.txt" ), 'removed file deleted' );
ok( file_get_contents( "$root/wp-config.php" ) === "SECRET\n", 'DENIED wp-config.php untouched' );
ok( in_array( 'wp-config.php', $r['skipped_denied'], true ), 'wp-config.php reported as skipped_denied' );
$snap = glob( MORPHEUS_STATE_DIR . '/snapshots/*/manifest.json' );
ok( ! empty( $snap ), 'a snapshot manifest was written' );

echo "\n== deploy: unsafe path -> abort, nothing written ==\n";
$root2 = mkroot();
seed( $root2, array( 'keep.txt' => "keep\n" ) );
$fg2 = new Fake_GitHub();
$fg2->files = array( 'a.txt' => 'a', '../evil' => 'x' );
$fg2->changes = array(
	array( 'path' => 'a.txt',    'status' => 'added', 'sha' => blob( 'a' ) ),
	array( 'path' => '../evil',  'status' => 'added', 'sha' => blob( 'x' ) ),
);
$r2 = ( new Morpheus_Deploy( $SETTINGS, $root2, $fg2 ) )->deploy( 'C', '' );
ok( is_wp_error( $r2 ) && $r2->get_error_code() === 'unsafe_paths', 'unsafe path aborts with unsafe_paths' );
ok( ! file_exists( "$root2/a.txt" ), 'safe sibling file not written on abort' );

echo "\n== deploy: health check fails -> rollback ==\n";
$root3 = mkroot();
seed( $root3, array( 'app/config.js' => "v1\n", 'app/keep.js' => "keep\n" ) );
$fg3 = new Fake_GitHub();
$fg3->files = array( 'app/config.js' => "v2-broken\n", 'app/new.js' => "new\n" );
$fg3->changes = array(
	array( 'path' => 'app/config.js', 'status' => 'modified', 'sha' => blob( "v2-broken\n" ) ),
	array( 'path' => 'app/new.js',    'status' => 'added',    'sha' => blob( "new\n" ) ),
);
// point the health check at a host that won't resolve -> wp_remote_get errors -> unhealthy
$r3 = ( new Morpheus_Deploy( array_merge( $SETTINGS, array( 'site_url' => 'http://127.0.0.1:59999' ) ), $root3, $fg3 ) )->deploy( 'C', 'breaks' );
ok( is_array( $r3 ) && ! empty( $r3['rolled_back'] ), 'rolled_back: true on failed health check' );
ok( empty( $r3['deployed'] ), 'deployed: false' );
ok( file_get_contents( "$root3/app/config.js" ) === "v1\n", 'changed file restored to pre-deploy content' );
ok( ! file_exists( "$root3/app/new.js" ), 'newly-created file removed on rollback' );
ok( file_get_contents( "$root3/app/keep.js" ) === "keep\n", 'untouched file left alone' );

echo "\n== deploy: blob-sha mismatch -> rollback ==\n";
$root4 = mkroot();
seed( $root4, array( 'x.js' => "orig\n" ) );
$fg4 = new Fake_GitHub();
$fg4->files   = array( 'x.js' => "expected\n" );
$fg4->changes = array( array( 'path' => 'x.js', 'status' => 'modified', 'sha' => blob( "expected\n" ) ) );
$fg4->override_content = array( 'x.js' => "CORRUPTED IN TRANSIT\n" ); // != the declared sha
$r4 = ( new Morpheus_Deploy( array_merge( $SETTINGS, array( 'site_url' => $healthy_url ) ), $root4, $fg4 ) )->deploy( 'C', '' );
ok( is_array( $r4 ) && ! empty( $r4['rolled_back'] ), 'sha mismatch triggers rollback' );
ok( file_get_contents( "$root4/x.js" ) === "orig\n", 'file restored after sha-mismatch rollback' );

echo "\n== rollback_last() ==\n";
$root5 = mkroot();
seed( $root5, array( 'a.txt' => "one\n" ) );
$fg5 = new Fake_GitHub();
$fg5->files = array( 'a.txt' => "two\n", 'b.txt' => "b\n" );
$fg5->changes = array(
	array( 'path' => 'a.txt', 'status' => 'modified', 'sha' => blob( "two\n" ) ),
	array( 'path' => 'b.txt', 'status' => 'added',    'sha' => blob( "b\n" ) ),
);
$dep5 = new Morpheus_Deploy( array_merge( $SETTINGS, array( 'site_url' => $healthy_url ) ), $root5, $fg5 );
$ok5  = $dep5->deploy( 'C', 'to-undo' );
ok( ! empty( $ok5['deployed'] ) && file_get_contents( "$root5/a.txt" ) === "two\n", 'deploy landed before undo' );
$undo = $dep5->rollback_last();
ok( is_array( $undo ), 'rollback_last returned a result' );
ok( file_get_contents( "$root5/a.txt" ) === "one\n", 'rollback_last restored a.txt' );
ok( ! file_exists( "$root5/b.txt" ), 'rollback_last removed the created file' );

echo "\n== deploy: not armed -> report only ==\n";
$root6 = mkroot();
seed( $root6, array( 'z.txt' => "z\n" ) );
$fg6 = new Fake_GitHub();
$fg6->files = array( 'z.txt' => "changed\n" );
$fg6->changes = array( array( 'path' => 'z.txt', 'status' => 'modified', 'sha' => blob( "changed\n" ) ) );
$r6 = ( new Morpheus_Deploy( array_merge( $SETTINGS, array( 'armed' => 0 ) ), $root6, $fg6 ) )->dry_run( 'C', '' );
ok( ( $r6['dry_run'] ?? false ) === true && file_get_contents( "$root6/z.txt" ) === "z\n", 'dry_run leaves files alone' );

foreach ( array( $root, $root2, $root3, $root4, $root5, $root6 ) as $r ) { rmrf( $r ); }
rmrf( MORPHEUS_STATE_DIR . '/snapshots' );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
