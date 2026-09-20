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
// /status is what the WEBSITE panel reads to decide whether to offer the SEO
// tab and to say who is producing the tags. This boot has Yoast, so the module
// is available and Morpheus is NOT the one emitting.
ok( ( $data['seo']['available'] ?? null ) === true, 'status reports the SEO module available' );
ok( ( $data['seo']['owns_head'] ?? null ) === false, 'status: with Yoast active, Morpheus does not own the head' );
ok( ( $data['seo']['active_plugin'] ?? '' ) === 'yoast', 'status names the active SEO plugin' );
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

// ── Store module ──────────────────────────────────────────────────────────

echo "\n== Store module ==\n";
Morpheus_Store::register_routes();
$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/store'] ), 'route /morpheus/v1/store registered' );

$STORE_SECRET = 'store-secret';
update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), array( 'webhook_secret' => $STORE_SECRET ) ) );

function store_req( $action, $data, $secret ) {
	$raw = json_encode( array( 'action' => $action, 'data' => $data, 'at' => gmdate( 'c' ) ) );
	$r   = new WP_REST_Request( 'POST', '/morpheus/v1/store' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

// auth still enforced
ok( store_req( 'context', array(), 'wrong-secret' )->get_status() === 401, 'bad signature -> 401' );

if ( ! class_exists( 'WooCommerce' ) ) {
	echo "  (WooCommerce not installed in this boot — run tests/run.sh which loads the blueprint; skipping WC asserts)\n";
	$wc = store_req( 'create_product', array( 'name' => 'x' ), $STORE_SECRET );
	ok( $wc->get_status() === 409 && ( $wc->get_data()['error'] ?? '' ) === 'no_woocommerce', 'product action -> 409 no_woocommerce when WC absent' );
} else {
	$ctx = store_req( 'context', array(), $STORE_SECRET )->get_data();
	ok( ! empty( $ctx['ok'] ) && isset( $ctx['currency'] ), 'context returns currency + categories' );
	ok( ( $ctx['default_status'] ?? '' ) === 'draft', 'context default_status is draft' );
	// True whenever a module that can STORE SEO is present: Morpheus's own SEO
	// module (any site — added in 0.5) or, on an older build, Yoast.
	ok( ( $ctx['seo_available'] ?? null ) === true, 'context.seo_available is true (SEO module present)' );

	// create — no status given -> must be a draft
	$create = store_req( 'create_product', array(
		'name'          => '1978 Fender Stratocaster (harness)',
		'description'   => 'Sunburst, original pickups. <strong>Test</strong> product.',
		'regular_price' => '3200',
		'sku'           => 'HARNESS-STRAT-78',
		'stock'         => 1,
		'categories'    => array( 'Instruments' ),
		'brand'         => 'Fender',
	), $STORE_SECRET )->get_data();
	ok( ! empty( $create['ok'] ) && ! empty( $create['created'] ), 'create_product ok' );
	$pid = $create['product']['id'] ?? 0;
	$p   = $pid ? wc_get_product( $pid ) : null;
	ok( $p && $p->get_status() === 'draft', 'new product is a draft (never auto-published)' );
	ok( $p && $p->get_regular_price() === '3200', 'price set' );
	ok( $p && $p->get_sku() === 'HARNESS-STRAT-78', 'sku set' );
	ok( $p && $p->get_manage_stock() && (int) $p->get_stock_quantity() === 1, 'stock managed = 1' );
	ok( $p && in_array( 'Instruments', wp_get_post_terms( $pid, 'product_cat', array( 'fields' => 'names' ) ), true ), 'category assigned (created if new)' );

	// set_stock
	store_req( 'set_stock', array( 'sku' => 'HARNESS-STRAT-78', 'quantity' => 0 ), $STORE_SECRET );
	$p = wc_get_product( $pid );
	ok( (int) $p->get_stock_quantity() === 0 && $p->get_stock_status() === 'outofstock', 'set_stock 0 -> outofstock' );

	// update_product
	store_req( 'update_product', array( 'id' => $pid, 'sale_price' => '2950', 'status' => 'publish' ), $STORE_SECRET );
	$p = wc_get_product( $pid );
	ok( $p->get_sale_price() === '2950' && $p->get_status() === 'publish', 'update_product: sale price + publish' );

	// list_products finds it
	$list = store_req( 'list_products', array( 'search' => 'harness', 'status' => 'publish' ), $STORE_SECRET )->get_data();
	$found = false;
	foreach ( ( $list['products'] ?? array() ) as $lp ) { if ( ( $lp['sku'] ?? '' ) === 'HARNESS-STRAT-78' ) { $found = true; } }
	ok( $found, 'list_products returns the new product' );

	// image sideload on update (real public image)
	$img = store_req( 'update_product', array( 'id' => $pid, 'images' => array( 'https://ps.w.org/woocommerce/assets/icon-128x128.png' ) ), $STORE_SECRET )->get_data();
	$p   = wc_get_product( $pid );
	ok( $p->get_image_id() > 0, 'sideloaded image became the product image' );

	// update_product can unpublish (publish -> draft) without deleting
	store_req( 'update_product', array( 'id' => $pid, 'status' => 'draft' ), $STORE_SECRET );
	$p = wc_get_product( $pid );
	ok( $p->get_status() === 'draft', 'update_product: unpublish (status -> draft)' );

	// get_product returns brand terms for an edit form
	$got = store_req( 'get_product', array( 'id' => $pid ), $STORE_SECRET )->get_data();
	ok( in_array( 'Fender', $got['product']['brands'] ?? array(), true ), 'get_product returns brand terms' );

	// seo_title / seo_description — Yoast's own postmeta when Yoast is
	// active, a safe no-op (empty strings back) otherwise.
	store_req( 'update_product', array( 'id' => $pid, 'seo_title' => 'Vintage Strat — Harness', 'seo_description' => 'A 1978 Fender Stratocaster, sunburst, all original.' ), $STORE_SECRET );
	$seo = store_req( 'get_product', array( 'id' => $pid ), $STORE_SECRET )->get_data();
	if ( defined( 'WPSEO_VERSION' ) ) {
		ok( ( $seo['product']['seo_title'] ?? '' ) === 'Vintage Strat — Harness', 'update_product: seo_title saved (Yoast active)' );
		ok( ( $seo['product']['seo_description'] ?? '' ) === 'A 1978 Fender Stratocaster, sunburst, all original.', 'update_product: seo_description saved' );
	} else {
		ok( ( $seo['product']['seo_title'] ?? 'x' ) === '', 'product seo_title empty when Yoast absent (safe no-op)' );
	}

	// delete_product -> trash (reversible)
	$del = store_req( 'delete_product', array( 'id' => $pid ), $STORE_SECRET )->get_data();
	ok( ! empty( $del['ok'] ) && ! empty( $del['deleted'] ) && empty( $del['permanent'] ), 'delete_product -> trashed' );
	ok( get_post_status( $pid ) === 'trash', 'product is in the trash, not gone' );

	// create_post
	$post = store_req( 'create_post', array( 'title' => 'Back in stock — harness', 'content' => 'We are open again.' ), $STORE_SECRET )->get_data();
	ok( ! empty( $post['ok'] ) && get_post_status( $post['post']['id'] ) === 'draft', 'create_post -> draft' );

	// cleanup
	wp_delete_post( $pid, true );
	wp_delete_post( $post['post']['id'], true );
}

// Page actions need only WordPress core, not WooCommerce — run regardless
// of which boot this is.
$page = store_req( 'create_page', array( 'title' => 'Hours — harness', 'content' => 'Open 9-5 daily.' ), $STORE_SECRET )->get_data();
ok( ! empty( $page['ok'] ) && ! empty( $page['created'] ), 'create_page ok' );
$page_id = $page['page']['id'] ?? 0;
ok( $page_id && get_post_status( $page_id ) === 'draft', 'new page is a draft (never auto-published)' );

$listed = store_req( 'list_pages', array( 'search' => 'harness', 'status' => 'draft' ), $STORE_SECRET )->get_data();
$found_page = false;
foreach ( ( $listed['pages'] ?? array() ) as $lp ) { if ( (int) ( $lp['id'] ?? 0 ) === $page_id ) { $found_page = true; } }
ok( $found_page, 'list_pages finds the new page' );

store_req( 'update_page', array( 'id' => $page_id, 'title' => 'Hours (updated) — harness', 'status' => 'publish' ), $STORE_SECRET );
$got_page = store_req( 'get_page', array( 'id' => $page_id ), $STORE_SECRET )->get_data();
ok( ( $got_page['page']['title'] ?? '' ) === 'Hours (updated) — harness' && ( $got_page['page']['status'] ?? '' ) === 'publish', 'update_page: title + publish' );
ok( ( $got_page['page']['content'] ?? '' ) === 'Open 9-5 daily.', 'get_page returns content' );

store_req( 'update_page', array( 'id' => $page_id, 'seo_title' => 'Store Hours — Harness', 'seo_description' => 'Opening hours for the Valiant Music store.' ), $STORE_SECRET );
$seo_page = store_req( 'get_page', array( 'id' => $page_id ), $STORE_SECRET )->get_data();
if ( defined( 'WPSEO_VERSION' ) ) {
	ok( ( $seo_page['page']['seo_title'] ?? '' ) === 'Store Hours — Harness', 'update_page: seo_title saved (Yoast active)' );
} else {
	ok( ( $seo_page['page']['seo_title'] ?? 'x' ) === '', 'page seo_title empty when Yoast absent (safe no-op)' );
}

$bad_page = store_req( 'get_page', array( 'id' => 999999999 ), $STORE_SECRET );
ok( $bad_page->get_status() === 404, 'get_page 404s on an unknown id' );

// resolve_url — "what page is the operator looking at" for the embed widget
$page_permalink = get_permalink( $page_id );
$resolved = store_req( 'resolve_url', array( 'url' => $page_permalink ), $STORE_SECRET )->get_data();
ok( ! empty( $resolved['resolved'] ) && ( $resolved['kind'] ?? '' ) === 'page' && (int) ( $resolved['id'] ?? 0 ) === $page_id, 'resolve_url finds the page by its real permalink' );
ok( ( $resolved['page']['title'] ?? '' ) === 'Hours (updated) — harness', 'resolve_url enriches with the page summary' );

$resolved_home = store_req( 'resolve_url', array( 'url' => home_url( '/' ) ), $STORE_SECRET )->get_data();
ok( ! empty( $resolved_home['resolved'] ) && ( $resolved_home['kind'] ?? '' ) === 'home', 'resolve_url recognises the homepage' );

$resolved_none = store_req( 'resolve_url', array( 'url' => home_url( '/no-such-page-' . wp_generate_password( 8, false ) . '/' ) ), $STORE_SECRET )->get_data();
ok( empty( $resolved_none['resolved'] ), 'resolve_url reports unresolved for a url that matches nothing' );

$del_page = store_req( 'delete_page', array( 'id' => $page_id ), $STORE_SECRET )->get_data();
ok( ! empty( $del_page['ok'] ) && ! empty( $del_page['deleted'] ) && empty( $del_page['permanent'] ), 'delete_page -> trashed' );
ok( get_post_status( $page_id ) === 'trash', 'page is in the trash, not gone' );

wp_delete_post( $page_id, true );

// ── SEO module ─────────────────────────────────────────────────────────────
//
// The blueprint ships wordpress-seo, so the LIVE path exercised here is
// "another SEO plugin is active" — the one that must NOT emit duplicate tags.
// The other half of the rule (Morpheus emitting the tags itself when NO SEO
// plugin is installed) needs a WordPress with no Yoast in it at all, so it
// lives in tests/harness-noyoast.php on tests/blueprint-noyoast.json —
// run.sh boots both.

echo "\n-- SEO --\n";

$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/seo'] ), 'route /morpheus/v1/seo registered' );

function seo_req( $action, $data, $secret ) {
	$raw = json_encode( array( 'action' => $action, 'data' => $data, 'at' => gmdate( 'c' ) ) );
	$r   = new WP_REST_Request( 'POST', '/morpheus/v1/seo' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

ok( seo_req( 'context', array(), 'wrong-secret' )->get_status() === 401, 'seo: bad signature -> 401' );
ok( seo_req( 'nonsense', array(), $STORE_SECRET )->get_status() === 400, 'seo: unknown action -> 400' );

$seo_ctx = seo_req( 'context', array(), $STORE_SECRET )->get_data();
ok( ! empty( $seo_ctx['ok'] ), 'seo: context ok' );
ok( isset( $seo_ctx['active_plugin'] ) && isset( $seo_ctx['owns_head'] ), 'seo: context reports who owns the head' );
// THE DUPLICATE-TAG RULE: with Yoast active Morpheus must not emit.
ok( $seo_ctx['owns_head'] === false, 'seo: Morpheus does NOT own the head while Yoast is active (no duplicate tags)' );
ok( $seo_ctx['active_plugin'] === 'yoast', 'seo: context names Yoast as the active plugin' );
ok( ! empty( $seo_ctx['sitemap_url'] ), 'seo: context exposes the sitemap url' );

// The head must carry no Morpheus-emitted tags while Yoast is active.
ob_start();
do_action( 'wp_head' );
$head_no_yoast = ob_get_clean();
ok( Morpheus_SEO::owns_head() === false, 'seo: owns_head() false with Yoast present' );

// set/get round-trips through Yoast's own keys, so the widget drives the plugin
// that is actually producing the tags rather than writing orphaned data.
$seo_target = wp_insert_post( array(
	'post_title'   => 'SEO harness target',
	'post_content' => str_repeat( 'Some real content for the audit to measure. ', 60 ),
	'post_status'  => 'publish',
	'post_type'    => 'page',
) );
$set = seo_req( 'set_seo', array(
	'id'              => $seo_target,
	'seo_title'       => 'Harness SEO Title',
	'seo_description' => 'A description written by the harness to prove the round trip works end to end.',
	'focus_keyword'   => 'harness',
), $STORE_SECRET )->get_data();
ok( ! empty( $set['ok'] ) && ( $set['item']['seo_title'] ?? '' ) === 'Harness SEO Title', 'seo: set_seo returns the stored values' );
ok( get_post_meta( $seo_target, '_yoast_wpseo_title', true ) === 'Harness SEO Title', 'seo: title written to YOAST\'s key, not a private one' );
ok( get_post_meta( $seo_target, '_yoast_wpseo_metadesc', true ) !== '', 'seo: description written to Yoast\'s key' );

$got = seo_req( 'get_seo', array( 'id' => $seo_target ), $STORE_SECRET )->get_data();
ok( ( $got['item']['seo_title'] ?? '' ) === 'Harness SEO Title', 'seo: get_seo reads it back' );
ok( ( $got['item']['source'] ?? '' ) === 'yoast', 'seo: item reports Yoast as the source' );

// Site-wide templates are stored on a Yoast site, but they must NOT be reported
// as the effective value — Yoast's own templates decide what goes out, so
// claiming ours would tell the operator something false about their live site.
seo_req( 'set_defaults', array( 'defaults' => array( 'enabled' => true, 'title' => 'TEMPLATED %title% | %sitename%' ) ), $STORE_SECRET );
$tpl_stored = seo_req( 'get_defaults', array(), $STORE_SECRET )->get_data();
ok( ( $tpl_stored['defaults']['title'] ?? '' ) === 'TEMPLATED %title% | %sitename%', 'seo: templates save on a Yoast site' );
$bare_yoast = wp_insert_post( array( 'post_title' => 'Bare with Yoast', 'post_content' => 'Body text that is long enough to be a description in its own right, honestly.', 'post_status' => 'publish', 'post_type' => 'page' ) );
$bf = seo_req( 'get_seo', array( 'id' => $bare_yoast ), $STORE_SECRET )->get_data();
ok( ( $bf['item']['effective_title'] ?? '' ) === 'Bare with Yoast', 'seo: with Yoast active, the effective title stays the derived one (our template is NOT claimed)' );
ok( ( $bf['item']['inherited_title'] ?? true ) === false, 'seo: with Yoast active, nothing is reported as inherited from us' );

// The explicit path still works there: apply the template into items that have
// nothing set (this is what makes templates useful on a Yoast site).
$dry = seo_req( 'bulk_apply_defaults', array( 'dry_run' => true, 'limit' => 10 ), $STORE_SECRET )->get_data();
$dry_ids = array_column( $dry['preview'] ?? array(), 'id' );
ok( in_array( $bare_yoast, $dry_ids, true ), 'seo: bulk_apply_defaults dry-run lists an item with nothing set' );
ok( ( $dry['count'] ?? -1 ) === 0, 'seo: a dry run writes nothing' );
ok( get_post_meta( $bare_yoast, '_yoast_wpseo_title', true ) === '' , 'seo: a dry run leaves the item alone' );

$applied = seo_req( 'bulk_apply_defaults', array( 'limit' => 10 ), $STORE_SECRET )->get_data();
ok( ( $applied['count'] ?? 0 ) >= 1, 'seo: bulk_apply_defaults writes' );
$after = seo_req( 'get_seo', array( 'id' => $bare_yoast ), $STORE_SECRET )->get_data();
ok( ( $after['item']['seo_title'] ?? '' ) === 'TEMPLATED Bare with Yoast | ' . get_bloginfo( 'name' ), 'seo: the applied value went into YOAST\'s key with the tokens resolved' );
ok( get_post_meta( $seo_target, '_yoast_wpseo_title', true ) === 'Harness SEO Title', 'seo: an item that already had a title was NOT overwritten' );
wp_delete_post( $bare_yoast, true );
delete_option( 'morpheus_seo_defaults' );

// An item with NO meta description must be flagged — this is the whole point
// of the audit, so it is asserted against a deliberately bare post.
$bare = wp_insert_post( array(
	'post_title'   => 'Bare harness post',
	'post_content' => 'Short.',
	'post_status'  => 'publish',
	'post_type'    => 'post',
) );
$audit = seo_req( 'audit', array( 'limit' => 50 ), $STORE_SECRET )->get_data();
ok( ! empty( $audit['ok'] ) && isset( $audit['issues'] ), 'seo: audit returns issues + counts' );
$codes = array_column( $audit['issues'], 'code' );
ok( in_array( 'missing_description', $codes, true ), 'seo: audit flags a missing meta description' );

$list = seo_req( 'list_content', array( 'limit' => 20 ), $STORE_SECRET )->get_data();
ok( ! empty( $list['ok'] ) && isset( $list['items'] ), 'seo: list_content returns items' );
// A listing must stay small — the bodies belong to read_content, so the
// generated-fields pass asks for them one item at a time.
ok( ! isset( $list['items'][0]['content_text'] ), 'seo: list_content does NOT ship post bodies' );

// read_content — the grounding an AI pass needs to WRITE a title/description.
$read = seo_req( 'read_content', array( 'id' => $seo_target, 'chars' => 400 ), $STORE_SECRET )->get_data();
ok( ( $read['item']['title'] ?? '' ) === 'SEO harness target', 'seo: read_content returns the title' );
ok( mb_strlen( $read['item']['content_text'] ?? '' ) === 400, 'seo: read_content trims content_text to the requested chars' );
ok( ( $read['item']['truncated'] ?? false ) === true && ( $read['item']['word_count'] ?? 0 ) > 0, 'seo: read_content reports truncation + word count' );
ok( seo_req( 'read_content', array( 'id' => 99999999 ), $STORE_SECRET )->get_status() === 404, 'seo: read_content 404s on an unknown id' );

$rich = wp_insert_post( array(
	'post_title'   => 'Markup harness target',
	'post_content' => '<h2>Heading</h2><p>Body text here.</p>[gallery ids="1,2"]',
	'post_status'  => 'publish',
	'post_type'    => 'page',
) );
$rich_read = seo_req( 'read_content', array( 'id' => $rich ), $STORE_SECRET )->get_data();
$rich_text = (string) ( $rich_read['item']['content_text'] ?? '' );
ok( $rich_text !== '' && strpos( $rich_text, '<' ) === false, 'seo: read_content strips markup' );
ok( strpos( $rich_text, 'gallery' ) === false, 'seo: read_content strips shortcodes' );
// Block tags must leave a SEPARATOR. Stripping them bare glues the last word of
// one block to the first of the next ("properlyWe repair…"), which is the kind
// of mangled grounding that makes a generator write about the wrong thing.
ok( strpos( $rich_text, 'Heading Body' ) !== false && strpos( $rich_text, 'HeadingBody' ) === false, 'seo: read_content separates adjacent blocks' );
wp_delete_post( $rich, true );

// bulk_set_seo applies many and reports per-item failures rather than aborting.
$bulk = seo_req( 'bulk_set_seo', array( 'items' => array(
	array( 'id' => $bare, 'seo_title' => 'Bulk title', 'seo_description' => 'Bulk description.' ),
	array( 'id' => 99999999, 'seo_title' => 'nope' ),
) ), $STORE_SECRET )->get_data();
ok( ( $bulk['count'] ?? 0 ) === 1, 'seo: bulk_set_seo applied exactly one item' );
ok( count( $bulk['failed'] ?? array() ) === 1, 'seo: bulk_set_seo reports the bad id instead of aborting' );

// The no-plugin path is a pure decision — assert the keys directly, since the
// test site has Yoast and cannot be un-loaded mid-run.
$own = Morpheus_SEO::keys_for( null );
ok( $own['title'] === '_morpheus_seo_title', 'seo: with NO plugin, Morpheus uses its own title key' );
ok( $own['desc'] === '_morpheus_seo_description', 'seo: with NO plugin, Morpheus uses its own description key' );
$rank = Morpheus_SEO::keys_for( 'rankmath' );
ok( $rank['title'] === 'rank_math_title', 'seo: Rank Math keys are mapped, so it can be driven too' );

wp_delete_post( $seo_target, true );
wp_delete_post( $bare, true );

// ── one-click plugin updates ───────────────────────────────────────────────
//
// The update channel is what stops every user having to re-upload a zip. The
// manifest is supplied as a fixture (the plugin's own filter is the seam)
// rather than reaching the real morpheus.nz, so this tests OUR logic — the
// version comparison, the shape WordPress needs, and above all the refusal when
// a downloaded package does not match its published hash.

echo "\n-- one-click updates --\n";

define( 'MORPHEUS_TEST_MANIFEST', 'morpheus_test_manifest' );
$fixture = new stdClass();
$GLOBALS[ MORPHEUS_TEST_MANIFEST ] = null;
add_filter( 'morpheus_update_manifest_url', function () { return 'https://morpheus.test/plugin-manifest.json'; } );
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	if ( strpos( $url, 'morpheus.test' ) === false ) { return $pre; }
	$body = $GLOBALS[ MORPHEUS_TEST_MANIFEST ];
	if ( ! $body ) { return new WP_Error( 'no_fixture', 'no manifest fixture set' ); }
	return array( 'headers' => array(), 'body' => json_encode( $body ), 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 10, 3 );

$manifest_with = function ( $version, $sha = 'deadbeef' ) {
	$GLOBALS[ MORPHEUS_TEST_MANIFEST ] = array(
		'version'      => $version,
		'sha256'       => $sha,
		'url'          => 'https://morpheus.nz/morpheus-wordpress-plugin.zip',
		'requires'     => '6.0',
		'requires_php' => '7.4',
	);
	delete_transient( Morpheus_Updates::CACHE_KEY );
};

$basename = Morpheus_Updates::basename();
ok( $basename === 'morpheus/morpheus.php', 'updates: the plugin basename is recognised' );
ok( Morpheus_Updates::is_newer( '0.5.4', '0.5.3' ) === true, 'updates: 0.5.4 is newer than 0.5.3' );
ok( Morpheus_Updates::is_newer( '0.5.3', '0.5.3' ) === false, 'updates: the same version is not an update' );
ok( Morpheus_Updates::is_newer( '0.4.9', '0.5.3' ) === false, 'updates: an older version is not an update' );
ok( Morpheus_Updates::is_newer( '0.5.10', '0.5.9' ) === true, 'updates: version_compare handles double digits' );

// Nothing newer -> WordPress is left exactly as it was.
$manifest_with( MORPHEUS_VERSION );
$t = new stdClass();
$t->response = array();
$out = Morpheus_Updates::offer_update( $t );
ok( ! isset( $out->response[ $basename ] ), 'updates: no offer when the running version is current' );

// Newer -> the offer WordPress needs, with the package and its hash.
$manifest_with( '9.9.9', str_repeat( 'a', 64 ) );
$t2 = new stdClass();
$t2->response = array( 'other/other.php' => (object) array( 'new_version' => '1.0' ) );
$t2->no_update = array( $basename => (object) array( 'new_version' => MORPHEUS_VERSION ) );
$out2 = Morpheus_Updates::offer_update( $t2 );
ok( isset( $out2->response[ $basename ] ), 'updates: a newer manifest is offered to WordPress' );
ok( ( $out2->response[ $basename ]->new_version ?? '' ) === '9.9.9', 'updates: the offered version is the manifest\'s' );
ok( ( $out2->response[ $basename ]->package ?? '' ) === 'https://morpheus.nz/morpheus-wordpress-plugin.zip', 'updates: the offered package is the manifest URL' );
ok( ( $out2->response[ $basename ]->slug ?? '' ) === 'morpheus', 'updates: the slug WordPress matches on' );
ok( ! isset( $out2->no_update[ $basename ] ), 'updates: the stale no_update entry is cleared (or the update is hidden)' );
ok( isset( $out2->response['other/other.php'] ), 'updates: another plugin\'s update entry is untouched' );

// A manifest that is missing or unreachable must never invent an update.
$GLOBALS[ MORPHEUS_TEST_MANIFEST ] = null;
delete_transient( Morpheus_Updates::CACHE_KEY );
$t3 = new stdClass();
$t3->response = array();
ok( ! isset( Morpheus_Updates::offer_update( $t3 )->response[ $basename ] ), 'updates: an unreachable manifest offers nothing' );

// The details modal.
$manifest_with( '9.9.9' );
$info = Morpheus_Updates::plugin_info( null, 'plugin_information', (object) array( 'slug' => 'morpheus' ) );
ok( ( $info->version ?? '' ) === '9.9.9' && ( $info->download_link ?? '' ) !== '', 'updates: the details modal names the version and package' );
ok( Morpheus_Updates::plugin_info( 'untouched', 'plugin_information', (object) array( 'slug' => 'someone-else' ) ) === 'untouched', 'updates: another plugin\'s details are untouched' );

// THE REFUSAL THAT MATTERS: a package whose bytes do not match the published
// hash must never reach the upgrader.
$tmp_zip = trailingslashit( get_temp_dir() ) . 'morpheus-test-package.zip';
file_put_contents( $tmp_zip, 'not the real plugin, just some bytes' );
$real_sha = hash_file( 'sha256', $tmp_zip );

$tmp_glob = trailingslashit( get_temp_dir() ) . '*morpheus*';
$count_tmp = function () use ( $tmp_glob ) { return count( glob( $tmp_glob ) ?: array() ); };

$manifest_with( '9.9.9', str_repeat( 'b', 64 ) ); // a hash that is NOT this file
$upgrader = new stdClass();
$upgrader->skin = new stdClass();
$before_refusal = $count_tmp();
$refused = Morpheus_Updates::verify_download( false, 'https://morpheus.nz/morpheus-wordpress-plugin.zip', $upgrader );
ok( is_wp_error( $refused ), 'updates: a package whose hash does not match is REFUSED' );
ok( strpos( $refused->get_error_message(), 'checksum' ) !== false, 'updates: the refusal explains itself' );
ok( $count_tmp() === $before_refusal, 'updates: the refused download is deleted, not left on disk' );

// NO HASH IS NOT "NO PROBLEM": a package that cannot be verified is refused.
// This replaced a fall-through to WordPress's own download, which meant that
// anything able to stop the plugin reading the manifest (a blocked request, a
// DNS failure, a tampered mirror) downgraded the site to installing an
// unchecked package.
$manifest_with( '9.9.9', '' );
$unverifiable = Morpheus_Updates::verify_download( false, 'https://morpheus.nz/morpheus-wordpress-plugin.zip', $upgrader );
ok( is_wp_error( $unverifiable ), 'updates: a package with no published checksum is REFUSED' );
ok( strpos( $unverifiable->get_error_message(), 'could not be verified' ) !== false, 'updates: that refusal tells the operator how to recover' );

// Someone else's package is never intercepted.
$manifest_with( '9.9.9', $real_sha );
$other = Morpheus_Updates::verify_download( false, 'https://downloads.wordpress.org/plugin/akismet.zip', $upgrader );
ok( $other === false, 'updates: another plugin\'s download is left alone' );

// And the real path: matching hash -> the file is handed to WordPress.
// NOTE: download_url() asks for a STREAMED download ('stream' => true with a
// 'filename'), and the real transport writes the body to that file. A
// short-circuiting filter has to do the same or it is not testing the same
// thing — the first version of this stub returned the bytes without writing
// them, so the "downloaded" file was empty and the hash could never match.
add_filter( 'pre_http_request', function ( $pre, $args, $url ) use ( $tmp_zip ) {
	if ( strpos( $url, 'morpheus-wordpress-plugin.zip' ) === false ) { return $pre; }
	$body = file_get_contents( $tmp_zip );
	if ( ! empty( $args['filename'] ) ) {
		file_put_contents( $args['filename'], $body );
	}
	return array( 'headers' => array(), 'body' => $body, 'response' => array( 'code' => 200, 'message' => 'OK' ), 'cookies' => array(), 'filename' => null );
}, 10, 3 );
$manifest_with( '9.9.9', $real_sha );
$verified = Morpheus_Updates::verify_download( false, 'https://morpheus.nz/morpheus-wordpress-plugin.zip', $upgrader );
ok( is_string( $verified ) && file_exists( $verified ), 'updates: a matching hash hands the verified file to the upgrader' );
ok( is_string( $verified ) && hash_file( 'sha256', $verified ) === $real_sha, 'updates: the handed-over file is the verified one' );
if ( is_string( $verified ) ) { @unlink( $verified ); }
@unlink( $tmp_zip );
delete_transient( Morpheus_Updates::CACHE_KEY );

delete_option( 'morpheus_settings' );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
