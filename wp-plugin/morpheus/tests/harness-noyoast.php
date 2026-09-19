<?php
/**
 * The NO-THIRD-PARTY-SEO-PLUGIN half of the duplicate-tag rule.
 *
 * tests/harness.php runs WordPress WITH Yoast, which proves the "drive another
 * plugin's keys, emit nothing ourselves" half. The other half — Morpheus
 * owning the head outright when nothing else is installed — cannot be tested
 * there, because a plugin loaded by the blueprint cannot be un-loaded mid-run.
 * Before this file the claim was only ever asserted by reading keys_for().
 *
 * So this is a second boot with NO SEO plugin. What is asserted here is what
 * the operator actually gets on a clean WordPress install:
 *
 *   * owns_head() is true and context says so
 *   * set_seo writes MORPHEUS's own postmeta keys (and no Yoast keys)
 *   * the <title>, meta description, canonical, robots, Open Graph, Twitter
 *     and JSON-LD actually reach the rendered <head> — asserted by capturing
 *     wp_head(), not by reading the emitter
 *   * robots.txt gets the sitemap line
 *   * the STORE module's page/post SEO fields work (this is the path that used
 *     to be a silent no-op with no Yoast installed)
 *
 *   wp-playground-cli php \
 *     --auto-mount ./wp-plugin/morpheus \
 *     --mount ./wp-plugin/morpheus/tests:/tests \
 *     -- /tests/harness-noyoast.php
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

echo "\n== no-Yoast boot: fixtures ==\n";
// If Yoast (or any mapped plugin) is present in this boot the whole file is
// meaningless — it would be re-testing harness.php's half and silently
// skipping the very path it exists to cover. Fail loudly instead.
foreach ( array( 'WPSEO_VERSION', 'RANK_MATH_VERSION', 'AIOSEO_VERSION', 'SEOPRESS_VERSION' ) as $const ) {
	ok( ! defined( $const ), "no third-party SEO plugin in this boot ($const undefined)" );
}
ok( class_exists( 'Morpheus_SEO' ), 'SEO module loaded' );

echo "\n== no-Yoast boot: who owns the head ==\n";
ok( Morpheus_SEO::active_plugin() === null, 'active_plugin() is null' );
ok( Morpheus_SEO::owns_head() === true, 'Morpheus owns the head' );

$routes = rest_get_server()->get_routes();
ok( isset( $routes['/morpheus/v1/seo'] ), 'route /morpheus/v1/seo registered' );

$status = rest_do_request( new WP_REST_Request( 'GET', '/morpheus/v1/status' ) )->get_data();
ok( ( $status['seo']['available'] ?? null ) === true, 'status: SEO module available' );
ok( ( $status['seo']['owns_head'] ?? null ) === true, 'status: Morpheus owns the head' );
// `?? 'x'` would turn a genuine null into 'x' here, so absence-of-a-value is
// asserted by key existence plus a strict null — the whole point of this boot
// is that there is NO active plugin, and a test that cannot see null would
// pass while the value was wrong.
ok( array_key_exists( 'active_plugin', $status['seo'] ) && $status['seo']['active_plugin'] === null, 'status: no active third-party SEO plugin' );

$SECRET = 'noyoast-secret';
update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), array( 'webhook_secret' => $SECRET ) ) );

function seo_req( $action, $data, $secret ) {
	$raw = json_encode( array( 'action' => $action, 'data' => $data, 'at' => gmdate( 'c' ) ) );
	$r   = new WP_REST_Request( 'POST', '/morpheus/v1/seo' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}
function store_req( $action, $data, $secret ) {
	$raw = json_encode( array( 'action' => $action, 'data' => $data, 'at' => gmdate( 'c' ) ) );
	$r   = new WP_REST_Request( 'POST', '/morpheus/v1/store' );
	$r->set_header( 'content-type', 'application/json' );
	$r->set_header( 'X-Morpheus-Signature', 'sha256=' . hash_hmac( 'sha256', $raw, $secret ) );
	$r->set_body( $raw );
	return rest_do_request( $r );
}

$ctx = seo_req( 'context', array(), $SECRET )->get_data();
ok( ( $ctx['owns_head'] ?? null ) === true, 'context: owns_head true' );
ok( array_key_exists( 'active_plugin', $ctx ) && $ctx['active_plugin'] === null, 'context: active_plugin null' );
ok( ! empty( $ctx['limits']['title_max'] ), 'context: length guidance is exposed to the widget' );

echo "\n== no-Yoast boot: read/write lands in OUR keys ==\n";
$id = wp_insert_post( array(
	'post_title'   => 'No-Yoast harness page',
	'post_excerpt' => 'A short excerpt that WordPress would use if nothing else were set.',
	'post_content' => str_repeat( 'Real body copy for the page, so the derived description has something to work with. ', 20 ),
	'post_status'  => 'publish',
	'post_type'    => 'page',
) );

// Before anything is set, the field is empty but the EFFECTIVE value is what
// WordPress would emit on its own — the widget shows that rather than a blank
// box that hides a live value.
$before = seo_req( 'get_seo', array( 'id' => $id ), $SECRET )->get_data();
ok( ( $before['item']['seo_title'] ?? 'x' ) === '' && ( $before['item']['effective_title'] ?? '' ) === 'No-Yoast harness page', 'unset title falls back to the derived one' );
ok( ( $before['item']['source'] ?? '' ) === 'morpheus', 'item reports Morpheus as the source' );

$set = seo_req( 'set_seo', array(
	'id'              => $id,
	'seo_title'       => 'No-Yoast Harness Title',
	'seo_description' => 'A description only Morpheus knows about, with no Yoast installed anywhere.',
	'focus_keyword'   => 'harness title',
	'og_image'        => 'https://example.com/og.png',
	'canonical'       => 'https://example.com/canonical',
), $SECRET )->get_data();
ok( ( $set['item']['seo_title'] ?? '' ) === 'No-Yoast Harness Title', 'set_seo returns the stored title' );
ok( get_post_meta( $id, '_morpheus_seo_title', true ) === 'No-Yoast Harness Title', 'title written to MORPHEUS\'s key' );
ok( get_post_meta( $id, '_yoast_wpseo_title', true ) === '', 'no Yoast key written (nothing would read it)' );
ok( get_post_meta( $id, '_morpheus_seo_keyword', true ) === '', 'the focus keyword does NOT live in a key nothing reads' );
ok( get_post_meta( $id, '_morpheus_seo_focus_keyword', true ) === 'harness title', 'focus keyword stored in Morpheus\'s own key' );

$got = seo_req( 'get_seo', array( 'id' => $id ), $SECRET )->get_data();
ok( get_post_meta( $id, '_morpheus_seo_canonical', true ) === 'https://example.com/canonical', 'canonical stored' );
ok( get_post_meta( $id, '_morpheus_seo_og_image', true ) === 'https://example.com/og.png', 'og:image stored' );
ok( ( $got['item']['effective_title'] ?? '' ) === 'No-Yoast Harness Title', 'effective_title is OUR title once set' );

// Clearing a field must restore the derived value, not leave an empty box.
seo_req( 'set_seo', array( 'id' => $id, 'seo_description' => '' ), $SECRET );
ok( get_post_meta( $id, '_morpheus_seo_description', true ) === '', 'emptying a field deletes our meta' );
$cleared = seo_req( 'get_seo', array( 'id' => $id ), $SECRET )->get_data();
ok( strpos( (string) $cleared['item']['effective_description'], 'A short excerpt' ) === 0, 'effective_description falls back to the excerpt' );

echo "\n== no-Yoast boot: the tags actually render ==\n";
// The clearing test above deliberately emptied the description, so set the
// whole field set again — these assertions are about what the head emits, and
// they should not depend on which write ran last.
seo_req( 'set_seo', array(
	'id'              => $id,
	'seo_title'       => 'No-Yoast Harness Title',
	'seo_description' => 'A description only Morpheus knows about, with no Yoast installed anywhere.',
	'og_image'        => 'https://example.com/og.png',
	'canonical'       => 'https://example.com/canonical',
), $SECRET );

// Put the page into the main query so is_singular()/get_queried_object_id()
// are real, then capture what the theme's head would print.
$q = new WP_Query( array( 'page_id' => $id, 'post_type' => 'page' ) );
$GLOBALS['wp_the_query'] = $q;
$GLOBALS['wp_query']     = $q;
$q->the_post();
ok( is_singular(), 'the fixture page is a singular view' );
ok( get_queried_object_id() === $id, 'queried object is the fixture page' );

$title = apply_filters( 'pre_get_document_title', 'Derived WordPress Title' );
ok( $title === 'No-Yoast Harness Title', 'document title is replaced by our SEO title' );

ob_start();
do_action( 'wp_head' );
$head = ob_get_clean();

ok( strpos( $head, 'name="description" content="A description only Morpheus knows about' ) !== false, 'head carries our meta description' );
ok( strpos( $head, 'rel="canonical" href="https://example.com/canonical"' ) !== false, 'head carries our canonical' );
ok( strpos( $head, 'property="og:title" content="No-Yoast Harness Title"' ) !== false, 'head carries og:title' );
ok( strpos( $head, 'property="og:image" content="https://example.com/og.png"' ) !== false, 'head carries og:image when set' );
ok( strpos( $head, 'name="twitter:card"' ) !== false, 'head carries a twitter card' );
ok( strpos( $head, 'application/ld+json' ) !== false, 'head carries JSON-LD' );
ok( strpos( $head, '"@type":"WebPage"' ) !== false, 'the schema node is typed WebPage for a page' );
ok( strpos( $head, 'name="robots"' ) === false, 'no robots tag while the page is indexable' );

// noindex is stored differently per plugin and is the one field with its own
// write branch — assert the round trip through to the emitted tag.
seo_req( 'set_seo', array( 'id' => $id, 'noindex' => true ), $SECRET );
ob_start();
do_action( 'wp_head' );
$head_noindex = ob_get_clean();
ok( strpos( $head_noindex, 'name="robots" content="noindex' ) !== false, 'noindex reaches the head once switched on' );
ok( get_post_meta( $id, '_morpheus_seo_robots', true ) === '1', 'noindex stored as our key value' );
seo_req( 'set_seo', array( 'id' => $id, 'noindex' => false ), $SECRET );
ok( get_post_meta( $id, '_morpheus_seo_robots', true ) === '', 'noindex cleared removes our meta' );

wp_reset_query();

echo "\n== no-Yoast boot: robots.txt ==\n";
// WordPress core has filtered robots_txt since 5.5 and appends a Sitemap line
// for its own sitemap — so an un-isolated call here would pass on CORE's
// behaviour and prove nothing about this plugin. That fact is asserted first,
// then core's filter is removed so the next three checks are about Morpheus's
// filter alone. (Which also means the honest description of our filter is "a
// backstop for when core's line is missing", not "the thing that adds it".)
$core_only = apply_filters( 'robots_txt', "User-agent: *\nDisallow: /wp-admin/\n", true );
ok( strpos( $core_only, 'Sitemap:' ) !== false, 'core already emits a Sitemap line (why this section isolates)' );

remove_all_filters( 'robots_txt' );
add_filter( 'robots_txt', array( 'Morpheus_SEO', 'filter_robots_txt' ), 20, 2 );

$robots = apply_filters( 'robots_txt', "User-agent: *\nDisallow: /wp-admin/\n", true );
ok( strpos( $robots, 'Sitemap: ' . home_url( '/wp-sitemap.xml' ) ) !== false, 'robots.txt points at the sitemap' );
$already = apply_filters( 'robots_txt', "User-agent: *\nSitemap: https://example.com/sitemap.xml\n", true );
ok( substr_count( $already, 'Sitemap:' ) === 1, 'an existing Sitemap line is left alone' );
$private = apply_filters( 'robots_txt', "User-agent: *\n", false );
ok( strpos( $private, 'Sitemap:' ) === false, 'a private site gets no sitemap line' );

echo "\n== no-Yoast boot: the STORE module's SEO fields work too ==\n";
// This is the path that used to be a silent no-op without Yoast: create a page
// through the STORE module with SEO fields and read them back.
$page = store_req( 'create_page', array(
	'title'           => 'Store-created page (no Yoast)',
	'content'         => 'Body.',
	'seo_title'       => 'Store SEO Title',
	'seo_description' => 'Store SEO description.',
), $SECRET )->get_data();
ok( ! empty( $page['created'] ), 'create_page ok' );
$page_id = $page['page']['id'] ?? 0;
ok( get_post_meta( $page_id, '_morpheus_seo_title', true ) === 'Store SEO Title', 'store wrote MORPHEUS\'s key, not Yoast\'s' );

store_req( 'update_page', array( 'id' => $page_id, 'seo_description' => 'Updated description.' ), $SECRET );
$read_back = store_req( 'get_page', array( 'id' => $page_id ), $SECRET )->get_data();
ok( ( $read_back['page']['seo_description'] ?? '' ) === 'Updated description.', 'update_page + get_page round-trip the description' );

$store_ctx = store_req( 'context', array(), $SECRET )->get_data();
ok( ( $store_ctx['seo_available'] ?? null ) === true, 'store context: seo_available true with no Yoast installed' );

// And through the SEO module for the same post, so the two modules agree on
// where the value lives.
$same = seo_req( 'get_seo', array( 'id' => $page_id ), $SECRET )->get_data();
ok( ( $same['item']['seo_title'] ?? '' ) === 'Store SEO Title', 'the SEO module reads what the Store module wrote' );

wp_delete_post( $page_id, true );
wp_delete_post( $id, true );
delete_option( 'morpheus_settings' );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
