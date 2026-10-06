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

// The site's own entity, on every page. This is the half of the schema that
// describes the SITE rather than the page, and with no SEO plugin active
// nothing else emits it. Asserted on the rendered head, not on the source,
// because a doc-comment claiming an organization node while the code emitted
// none is exactly how this went unnoticed before.
ok( strpos( $head, '"@type":"Organization"' ) !== false, 'the head carries an Organization node' );
ok( strpos( $head, '"@type":"WebSite"' ) !== false, 'the head carries a WebSite node' );
ok( strpos( $head, '"@type":"SearchAction"' ) !== false, 'the WebSite node carries a SearchAction' );
ok( strpos( $head, 'query-input":"required name=search_term_string' ) !== false, 'the SearchAction declares its query-input' );
ok( strpos( $head, '#organization' ) !== false && strpos( $head, '#website' ) !== false, 'the two site nodes are linked by @id' );
ok( strpos( $head, '"name":"' ) !== false, 'the Organization node carries the site name' );

// A storefront entity needs an address, a phone and opening hours, none of
// which WooCommerce's store options hold. A partial LocalBusiness is worse than
// none (and a theme often emits a complete one already), so its absence is
// asserted rather than left to chance.
ok( strpos( $head, 'LocalBusiness' ) === false, 'no LocalBusiness node is emitted' );
ok( strpos( $head, 'aggregateRating' ) === false, 'no invented aggregateRating' );
ok( strpos( $head, 'priceRange' ) === false, 'no invented priceRange' );

// Every JSON-LD block on the page must parse. A malformed node is worse than a
// missing one: consumers drop the whole graph.
$ld_blocks = array();
if ( preg_match_all( '#<script type="application/ld\+json">(.*?)</script>#s', $head, $m ) ) {
	$ld_blocks = $m[1];
}
ok( count( $ld_blocks ) >= 1, 'at least one JSON-LD block is present' );
$bad_json = 0;
foreach ( $ld_blocks as $block ) {
	if ( json_decode( $block, true ) === null ) {
		$bad_json++;
	}
}
ok( $bad_json === 0, 'every JSON-LD block parses as JSON (' . count( $ld_blocks ) . ' block(s))' );

// ⭐ EXACTLY ONE CANONICAL, AND IT CARRIES OUR VALUE.
//
// This was a KNOWN FINDING that asserted only "at least one" and reported the count, because the duplicate came
// from WordPress core's own `rel_canonical()` at wp_head priority 10 and removing it looked like a
// shared-ownership question. It was not: both emitters are known, so the plugin now OWNS THE VALUE instead of
// printing a second tag — core's `get_canonical_url` filter returns Morpheus's canonical, and we print nothing
// when core is going to. The live store's homepage was rendering the tag twice; this is the assertion that would
// have caught it, and it fails on the duplicate rather than reporting it.
$canonical_count = substr_count( $head, 'rel="canonical"' );
ok( 1 === $canonical_count, 'the head carries EXACTLY ONE canonical tag (found ' . $canonical_count . ')' );
// And it is OURS — the custom value written above, not the permalink core would have derived on its own.
ok( strpos( $head, 'rel="canonical" href="https://example.com/canonical"' ) !== false, 'carrying the canonical Morpheus set, not the one core derived' );
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

// ── internal links ─────────────────────────────────────────────────────────
//
// This writes to live content, so the refusals matter more than the success:
// each assertion here is a case that must NOT touch the page.

echo "\n-- SEO internal links --\n";

$link_original = '<p>We repair electric and acoustic guitars in Melbourne, and every setup covers the truss rod and the intonation.</p><p><a href="https://example.com/already">An existing link about setups</a> sits here.</p>';
$link_target = wp_insert_post( array(
	'post_title'   => 'Guitar Repairs',
	'post_content' => $link_original,
	'post_status'  => 'publish',
	'post_type'    => 'page',
) );
$link_other = wp_insert_post( array( 'post_title' => 'Setup Guide', 'post_content' => 'Body.', 'post_status' => 'publish', 'post_type' => 'page' ) );
$other_url  = get_permalink( $link_other );

// A dry run reports the exact sentence and writes NOTHING.
$dry = seo_req( 'bulk_add_links', array(
	'dry_run' => true,
	'items'   => array( array( 'id' => $link_target, 'anchor' => 'truss rod', 'url' => $other_url ) ),
), $SECRET )->get_data();
ok( ( $dry['would'] ?? 0 ) === 1 && ( $dry['count'] ?? -1 ) === 0, 'links: a dry run reports what it would do and writes nothing' );
ok( strpos( (string) get_post_field( 'post_content', $link_target ), '<a href="' . $other_url . '">' ) === false, 'links: the dry run left the content alone' );
ok( strpos( (string) ( $dry['added'][0]['context'] ?? '' ), 'truss rod' ) !== false, 'links: the dry run shows the sentence the link lands in' );
ok( ( $dry['added'][0]['anchor'] ?? '' ) === 'truss rod', 'links: it reports the matched phrase' );

// Refusals: none of these may modify the page.
$publish = function ( $r ) { return ( $r['added'] ?? array() ); };
$refuse = seo_req( 'bulk_add_links', array( 'items' => array(
	array( 'id' => $link_target, 'anchor' => 'pink elephants juggling', 'url' => $other_url ),
) ), $SECRET )->get_data();
ok( count( $refuse['skipped'] ?? array() ) === 1 && strpos( $refuse['skipped'][0]['reason'], 'not in the item text' ) !== false, 'links: a phrase that is not in the text is refused' );

$inlink = seo_req( 'bulk_add_links', array( 'items' => array(
	array( 'id' => $link_target, 'anchor' => 'existing link about setups', 'url' => $other_url ),
) ), $SECRET )->get_data();
ok( count( $inlink['skipped'] ?? array() ) === 1, 'links: a phrase that is already inside a link is refused' );

$self = seo_req( 'bulk_add_links', array( 'items' => array(
	array( 'id' => $link_target, 'anchor' => 'Melbourne', 'url' => get_permalink( $link_target ) ),
) ), $SECRET )->get_data();
ok( strpos( $self['skipped'][0]['reason'], 'this page' ) !== false, 'links: a self link is refused' );

// Apply for real, then check the content, the dupe guard and the undo.
$applied_links = seo_req( 'bulk_add_links', array( 'items' => array(
	array( 'id' => $link_target, 'anchor' => 'electric and acoustic guitars', 'url' => $other_url ),
) ), $SECRET )->get_data();
ok( ( $applied_links['count'] ?? 0 ) === 1, 'links: the link is added' );
$new_content = (string) get_post_field( 'post_content', $link_target );
ok( strpos( $new_content, '<a href="' . $other_url . '">electric and acoustic guitars</a>' ) !== false, 'links: the existing phrase was wrapped, keeping its own casing' );
// Wrapping a phrase inserts tags INTO the sentence, so the contiguous text is
// gone by design — what must be unchanged is the READER-VISIBLE text.
ok( wp_strip_all_tags( $new_content ) === wp_strip_all_tags( $link_original ), 'links: the visible text is unchanged — only a tag was added' );
ok( strlen( $new_content ) > strlen( $link_original ), 'links: nothing was removed' );
ok( substr_count( $new_content, '<a ' ) === 2, 'links: the pre-existing link is untouched and exactly one was added' );

$again = seo_req( 'bulk_add_links', array( 'items' => array(
	array( 'id' => $link_target, 'anchor' => 'truss rod', 'url' => $other_url ),
) ), $SECRET )->get_data();
ok( count( $again['skipped'] ?? array() ) === 1 && strpos( $again['skipped'][0]['reason'], 'already links' ) !== false, 'links: the same target is not linked twice' );

// The undo the UI promises must actually exist.
$revisions = wp_get_post_revisions( $link_target );
ok( count( $revisions ) >= 1, 'links: WordPress kept a revision, so the edit can be undone' );
ok( ( $applied_links['added'][0]['revision'] ?? 0 ) >= 1, 'links: the response reports the revision count' );

// Markup, not text, must never be wrapped: a phrase in an attribute is refused.
$attr = wp_insert_post( array(
	'post_title'   => 'Attribute case',
	'post_content' => '<p><img src="https://example.com/photo.jpg" alt="truss rod adjustment" />Text about setups here.</p>',
	'post_status'  => 'publish',
	'post_type'    => 'page',
) );
$attr_res = seo_req( 'bulk_add_links', array( 'items' => array(
	array( 'id' => $attr, 'anchor' => 'truss rod adjustment', 'url' => $other_url ),
) ), $SECRET )->get_data();
ok( count( $attr_res['skipped'] ?? array() ) === 1, 'links: a phrase inside an HTML attribute is refused (markup is never rewritten)' );

wp_delete_post( $link_target, true );
wp_delete_post( $link_other, true );
wp_delete_post( $attr, true );

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

// An existing line we CANNOT attribute is left alone. The fixture is a path this
// plugin knows nothing about on purpose: /sitemap.xml on our own host IS
// attributable (to AIOSEO), so using it here would pass while testing the
// opposite of what this check means.
$already = apply_filters( 'robots_txt', "User-agent: *\nSitemap: " . home_url( '/custom-sitemap.xml' ) . "\n", true );
ok( substr_count( $already, 'Sitemap:' ) === 1 && strpos( $already, '/custom-sitemap.xml' ) !== false, 'an unattributable Sitemap line is left alone' );

$other_host = apply_filters( 'robots_txt', "User-agent: *\nSitemap: https://example.org/sitemap_index.xml\n", true );
ok( strpos( $other_host, 'example.org/sitemap_index.xml' ) !== false && substr_count( $other_host, 'Sitemap:' ) === 1, 'a sitemap on another host is left alone' );

$private = apply_filters( 'robots_txt', "User-agent: *\n", false );
ok( strpos( $private, 'Sitemap:' ) === false, 'a private site gets no sitemap line' );

// The live failure this fixes: an SEO plugin was removed, its sitemap path 404s,
// and a month-cached robots.txt kept advertising it while core's real sitemap
// went unadvertised. A dead attributable line must be dropped and ours emitted.
$dead = apply_filters( 'robots_txt', "User-agent: *\nSitemap: " . home_url( '/sitemap_index.xml' ) . "\n", true );
ok( strpos( $dead, '/sitemap_index.xml' ) === false, 'a dead attributable Sitemap line is removed' );
ok( strpos( $dead, 'Sitemap: ' . home_url( '/wp-sitemap.xml' ) ) !== false, '…and ours is advertised in its place' );
ok( substr_count( $dead, 'Sitemap:' ) === 1, '…leaving exactly one Sitemap line' );

$dead_and_live = apply_filters( 'robots_txt', "User-agent: *\nSitemap: " . home_url( '/sitemap_index.xml' ) . "\nSitemap: " . home_url( '/custom-sitemap.xml' ) . "\n", true );
ok( substr_count( $dead_and_live, 'Sitemap:' ) === 2 && strpos( $dead_and_live, '/custom-sitemap.xml' ) !== false, 'a live line survives alongside a dropped dead one' );

// The judgement itself, unit-tested: attributable-and-inactive is dead,
// everything we cannot attribute is not.
ok( Morpheus_SEO::sitemap_url_is_dead( home_url( '/sitemap_index.xml' ) ), 'sitemap_index.xml on our host is judged dead with no SEO plugin' );
ok( Morpheus_SEO::sitemap_url_is_dead( '/sitemap.xml' ), 'a relative attributable path is judged dead too' );
ok( ! Morpheus_SEO::sitemap_url_is_dead( home_url( '/custom-sitemap.xml' ) ), 'a path we cannot attribute is NOT judged dead' );
ok( ! Morpheus_SEO::sitemap_url_is_dead( 'https://example.org/sitemap_index.xml' ), 'another host is NOT judged dead' );

// The old path is served rather than left 404ing, and only when nothing else
// legitimately claims it (with an SEO plugin active this method returns early).
Morpheus_SEO::register_legacy_sitemap_redirect();
$rules = get_option( 'rewrite_rules' );
flush_rewrite_rules();
$rules = get_option( 'rewrite_rules' );
$rule_hit = 0;
foreach ( (array) $rules as $pattern => $target ) {
	if ( strpos( $pattern, 'sitemap_index' ) !== false && strpos( $target, 'morpheus_legacy_sitemap' ) !== false ) {
		$rule_hit++;
	}
}
ok( $rule_hit === 1, 'the legacy sitemap path is rewritten (one rule)' );

echo "\n== no-Yoast boot: a stale physical robots.txt is quarantined, never deleted ==\n";
// The live failure this covers: Yoast was removed, /sitemap_index.xml started
// 404ing, and a physical robots.txt left on the host kept advertising it. A
// physical file always wins — WordPress only builds /robots.txt while none
// exists — so the filter above NEVER RUNS on that site and nothing in wp-admin
// mentions the file. The owner held the hosting account but not the cPanel
// login (a third party had it), so deleting the file was not available to him.
// Hence a quarantine with a visible undo.
//
// A harness is the only place these claims can be checked: they are about what
// the WEB SERVER actually serves, which needs a running WordPress.

$robots_file = ABSPATH . 'robots.txt';
$stale_body  = "User-agent: *\nDisallow: /wp-admin/\n# START YOAST BLOCK\nSitemap: " . home_url( '/sitemap_index.xml' ) . "\n# END YOAST BLOCK\n";

function morpheus_clear_robots_backups() {
	foreach ( (array) ( glob( ABSPATH . 'robots.txt.morpheus-bak-*' ) ?: array() ) as $f ) {
		@unlink( $f );
	}
}
morpheus_clear_robots_backups();

// The one hook that lets this harness drive the HTTP side: `pre_http_request`
// short-circuits wp_remote_get() so the site can be made to answer with bytes
// that differ from what is on disk — which is how "the file is not the one being
// served" and "the change did not verify" are produced on demand. Left null it
// does nothing at all, so every other fetch in this file is a real one.
$GLOBALS['morpheus_robots_probe'] = null;
add_filter( 'pre_http_request', function ( $pre, $args, $url ) {
	$probe = $GLOBALS['morpheus_robots_probe'] ?? null;
	if ( is_callable( $probe ) ) {
		$body = $probe( $url );
		if ( is_string( $body ) ) {
			return array(
				'headers'  => array(),
				'body'     => $body,
				'response' => array( 'code' => 200, 'message' => 'OK' ),
				'cookies'  => array(),
				'filename' => null,
			);
		}
	}
	return $pre;
}, 10, 3 );

/**
 * The live /robots.txt, retried.
 *
 * WordPress Playground's static-file router intermittently answers a
 * /robots.txt request with a bare 500 ("Could not read /wordpress/robots.txt")
 * even once no such file exists any more — measured at roughly one request in
 * five, with a query string as well as without, and happening before WordPress
 * runs at all. A real host falls through to the front controller, which is the
 * whole premise of this feature. The retry keeps these assertions about the
 * plugin rather than about that race; the plugin's own read retries too, for
 * the same reason (see Morpheus_SEO::fetch_robots_txt()).
 */
function morpheus_live_robots( $url = null, $tries = 8 ) {
	$url  = $url ? $url : home_url( '/robots.txt' );
	$last = array( 'code' => 0, 'body' => '' );
	for ( $i = 0; $i < $tries; $i++ ) {
		$r = wp_remote_get( $url, array( 'timeout' => 15 ) );
		if ( ! is_wp_error( $r ) ) {
			$last = array(
				'code' => (int) wp_remote_retrieve_response_code( $r ),
				'body' => (string) wp_remote_retrieve_body( $r ),
			);
			if ( $last['code'] < 500 ) {
				return $last;
			}
		}
		usleep( 150000 );
	}
	return $last;
}

// ── the judgement ──────────────────────────────────────────────────────────

// 1. No physical file at all: WordPress serves its own, so there is no finding.
@unlink( $robots_file );
clearstatcache();
$state = Morpheus_SEO::robots_txt_state();
ok( is_array( $state ) && $state['physical'] === false && $state['stale'] === false, 'robots: no physical file is not a finding' );

// 2. A GOOD physical file — served, and advertising a sitemap that answers.
//    This is the over-eagerness test: the fix MOVES A FILE, so a file that is
//    doing its job must produce nothing to press.
@file_put_contents( $robots_file, "User-agent: *\nDisallow: /wp-admin/\nSitemap: " . home_url( '/wp-sitemap.xml' ) . "\n" );
clearstatcache();
$state = Morpheus_SEO::robots_txt_state();
ok( is_array( $state ) && $state['served'] === true, 'robots: a good physical file is the one being served' );
ok( is_array( $state ) && $state['stale'] === false, 'robots: a good physical file produces NO finding' );

// 3. The file that is NOT the one being served is not a problem either. A host
//    whose docroot differs from ABSPATH, or a server that ignores the file,
//    looks exactly like this — and moving the file would change nothing.
$GLOBALS['morpheus_robots_probe'] = function ( $url ) use ( $stale_body ) {
	return strpos( $url, '/robots.txt' ) !== false ? "User-agent: *\nDisallow: /\n" : null;
};
$not_served = Morpheus_SEO::robots_txt_state();
ok( is_array( $not_served ) && $not_served['physical'] === true && $not_served['served'] === false, 'robots: a file that is not served is recognised as such' );
ok( is_array( $not_served ) && $not_served['stale'] === false, 'robots: a file that is not served is not a finding' );

// 4. The live failure: a stale file that IS served.
$GLOBALS['morpheus_robots_probe'] = null;
@file_put_contents( $robots_file, $stale_body );
clearstatcache();
$state = Morpheus_SEO::robots_txt_state();
ok( is_array( $state ) && $state['served'] === true, 'robots: the stale file is the one being served' );
ok( is_array( $state ) && $state['stale'] === true, 'robots: the stale file IS a finding' );
ok( strpos( (string) $state['reason'], '/sitemap_index.xml' ) !== false, 'robots: the reason names the sitemap URL that does not answer' );
ok( strpos( (string) $state['reason'], home_url( '/wp-sitemap.xml' ) ) !== false, 'robots: the reason names the sitemap the site actually serves' );

// And the judgement is on the URL the file NAMES, not on wherever it redirects
// to. This boot has already flushed Morpheus's legacy-sitemap rewrite rule
// (above), so the removed plugin's path answers with a redirect — and a
// redirect-following check would call that healthy, which is precisely how the
// live site's robots.txt would keep advertising a location that is not its
// sitemap.
$legacy_direct = Morpheus_SEO::fetch_url( home_url( '/sitemap_index.xml' ), false );
$legacy_follow = Morpheus_SEO::fetch_url( home_url( '/sitemap_index.xml' ) );
ok( 200 !== $legacy_direct['code'], 'robots: the advertised sitemap URL does not itself answer 200' );
ok( 200 === $legacy_follow['code'], 'robots: …even though following the redirect reaches one (why the check must not follow)' );

// The health scan produces it as a finding WITH an action, under the id the app
// sends back to /fix. A finding with no registered action is counted unmapped,
// which is the gap this asserts is not there.
$scan_own = array();
foreach ( (array) Morpheus_Health::scan()['own_checks'] as $c ) {
	if ( ( $c['id'] ?? '' ) === 'morpheus_stale_robots_txt' ) { $scan_own = $c; }
}
ok( ! empty( $scan_own ), 'robots: the health scan reports the check' );
ok( ( $scan_own['status'] ?? '' ) === 'recommended', 'robots: a stale served file is a recommendation, not silence' );
ok( ( $scan_own['fix']['kind'] ?? '' ) === 'auto', 'robots: the finding carries an automatic fix' );
ok( ( $scan_own['fix']['label'] ?? '' ) === 'Quarantine the stale robots.txt', 'robots: the action is the quarantine' );
ok( ! empty( $scan_own['fix']['warning'] ), 'robots: the consequence is stated BEFORE the button' );

// ── the fix ────────────────────────────────────────────────────────────────

// 5. A file that is not the one being served is REFUSED: moving it would look
//    like a fix and change nothing.
$GLOBALS['morpheus_robots_probe'] = function ( $url ) use ( $stale_body ) {
	return strpos( $url, '/robots.txt' ) !== false ? "User-agent: *\nDisallow: /\n" : null;
};
$refused = Morpheus_Fixes::apply( 'morpheus_stale_robots_txt' );
ok( ( $refused['code'] ?? '' ) === 'NOT_SERVED', 'robots: the fix refuses a file that is not being served' );
ok( file_exists( $robots_file ), 'robots: …and moved nothing' );
ok( file_get_contents( $robots_file ) === $stale_body, 'robots: …leaving the file exactly as it was' );

// 6. The happy path: quarantine, verify, and the dynamic file is served after.
$GLOBALS['morpheus_robots_probe'] = null;
$res = Morpheus_Fixes::apply( 'morpheus_stale_robots_txt' );
ok( ! empty( $res['ok'] ) && ! empty( $res['verified'] ), 'robots: the fix reports a VERIFIED quarantine' );
ok( ! file_exists( $robots_file ), 'robots: the physical file is gone from the root' );
ok( ! empty( $res['backup'] ), 'robots: the result names a backup' );
ok( ! empty( $res['backup'] ) && file_exists( $res['backup'] ), 'robots: …which exists — QUARANTINED, not deleted' );
ok( preg_match( '#^robots\.txt\.morpheus-bak-\d{14}$#', basename( (string) $res['backup'] ) ) === 1, 'robots: …under the documented timestamped name' );
ok( strpos( (string) $res['did'], (string) $res['backup'] ) !== false, 'robots: the outcome says where the backup is' );

$live      = morpheus_live_robots();
$live_body = $live['body'];
ok( 200 === $live['code'], 'robots: the live /robots.txt still answers 200' );
ok( $live_body !== $stale_body, 'robots: the live /robots.txt is no longer the old file' );
ok( strpos( $live_body, 'YOAST' ) === false, 'robots: the leftover Yoast block is no longer served' );
ok( strpos( $live_body, 'Sitemap: ' . home_url( '/wp-sitemap.xml' ) ) !== false, 'robots: the dynamic robots.txt advertises the sitemap the site serves' );

// 7. A fix that CANNOT verify puts the file straight back. The probe makes the
//    site answer the cache-busting re-fetch with a body that is neither the old
//    file nor a robots.txt that advertises anything — which is what a genuinely
//    broken end state looks like.
//
//    This case accepts EITHER reason on purpose, and that tolerance is honest
//    about what it proves: its probe body fails on BOTH counts, so the sitemap
//    clause alone would catch it. It is about "a fix that cannot verify rolls
//    back", not about which branch decided. Case 7b below carries the specific
//    claim for the other branch — do not read this one as covering both.
@file_put_contents( $robots_file, $stale_body );
clearstatcache();
$GLOBALS['morpheus_robots_probe'] = function ( $url ) use ( $stale_body ) {
	return strpos( $url, 'morpheus-verify' ) !== false ? "User-agent: *\nDisallow: /\n" : $stale_body;
};
$rolled = Morpheus_Fixes::apply( 'morpheus_stale_robots_txt' );
ok( ( $rolled['verified'] ?? null ) === false, 'robots: a fix that cannot verify is NOT reported as verified' );
ok( ( $rolled['restored'] ?? null ) === true, 'robots: …and the file was put back' );
ok( file_exists( $robots_file ), 'robots: the file is back in the root' );
ok( file_get_contents( $robots_file ) === $stale_body, 'robots: …with its original contents' );
ok( strpos( (string) $rolled['error'], 'does not advertise' ) !== false || strpos( (string) $rolled['error'], 'still serving' ) !== false, 'robots: …and the failure says why' );
ok( ! empty( $rolled['backup'] ), 'robots: …and still names the file it used, so the operator can find it' );

// 7b. THE "STILL SERVING THE OLD FILE" BRANCH, ON ITS OWN.
//
// The site keeps handing back the bytes that were just moved AND those bytes
// advertise a live sitemap. That second half is the point: it leaves the sitemap
// clause with nothing to complain about, so the ONLY thing that can refuse this
// outcome is the comparison against the body that was quarantined. Delete that
// comparison and this run reports a VERIFIED fix while the file is still being
// served — a false success, which is the one thing this screen must never show.
//
// Asserting the reason matters as much as asserting the failure: a "does not
// advertise" here would mean the sitemap clause decided it and this case would
// be proving nothing about the branch it exists for.
$still_body = "User-agent: *\nDisallow: /wp-admin/\nSitemap: " . home_url( '/wp-sitemap.xml' ) . "\n";
@file_put_contents( $robots_file, $still_body );
clearstatcache();
$GLOBALS['morpheus_robots_probe'] = function ( $url ) use ( $still_body ) {
	// /robots.txt only: the sitemap fetches stay REAL, so the Sitemap line in
	// this body genuinely answers 200 and cannot be what decides the verdict.
	return strpos( $url, '/robots.txt' ) !== false ? $still_body : null;
};
$still_served = Morpheus_Fixes::apply( 'morpheus_stale_robots_txt' );
ok( ( $still_served['verified'] ?? null ) === false, 'robots: still serving the old file is NOT reported as verified' );
ok( ( $still_served['restored'] ?? null ) === true, 'robots: …and the file was put back' );
ok( file_exists( $robots_file ) && file_get_contents( $robots_file ) === $still_body, 'robots: …in the root, with its original contents' );
ok( strpos( (string) $still_served['error'], 'still serving' ) !== false, 'robots: …and the reason is the STILL-SERVING one' );
ok( strpos( (string) $still_served['error'], 'does not advertise' ) === false, 'robots: …NOT the sitemap clause, which this case isolates from' );

// Case 8 below builds on case 7's state, so put the stale body back.
@file_put_contents( $robots_file, $stale_body );
clearstatcache();

// 8. A warm cache must not undo a fix that worked: the old body is still handed
//    to a plain request, and the real dynamic file answers behind it.
$dynamic_body = (string) apply_filters( 'robots_txt', "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n", true );
$GLOBALS['morpheus_robots_probe'] = function ( $url ) use ( $stale_body, $dynamic_body ) {
	return strpos( $url, 'morpheus-verify' ) !== false ? $dynamic_body : $stale_body;
};
$cached = Morpheus_Fixes::apply( 'morpheus_stale_robots_txt' );
ok( ( $cached['verified'] ?? null ) === true, 'robots: a warm cache does not undo a fix that actually worked' );
ok( ! empty( $cached['note'] ), 'robots: …and the cache is reported rather than hidden' );

$GLOBALS['morpheus_robots_probe'] = null;
morpheus_clear_robots_backups();
@unlink( $robots_file );
clearstatcache();
delete_transient( 'morpheus_health_scan' );

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

wp_delete_post( $id, true );
wp_delete_post( $bare_id, true );
wp_delete_post( $post_id_t, true );
delete_option( 'morpheus_seo_defaults' );
// A write must clear the page cache: a cached page embeds the very title,
// description and links the module just changed, so without this the operator
// sees "Saved" and is still served the old HTML.
$log_before = @file_get_contents( MORPHEUS_STATE_DIR . '/deploy.log' );
@file_put_contents( MORPHEUS_STATE_DIR . '/deploy.log', '' );
seo_req( 'set_seo', array( 'id' => $page_id, 'seo_title' => 'Cache purge probe' ), $SECRET );
$log_after = (string) @file_get_contents( MORPHEUS_STATE_DIR . '/deploy.log' );
ok( strpos( $log_after, 'cache_purge' ) !== false, 'writes clear the page cache so the change is actually served' );
seo_req( 'get_seo', array( 'id' => $page_id ), $SECRET );
$probe_log = (string) @file_get_contents( MORPHEUS_STATE_DIR . '/deploy.log' );
ok( substr_count( $probe_log, 'cache_purge' ) === 1, 'a READ does not purge the cache' );
if ( $log_before !== false ) { @file_put_contents( MORPHEUS_STATE_DIR . '/deploy.log', $log_before ); }
wp_delete_post( $page_id, true );

delete_option( 'morpheus_settings' );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
