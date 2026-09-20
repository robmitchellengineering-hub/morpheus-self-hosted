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
// Nothing is set on the item, so the site-wide template supplies the title
// (templates ship ON) and the panel is told the value is inherited rather than
// implying an operator wrote it.
ok( ( $before['item']['seo_title'] ?? 'x' ) === '', 'unset title stores nothing on the item' );
ok( ( $before['item']['effective_title'] ?? '' ) === 'No-Yoast harness page | ' . get_bloginfo( 'name' ), 'unset title falls back to the site template' );
ok( ( $before['item']['inherited_title'] ?? false ) === true, 'unset title is reported as inherited' );
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

// ── site-wide templates ────────────────────────────────────────────────────
//
// The whole point of a template is that content nobody has set by hand still
// gets a sensible title and description — so these assertions are about a
// SECOND, bare item, and about what actually renders for it.

echo "\n-- SEO templates --\n";

$bare_id = wp_insert_post( array(
	'post_title'   => 'Bare template target',
	'post_content' => 'Opening line of the body copy that a template may use as a description. ' . str_repeat( 'More body text here. ', 40 ),
	'post_status'  => 'publish',
	'post_type'    => 'page',
) );

$shipped = seo_req( 'get_defaults', array(), $SECRET )->get_data();
ok( ! empty( $shipped['defaults'] ) && ! empty( $shipped['defaults']['enabled'] ), 'templates: shipped defaults exist and are on' );
ok( ( $shipped['defaults']['title'] ?? '' ) === '%title% | %sitename%', 'templates: the shipped title template names the site' );

$ctx_t = seo_req( 'context', array(), $SECRET )->get_data();
ok( ! empty( $ctx_t['tokens'] ) && in_array( '%excerpt%', $ctx_t['tokens'], true ), 'templates: context publishes the token list' );

// A bare page inherits BOTH values from the template.
$bare = seo_req( 'get_seo', array( 'id' => $bare_id ), $SECRET )->get_data();
ok( ( $bare['item']['seo_title'] ?? 'x' ) === '', 'templates: nothing is stored on the item itself' );
ok( ( $bare['item']['effective_title'] ?? '' ) === 'Bare template target | ' . get_bloginfo( 'name' ), 'templates: the title comes from the template' );
ok( ( $bare['item']['inherited_title'] ?? false ) === true, 'templates: the value is reported as inherited' );
ok( strpos( (string) $bare['item']['effective_description'], 'Opening line of the body copy' ) === 0, 'templates: the description comes from the body when there is no excerpt' );
ok( ( $bare['item']['inherited_description'] ?? false ) === true, 'templates: the description is reported as inherited' );

// And it is what the <head> actually prints.
$q2 = new WP_Query( array( 'page_id' => $bare_id, 'post_type' => 'page' ) );
$GLOBALS['wp_the_query'] = $q2;
$GLOBALS['wp_query']     = $q2;
$q2->the_post();
ok( apply_filters( 'pre_get_document_title', 'Derived' ) === 'Bare template target | ' . get_bloginfo( 'name' ), 'templates: the rendered document title uses the template' );
ob_start();
do_action( 'wp_head' );
$tpl_head = ob_get_clean();
ok( strpos( $tpl_head, 'name="description" content="Opening line of the body copy' ) !== false, 'templates: the rendered head carries the templated description' );
wp_reset_query();

// A per-item value always wins over the template.
seo_req( 'set_seo', array( 'id' => $bare_id, 'seo_title' => 'Written By Hand' ), $SECRET );
$written = seo_req( 'get_seo', array( 'id' => $bare_id ), $SECRET )->get_data();
ok( ( $written['item']['effective_title'] ?? '' ) === 'Written By Hand' && ( $written['item']['inherited_title'] ?? true ) === false, 'templates: an item value overrides the template' );
seo_req( 'set_seo', array( 'id' => $bare_id, 'seo_title' => '' ), $SECRET );

// Per-post-type overrides, and the site-wide one underneath.
$setd = seo_req( 'set_defaults', array( 'defaults' => array(
	'title'       => '%title% — %sitename%',
	'description' => '%excerpt%',
	'post_types'  => array( 'post' => array( 'title' => '%title% (blog)' ) ),
) ), $SECRET )->get_data();
ok( ( $setd['defaults']['title'] ?? '' ) === '%title% — %sitename%', 'templates: set_defaults returns what it stored' );

$bare2 = seo_req( 'get_seo', array( 'id' => $bare_id ), $SECRET )->get_data();
ok( ( $bare2['item']['effective_title'] ?? '' ) === 'Bare template target — ' . get_bloginfo( 'name' ), 'templates: a changed site-wide template takes effect' );

$post_id_t = wp_insert_post( array( 'post_title' => 'A Blog Post', 'post_content' => 'Body.', 'post_status' => 'publish', 'post_type' => 'post' ) );
$post_t = seo_req( 'get_seo', array( 'id' => $post_id_t ), $SECRET )->get_data();
ok( ( $post_t['item']['effective_title'] ?? '' ) === 'A Blog Post (blog)', 'templates: a per-post-type template wins for its type' );

// Tokens that do not exist are REMOVED — a literal %category% in a live <title>
// is worse than the word simply not being there.
$unknown = seo_req( 'set_defaults', array( 'defaults' => array( 'title' => '%title% %category% %nope%' ) ), $SECRET )->get_data();
ok( ( $unknown['defaults']['title'] ?? 'x' ) === '%title%', 'templates: unknown tokens are stripped' );
ok( ( seo_req( 'get_seo', array( 'id' => $bare_id ), $SECRET )->get_data()['item']['effective_title'] ?? '' ) === 'Bare template target', 'templates: the stripped template still renders cleanly' );

// Markup and over-long values are cleaned, not trusted.
$dirty = seo_req( 'set_defaults', array( 'defaults' => array(
	'title'       => '<script>alert(1)</script>%title% | %sitename%',
	'description' => str_repeat( 'long ', 100 ),
) ), $SECRET )->get_data();
ok( strpos( $dirty['defaults']['title'], 'alert' ) === false && strpos( $dirty['defaults']['title'], '<' ) === false, 'templates: markup is stripped on write' );
ok( mb_strlen( $dirty['defaults']['description'] ) <= 200, 'templates: an over-long template is capped' );

// Turning templates off restores WordPress's own derived values.
$off = seo_req( 'set_defaults', array( 'defaults' => array( 'enabled' => false ) ), $SECRET )->get_data();
ok( ( $off['defaults']['enabled'] ?? true ) === false, 'templates: they can be switched off' );
ok( ( seo_req( 'get_seo', array( 'id' => $bare_id ), $SECRET )->get_data()['item']['effective_title'] ?? '' ) === 'Bare template target', 'templates: switched off, the raw post title is back' );

// An empty template for a field is a deliberate "do not template this".
seo_req( 'set_defaults', array( 'defaults' => array( 'enabled' => true, 'title' => '%title% | %sitename%', 'description' => '' ) ), $SECRET );
$nodesc = seo_req( 'get_seo', array( 'id' => $bare_id ), $SECRET )->get_data();
ok( ( $nodesc['item']['inherited_description'] ?? true ) === false, 'templates: a blank description template means no templated description' );

// With a template supplying both, the audit must NOT call it missing — the
// audit measures what actually goes out.
seo_req( 'set_defaults', array( 'defaults' => array( 'enabled' => true, 'title' => '%title% | %sitename%', 'description' => '%excerpt%' ) ), $SECRET );
$audit_t = seo_req( 'audit', array( 'limit' => 100 ), $SECRET )->get_data();
$codes_t = array_column( $audit_t['issues'], 'code' );
$bare_missing = false;
foreach ( $audit_t['issues'] as $iss ) {
	if ( (int) $iss['id'] === $bare_id && in_array( $iss['code'], array( 'missing_title', 'missing_description' ), true ) ) {
		$bare_missing = true;
	}
}
ok( $bare_missing === false, 'templates: a templated title/description is not reported as missing' );

// Back to the shipped state for the sections below.
seo_req( 'set_defaults', array( 'defaults' => Morpheus_SEO::defaults() ), $SECRET );

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
wp_delete_post( $bare_id, true );
wp_delete_post( $post_id_t, true );
delete_option( 'morpheus_seo_defaults' );
delete_option( 'morpheus_settings' );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
