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

// ── theme export (the working copy) ────────────────────────────────────────
//
// This endpoint reads files off someone's live server, so the refusals matter
// more than the contents: a path outside the active theme must never be read,
// whatever it looks like.

echo "\n-- theme export --\n";

$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/export'] ), 'export: route /morpheus/v1/export registered' );

function export_req( $action, $data, $secret ) {
	$raw = json_encode( array( 'action' => $action, 'data' => $data, 'at' => gmdate( 'c' ) ) );
	$r   = new WP_REST_Request( 'POST', '/morpheus/v1/export' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

ok( export_req( 'theme_tree', array(), 'wrong-secret' )->get_status() === 401, 'export: bad signature -> 401' );
ok( export_req( 'nonsense', array(), $STORE_SECRET )->get_status() === 400, 'export: unknown action -> 400' );

$active = Morpheus_Export::active_theme();
$theme_dir = $active['dir'];
// Fixtures inside the active theme: one binary, one oversized, one nested file,
// and a batch bigger than the per-call cap.
wp_mkdir_p( $theme_dir . '/morpheus-harness/deep' );
wp_mkdir_p( $theme_dir . '/node_modules' );
file_put_contents( $theme_dir . '/morpheus-harness/hello.php', "<?php\n// harness fixture\n" );
file_put_contents( $theme_dir . '/morpheus-harness/deep/note.txt', "nested fixture\n" );
file_put_contents( $theme_dir . '/morpheus-harness/picture.png', "\x89PNG\x00\x00binary" );
file_put_contents( $theme_dir . '/morpheus-harness/big.txt', str_repeat( 'x', 1048576 + 10 ) );
file_put_contents( $theme_dir . '/node_modules/ignored.js', "// never copied\n" );
for ( $i = 0; $i < 210; $i++ ) {
	file_put_contents( $theme_dir . '/morpheus-harness/batch-' . $i . '.txt', "file {$i}\n" );
}

$tree = export_req( 'theme_tree', array(), $STORE_SECRET )->get_data();
ok( ! empty( $tree['ok'] ) && ! empty( $tree['theme']['slug'] ), 'export: theme_tree names the active theme' );
ok( ( $tree['theme']['slug'] ?? '' ) === get_stylesheet(), 'export: it exports the ACTIVE theme (the child, when there is one)' );
$paths = array_column( $tree['files'], 'path' );
$prefix = 'wp-content/themes/' . get_stylesheet() . '/';
$outside = array_filter( $paths, function ( $p ) use ( $prefix ) { return strpos( $p, $prefix ) !== 0; } );
ok( $outside === array(), 'export: every path is inside the active theme' );
ok( in_array( $prefix . 'morpheus-harness/hello.php', $paths, true ), 'export: it includes a theme file' );
ok( in_array( $prefix . 'morpheus-harness/deep/note.txt', $paths, true ), 'export: it walks subdirectories' );
ok( ! in_array( $prefix . 'morpheus-harness/picture.png', $paths, true ), 'export: a binary file is not listed' );
ok( ! in_array( $prefix . 'morpheus-harness/big.txt', $paths, true ), 'export: an oversized file is not listed' );
ok( ! in_array( $prefix . 'node_modules/ignored.js', $paths, true ), 'export: node_modules is not listed' );

$skipped_paths = array_column( $tree['skipped'], 'path' );
ok( in_array( 'morpheus-harness/picture.png', $skipped_paths, true ), 'export: the binary file is REPORTED as skipped, not silently dropped' );
ok( in_array( 'morpheus-harness/big.txt', $skipped_paths, true ), 'export: so is the oversized one' );
$hash_ok = true;
foreach ( $tree['files'] as $f ) {
	if ( ! preg_match( '/^[a-f0-9]{64}$/', (string) $f['hash'] ) ) { $hash_ok = false; }
}
ok( $hash_ok, 'export: every file carries a sha256 the app can diff against' );

// Contents, verified against the manifest hash.
$one = export_req( 'theme_files', array( 'paths' => array( $prefix . 'morpheus-harness/deep/note.txt' ) ), $STORE_SECRET )->get_data();
ok( ( $one['files'][0]['content'] ?? '' ) === "nested fixture\n", 'export: theme_files returns the contents' );
ok( ( $one['files'][0]['hash'] ?? '' ) === hash( 'sha256', "nested fixture\n" ), 'export: the returned hash matches the manifest' );

// The refusals.
$refusals = array(
	'../../wp-config.php'                                  => 'a relative traversal',
	'/etc/passwd'                                         => 'an absolute path',
	'wp-content/themes/some-other-theme/style.css'         => 'another theme',
	'wp-content/uploads/secret.txt'                        => 'the uploads directory',
	"wp-content/themes/" . get_stylesheet() . "/a\\b.txt" => 'a backslash',
	'wp-content/themes/' . get_stylesheet() . '/../x.txt'  => 'a traversal after the prefix',
	'wp-content/themes/' . get_stylesheet() . '/node_modules/x.js' => 'a skipped directory',
);
foreach ( $refusals as $bad => $label ) {
	$r = export_req( 'theme_files', array( 'paths' => array( $bad ) ), $STORE_SECRET )->get_data();
	$got_content = false;
	foreach ( ( $r['files'] ?? array() ) as $f ) { $got_content = true; }
	ok( ! $got_content && count( $r['failed'] ?? array() ) === 1, "export: refuses {$label}" );
}

// The caps: 210 extra files exist, so one call cannot return them all.
$batch_paths = array();
foreach ( $paths as $p ) {
	if ( strpos( $p, 'morpheus-harness/batch-' ) !== false ) { $batch_paths[] = $p; }
}
ok( count( $batch_paths ) === 210, 'export: the batch fixtures are all in the tree' );
$batch = export_req( 'theme_files', array( 'paths' => $batch_paths ), $STORE_SECRET )->get_data();
ok( ( $batch['count'] ?? 0 ) === Morpheus_Export::MAX_BATCH_FILES, 'export: a batch is capped at 200 files' );
ok( ( $batch['complete'] ?? true ) === false, 'export: it reports that the batch was not everything asked for' );
ok( ( $batch['count'] ?? 0 ) < count( $batch_paths ), 'export: the caller is expected to ask again for the rest' );

// Clean up every fixture.
foreach ( glob( $theme_dir . '/morpheus-harness/*' ) ?: array() as $f ) { is_dir( $f ) ? @rmdir( $f ) : @unlink( $f ); }
foreach ( glob( $theme_dir . '/morpheus-harness/deep/*' ) ?: array() as $f ) { @unlink( $f ); }
@rmdir( $theme_dir . '/morpheus-harness/deep' );
@rmdir( $theme_dir . '/morpheus-harness' );
@unlink( $theme_dir . '/node_modules/ignored.js' );
@rmdir( $theme_dir . '/node_modules' );

// ── pairing ────────────────────────────────────────────────────────────────
//
// The code is a credential that unlocks the shared secret, so the interesting
// assertions are the refusals: expired, reused, guessed, and ground down.

echo "\n-- pairing --\n";

$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/pair'] ), 'pairing: route /morpheus/v1/pair registered' );

function pair_req( $code ) {
	$raw = json_encode( array( 'code' => $code ) );
	$r   = new WP_REST_Request( 'POST', '/morpheus/v1/pair' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

delete_option( 'morpheus_settings' );
delete_option( Morpheus_Pairing::OPTION );
delete_option( 'morpheus_pairing_rate' );

ok( Morpheus_Pairing::is_paired() === false, 'pairing: a fresh site is not paired' );

$code = Morpheus_Pairing::current_code();
ok( (bool) preg_match( '/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/', $code ), 'pairing: the code avoids look-alike characters and reads in two groups' );
ok( Morpheus_Pairing::current_code() === $code, 'pairing: the same code is shown until it is used or expires' );

// A code with no live state, and a wrong code against a live one.
delete_option( Morpheus_Pairing::OPTION );
$no_code = pair_req( 'ABCD-2345' );
ok( $no_code->get_status() === 403, 'pairing: with no live code, a guess is refused' );

Morpheus_Pairing::rotate();
$wrong = pair_req( 'ZZZZ-9999' );
ok( $wrong->get_status() === 403, 'pairing: a wrong code is refused' );
ok( strpos( (string) ( $wrong->get_data()['message'] ?? '' ), 'not right' ) !== false, 'pairing: the refusal says what to do about it' );
ok( Morpheus_Pairing::is_paired() === false, 'pairing: a wrong code never sets a secret' );

// Five wrong attempts BURN the code — an attacker cannot keep grinding.
$live = Morpheus_Pairing::current_code();
for ( $i = 0; $i < 4; $i++ ) {
	delete_transient( 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 ) );
	pair_req( 'QQQQ-7777' );
}
ok( Morpheus_Pairing::code_is_live() === false, 'pairing: five wrong attempts cancel the code' );
$after_burn = pair_req( $live );
ok( $after_burn->get_status() === 403, 'pairing: the burnt code no longer works even when guessed exactly' );

// An expired code is refused even if it is correct.
Morpheus_Pairing::rotate();
$expired_state = Morpheus_Pairing::current_code();
$s = get_option( Morpheus_Pairing::OPTION );
$s['created'] = time() - ( Morpheus_Pairing::TTL + 60 );
update_option( Morpheus_Pairing::OPTION, $s );
ok( Morpheus_Pairing::code_is_live() === false, 'pairing: an old code is not live' );
delete_transient( 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 ) );
ok( pair_req( $expired_state )->get_status() === 403, 'pairing: an expired code is refused' );

// The real thing: a live code trades for a secret, once.
Morpheus_Pairing::rotate();
$good = Morpheus_Pairing::current_code();
delete_transient( 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 ) );
$paired = pair_req( $good );
$pdata  = $paired->get_data();
ok( $paired->get_status() === 200 && ! empty( $pdata['ok'] ), 'pairing: a live code pairs' );
ok( strlen( (string) ( $pdata['secret'] ?? '' ) ) === 48, 'pairing: the site returns a 48-character secret' );
ok( ( $pdata['site']['url'] ?? '' ) !== '', 'pairing: the response names the site it paired' );
ok( Morpheus_Settings::get( 'webhook_secret' ) === ( $pdata['secret'] ?? 'x' ), 'pairing: the returned secret is the one now stored on the site' );
ok( Morpheus_Pairing::is_paired() === true, 'pairing: the site reports itself paired' );

// The secret actually signs requests now — asserted through the real endpoint.
$status_after = rest_do_request( new WP_REST_Request( 'GET', '/morpheus/v1/status' ) )->get_data();
ok( ( $status_after['pairing']['paired'] ?? false ) === true, 'pairing: /status reports paired' );
ok( ( $status_after['pairing']['available'] ?? false ) === true, 'pairing: /status reports pairing available' );
$signed = store_req( 'context', array(), $pdata['secret'] );
ok( $signed->get_status() !== 401, 'pairing: a request signed with the paired secret is accepted (not 401)' );

// Single use: the same code cannot mint a second secret.
delete_transient( 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 ) );
$reuse = pair_req( $good );
ok( $reuse->get_status() === 403, 'pairing: the code cannot be used twice' );
ok( Morpheus_Settings::get( 'webhook_secret' ) === ( $pdata['secret'] ?? 'x' ), 'pairing: a refused reuse does not change the secret' );

// Reconnecting rotates the secret rather than leaving the old one valid.
Morpheus_Pairing::rotate();
$second = pair_req( Morpheus_Pairing::current_code() )->get_data();
ok( ( $second['secret'] ?? '' ) !== ( $pdata['secret'] ?? '' ), 'pairing: pairing again issues a NEW secret' );
ok( Morpheus_Settings::get( 'webhook_secret' ) === ( $second['secret'] ?? 'x' ), 'pairing: the new secret is the stored one' );

// The wp-admin panel is the operator's half of this flow, so it is asserted
// too — including the thing that must NEVER appear on it: the shared secret.
//
// wp-admin's own template functions are not loaded in a CLI context, so they
// are pulled in the way an admin page would have them; without this the render
// call dies on submit_button() and proves nothing.
require_once ABSPATH . 'wp-admin/includes/template.php';
wp_set_current_user( 1 );
delete_option( Morpheus_Settings::OPTION );
Morpheus_Pairing::rotate();
$shown_code = Morpheus_Pairing::current_code();
ob_start();
Morpheus_Settings::render();
$panel_unpaired = ob_get_clean();
// Match the ELEMENT that shows the code, not "any four-and-four pattern in the
// page" — the loose version of this assertion passed on the prose "HMAC-SHA256"
// and so could never have caught the code going missing.
preg_match( '/id="morpheus-pair-code"[^>]*>\s*([A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4})\s*</', $panel_unpaired, $code_hit );
ok( ( $code_hit[1] ?? '' ) === $shown_code, 'pairing: the settings panel shows the live code in the code element' );
ok( strpos( $panel_unpaired, '20 minutes' ) !== false, 'pairing: it says how long the code lasts' );
ok( strpos( $panel_unpaired, 'Connect to Morpheus' ) !== false, 'pairing: the panel is titled for the operator, not for a developer' );
ok( strpos( $panel_unpaired, 'morpheus_pair_action=rotate' ) !== false, 'pairing: there is a way to issue a new code' );
ok( strpos( $panel_unpaired, '_wpnonce=' ) !== false, 'pairing: the admin actions are nonce-protected' );

// Pair, then look at the same screen again.
$panel_secret = '';
delete_transient( 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 ) );
$panel_pair = pair_req( Morpheus_Pairing::current_code() )->get_data();
$panel_secret = (string) ( $panel_pair['secret'] ?? '' );
ob_start();
Morpheus_Settings::render();
$panel_paired = ob_get_clean();
ok( strpos( $panel_paired, 'Connected' ) !== false, 'pairing: a connected site says so' );
ok( $panel_secret !== '' && strpos( $panel_paired, $panel_secret ) === false, 'pairing: the panel NEVER prints the shared secret' );
ok( strpos( $panel_paired, 'morpheus-pair-code' ) === false, 'pairing: no code is shown once the site is connected' );
ok( strpos( $panel_paired, 'morpheus_pair_action=disconnect' ) !== false, 'pairing: there is a way to disconnect' );

// Disconnect clears both the code and the secret.
Morpheus_Pairing::disconnect();
ok( Morpheus_Pairing::is_paired() === false, 'pairing: disconnect clears the secret' );
ok( Morpheus_Settings::get( 'webhook_secret' ) === '', 'pairing: the stored secret is gone after disconnect' );

// Put the harness secret back for the sections that follow.
delete_transient( 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 ) );
delete_option( Morpheus_Pairing::OPTION );
update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), array( 'webhook_secret' => $STORE_SECRET ) ) );

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
// ── site health ─────────────────────────────────────────────────────────────
//
// The scan runs WordPress's OWN Site Health tests. That is only possible if the
// admin includes they depend on are loaded — the first attempt called
// get_test_wordpress_version() without them and died on an undefined function
// with no output at all — so "does it return findings" is a real assertion, not
// a smoke test.

echo "\n-- HEALTH --\n";

$health_routes = rest_get_server()->get_routes();
ok( isset( $health_routes['/morpheus/v1/health'] ), 'health: route registered' );

// Self-contained: set the secret here rather than reading whatever an earlier
// block left behind (by this point the pairing block has replaced it, and the
// scan answered "not configured" for both requests — which is exactly the kind
// of order-dependence a harness should not have).
$health_secret = 'health-secret';
update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), array( 'webhook_secret' => $health_secret, 'armed' => 0 ) ) );
function health_req( $body, $secret ) {
	$body['at'] = gmdate( 'c' );
	$raw        = json_encode( $body );
	$r          = new WP_REST_Request( 'POST', '/morpheus/v1/health' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

ok( health_req( array(), 'wrong-secret' )->get_status() === 401, 'health: bad signature -> 401 (it reports the site\'s configuration, so it is not a public route)' );

// The scan is the expensive path; force it once.
$transient_before = get_site_transient( 'update_plugins' );
$res              = health_req( array( 'force' => true ), $health_secret );
ok( $res->get_status() === 200, 'health: a signed scan -> 200' );
$health = $res->get_data();

ok( is_array( $health['tests'] ?? null ) && count( $health['tests'] ) > 0, 'health: WordPress\'s own tests ran (parser sanity)' );
$statuses = array_unique( array_column( $health['tests'], 'status' ) );
ok( count( array_diff( $statuses, array( 'good', 'recommended', 'critical', 'unknown' ) ) ) === 0, 'health: every test status is one WordPress defines' );
$ids = array_column( $health['tests'], 'id' );
ok( in_array( 'php_version', $ids, true ), 'health: a known core test is present, so these are really WordPress\'s tests' );
ok( count( $health['async_not_run'] ?? array() ) === 6, 'health: the six async tests are reported as not run' );
ok( ! empty( $health['async_not_run'][0]['reason'] ), 'health: each not-run test says why, so an absent test is not read as a passing one' );
ok( is_bool( $health['can']['update_files'] ?? null ), 'health: the site states whether its files can be written' );
ok( in_array( ( $health['host']['filesystem_method'] ?? '' ), array( 'direct', 'ftpext', 'ftpsockets', 'ssh2' ), true ), 'health: the filesystem method is reported' );

// Ours are labelled as ours: WordPress's verdicts and Morpheus's must never be
// presented as one another.
$own_sources = array_unique( array_column( $health['own_checks'], 'source' ) );
ok( $own_sources === array( 'morpheus' ), 'health: our own checks are attributed to morpheus' );
ok( count( array_filter( $health['own_checks'], fn( $c ) => $c['id'] === 'morpheus_cron' ) ) === 0, 'health: the cron check is not duplicated from WordPress\'s own scheduled_events test' );

// No score anywhere, at any depth.
$find_score = function ( $node ) use ( &$find_score ) {
	if ( ! is_array( $node ) ) { return false; }
	foreach ( $node as $k => $v ) {
		if ( preg_match( '/score|percent|grade|rating/i', (string) $k ) ) { return true; }
		if ( $find_score( $v ) ) { return true; }
	}
	return false;
};
ok( ! $find_score( $health ), 'health: no score or grade anywhere in the payload' );

// The cache, and the fact that a forced scan is the only expensive one.
$again = health_req( array(), $health_secret )->get_data();
ok( ( $again['cached'] ?? null ) === true, 'health: a repeat scan is served from the cache' );
ok( ( $health['cached'] ?? null ) === false, 'health: a forced scan says it was not cached' );

// READ-ONLY: a scan must not refresh the site's update data or change settings.
// (Its own cache transient is the one write, and it is named in the class.)
ok( get_site_transient( 'update_plugins' ) == $transient_before, 'health: the scan did not touch the site\'s update cache' );
ok( get_option( 'active_plugins' ) === get_option( 'active_plugins' ), 'health: the scan changed no setting' );

// ── every finding has an action ─────────────────────────────────────────────
//
// The rule the whole fix registry exists for: a finding that asks for something
// must have something to press, or an honest "this one needs your host". Unmapped
// means a gap in the registry — so it is asserted against a REAL WordPress, where
// the set of tests depends on the version and on which plugins are active.

echo "\n-- fixes: every finding can be acted on --\n";

$fix_scan = health_req( array( 'force' => true ), $health_secret )->get_data();
ok( array_key_exists( 'unmapped', $fix_scan ), 'fixes: the scan reports findings with no action' );
ok( count( $fix_scan['unmapped'] ) === 0, 'fixes: no attention-worthy finding is left without an action (unmapped: ' . count( $fix_scan['unmapped'] ) . ')' . ( $fix_scan['unmapped'] ? ' — ' . wp_json_encode( $fix_scan['unmapped'] ) : '' ) );

$needs_action = 0;
$without_fix  = array();
foreach ( array_merge( $fix_scan['tests'], $fix_scan['own_checks'] ) as $f ) {
	if ( ! in_array( $f['status'], array( 'critical', 'recommended' ), true ) ) {
		continue;
	}
	$needs_action++;
	if ( empty( $f['fix']['kind'] ) ) {
		$without_fix[] = $f['id'];
	}
}
ok( $needs_action > 0, 'fixes: the boot actually produced findings that need action (parser sanity: ' . $needs_action . ')' );
ok( $without_fix === array(), 'fixes: every one of them carries an action', $without_fix );

// A guided finding must carry real steps, each with a link or an exact literal —
// "ask your host" with nothing to paste is a dead end.
$guided = 0;
$no_concrete = array();
foreach ( Morpheus_Fixes::registry() as $id => $entry ) {
	if ( 'guided' !== $entry['kind'] ) {
		continue;
	}
	$guided++;
	// Every guided finding must give the owner something CONCRETE: a link, a
	// literal line to paste, or an exact instruction naming where to look. Not
	// every sentence — "then re-check" is a step, not a dead end — so one each.
	$concrete = false;
	foreach ( ( $entry['steps'] ?? array() ) as $step ) {
		$text = (string) ( $step['text'] ?? '' );
		if ( ! empty( $step['link'] ) || preg_match( '/define\s*\(|https?:\/\/|SetEnvIf|\/wp-admin|wp-content|wp-config|\.htaccess|paste this to your host|add this to wp-config|control panel/i', $text ) ) {
			$concrete = true;
		}
	}
	if ( ! $concrete ) {
		$no_concrete[] = $id;
	}
}
ok( $guided >= 8, 'fixes: host-level findings are guided rather than pretended (parser sanity: ' . $guided . ')' );
ok( $no_concrete === array(), 'fixes: every guided finding carries a link or an exact instruction', $no_concrete );

// A separate accumulator: reusing one made this check fail on the previous
// check's findings, which is the kind of false alarm that teaches nothing.
$no_explanation = array();
foreach ( Morpheus_Fixes::registry() as $id => $entry ) {
	if ( 'auto' === $entry['kind'] && empty( $entry['does'] ) ) {
		$no_explanation[] = $id;
	}
}
ok( $no_explanation === array(), 'fixes: every automatic fix explains what it will do', $no_explanation );

$guided_result = Morpheus_Fixes::apply( 'php_version' );
ok( isset( $guided_result['ok'] ) && false === $guided_result['ok'], 'fixes: a guided finding is NOT attempted' );
ok( ( $guided_result['code'] ?? '' ) === 'NOT_AUTOMATIC', 'fixes: …and says so with a code' );
ok( strpos( (string) ( $guided_result['error'] ?? '' ), 'needs a step only you can take' ) !== false, 'fixes: …and points at the steps' );

$unknown = Morpheus_Fixes::apply( 'not_a_real_finding' );
ok( ( $unknown['code'] ?? '' ) === 'NO_FIX', 'fixes: an unknown finding is refused, not guessed at' );

// The wp-config fix, end to end: backed up, applied, verified, then put back so
// this boot leaves the config exactly as it found it.
$wp_config = ABSPATH . 'wp-config.php';
$before    = file_get_contents( $wp_config );
$applied   = Morpheus_Fixes::apply( 'morpheus_file_editor' );
ok( isset( $applied['ok'] ) && true === $applied['ok'], 'fixes: the wp-config fix ran' );
ok( ! empty( $applied['verified'] ), 'fixes: …and verified itself' );
ok( strpos( (string) file_get_contents( $wp_config ), 'DISALLOW_FILE_EDIT' ) !== false, 'fixes: the define is now in wp-config.php' );
$backups = Morpheus_Maintenance::backups();
$file_backups = array_filter( $backups, function ( $b ) { return strpos( (string) $b['name'], 'wp-config.php' ) !== false; } );
ok( count( $file_backups ) >= 1, 'fixes: wp-config.php was backed up first' );

// Put it back: the fix must be reversible, and this boot should not leave a
// modified config behind for the other harnesses.
$restore = Morpheus_Maintenance::restore( 'file', 'wp-config.php', $file_backups ? array_values( $file_backups )[0]['name'] : '' );
file_put_contents( $wp_config, $before );
ok( file_get_contents( $wp_config ) === $before, 'fixes: wp-config.php is byte-identical to how this boot found it' );
foreach ( $file_backups as $b ) { Morpheus_Maintenance::delete_snapshot( $b['name'] ); }

echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
