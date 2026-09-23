<?php
/**
 * The dock: who gets the tag, and who must never get it.
 *
 * WHY THIS EXISTS
 *
 * The dock used to be a <script> tag pasted into the site's theme by hand, and
 * a theme update deleted it. The fix is that the plugin prints it — which turns
 * "a theme file went missing" into "a credential is being emitted by code we
 * control on every page of a live site". That is a much better place to be, but
 * only if the gate is right.
 *
 * So the gate is asserted from both ends:
 *
 *   * the pure decision — every branch, without a request for each one
 *   * the RENDERED footer — captured from wp_footer() for an administrator
 *     (tag present, token present, caching switched off) and for a visitor and
 *     an editor (no tag, no token substring anywhere in the output, and the
 *     site's page cache left ON, because switching it off for everyone would be
 *     a performance regression disguised as a security fix)
 *   * the settings round-trip — in particular that re-saving the screen with
 *     the token field showing dots does not wipe the stored token, which is the
 *     same trap the GitHub token and the shared secret already have
 *
 *   wp-playground-cli php \
 *     --auto-mount ./wp-plugin/morpheus \
 *     --mount ./wp-plugin/morpheus/tests:/tests \
 *     -- /tests/harness-dock.php
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

echo "\n== dock boot: fixtures ==\n";
ok( class_exists( 'Morpheus_Dock' ), 'dock class loaded' );
ok( class_exists( 'Morpheus_Settings' ), 'settings class loaded' );

// The shape Morpheus actually issues: 'wgt_' + 48 hex (widgetToken.js).
$TOKEN = 'wgt_' . str_repeat( 'a1b2c3d4', 6 );

// ── the pure decision ───────────────────────────────────────────────────────
echo "\n== the token rule ==\n";
ok( Morpheus_Dock::is_valid_token( $TOKEN ), 'the token Morpheus issues is accepted' );
ok( ! Morpheus_Dock::is_valid_token( '' ), 'empty is refused' );
ok( ! Morpheus_Dock::is_valid_token( 'wgt_short' ), 'a truncated token is refused' );
ok( ! Morpheus_Dock::is_valid_token( 'ghp_' . str_repeat( 'a', 40 ) ), 'a GitHub token pasted into the wrong field is refused' );
ok( ! Morpheus_Dock::is_valid_token( ' ' . $TOKEN ), 'a leading space (a copy-paste artefact) is refused' );
ok( ! Morpheus_Dock::is_valid_token( $TOKEN . '"' ), 'a trailing quote from the snippet is refused' );

echo "\n== the loader URL ==\n";
ok( Morpheus_Dock::loader_url( 'https://morpheus.nz' ) === 'https://morpheus.nz/plugin.js', 'a bare https host resolves to plugin.js' );
ok( Morpheus_Dock::loader_url( 'https://morpheus.nz/' ) === 'https://morpheus.nz/plugin.js', 'a trailing slash does not double up' );
ok( Morpheus_Dock::loader_url( 'http://morpheus.nz' ) === '', 'plain http is refused — the token travels in the clear' );
ok( Morpheus_Dock::loader_url( 'javascript:alert(1)' ) === '', 'a javascript: URL is refused' );
ok( Morpheus_Dock::loader_url( '' ) === '', 'an empty host is refused' );

echo "\n== the one decision, every branch ==\n";
$base_settings = array( 'enabled' => true, 'token' => $TOKEN, 'host' => 'https://morpheus.nz' );
$base_context  = array( 'logged_in' => true, 'can_manage' => true, 'is_admin' => false, 'is_feed' => false, 'is_rest' => false, 'doing_ajax' => false );

ok( Morpheus_Dock::should_print( $base_settings, $base_context ) === true, 'an administrator on a page gets it' );
ok( Morpheus_Dock::should_print( array_merge( $base_settings, array( 'enabled' => false ) ), $base_context ) === false, 'switched off, nothing is printed' );
ok( Morpheus_Dock::should_print( array_merge( $base_settings, array( 'token' => '' ) ), $base_context ) === false, 'no token, nothing is printed' );
ok( Morpheus_Dock::should_print( array_merge( $base_settings, array( 'token' => 'nope' ) ), $base_context ) === false, 'a malformed token, nothing is printed' );
ok( Morpheus_Dock::should_print( array_merge( $base_settings, array( 'host' => 'http://morpheus.nz' ) ), $base_context ) === false, 'an http host, nothing is printed' );
ok( Morpheus_Dock::should_print( $base_settings, array_merge( $base_context, array( 'logged_in' => false ) ) ) === false, 'a signed-out visitor gets nothing' );
ok( Morpheus_Dock::should_print( $base_settings, array_merge( $base_context, array( 'logged_in' => true, 'can_manage' => false ) ) ) === false, 'a signed-in editor/subscriber gets nothing' );
ok( Morpheus_Dock::should_print( $base_settings, array_merge( $base_context, array( 'is_feed' => true ) ) ) === false, 'a feed gets nothing' );
ok( Morpheus_Dock::should_print( $base_settings, array_merge( $base_context, array( 'is_rest' => true ) ) ) === false, 'a REST response gets nothing' );
ok( Morpheus_Dock::should_print( $base_settings, array_merge( $base_context, array( 'doing_ajax' => true ) ) ) === false, 'an AJAX response gets nothing' );
ok( Morpheus_Dock::should_print( $base_settings, array_merge( $base_context, array( 'is_admin' => true ) ) ) === false, 'wp-admin itself gets nothing' );

// ── settings round-trip ─────────────────────────────────────────────────────
echo "\n== settings ==\n";
delete_option( 'morpheus_settings' );
$saved = Morpheus_Settings::sanitize( array(
	'dock_enabled' => '1',
	'widget_token' => $TOKEN,
	'dock_host'    => 'morpheus.nz',
) );
ok( $saved['dock_enabled'] === 1, 'the checkbox saves as 1' );
ok( $saved['widget_token'] === $TOKEN, 'the token is stored' );
ok( $saved['dock_host'] === 'https://morpheus.nz', 'a bare host is given the https scheme, not stored bare' );
// Stored now, because the two checks below are about what a SECOND save does to
// a value that is already on disk — which is the actual screen behaviour.
update_option( 'morpheus_settings', $saved );

// Re-saving the screen: the field renders as dots, so what comes back is the
// mask. Treating that as a new token would silently replace the real one.
$again = Morpheus_Settings::sanitize( array(
	'dock_enabled' => '1',
	'widget_token' => Morpheus_Settings::mask( $TOKEN ),
	'dock_host'    => 'https://morpheus.nz',
) );
ok( $again['widget_token'] === $TOKEN, 're-saving with the masked field keeps the stored token' );
$blank = Morpheus_Settings::sanitize( array( 'dock_enabled' => '1', 'widget_token' => '', 'dock_host' => '' ) );
ok( $blank['widget_token'] === $TOKEN, 'saving with the token field empty keeps the stored token' );
ok( $blank['dock_host'] === 'https://morpheus.nz', 'clearing the host restores the default rather than printing nothing' );
update_option( 'morpheus_settings', $saved );

// ── the rendered footer, for real ───────────────────────────────────────────
echo "\n== the rendered footer ==\n";
$admin_id = 1;
wp_set_current_user( $admin_id );
ok( current_user_can( 'manage_options' ), 'user 1 really is an administrator in this boot' );

// Captured by calling our own hook body rather than by running all of
// wp_footer: WordPress and the admin bar queue their own footer scripts, and
// counting OUR output must not mean subtracting theirs. That the body is
// reached through the hook at all is asserted separately, immediately below,
// because a printer nobody calls is the exact failure this whole change fixes.
ok( has_action( 'wp_footer', 'Morpheus_Dock::maybe_print' ) === 99, 'the printer is registered on wp_footer at priority 99' );

/** Exactly what this plugin prints into the footer, and nothing else. */
function dock_footer() {
	ob_start();
	Morpheus_Dock::maybe_print();
	return (string) ob_get_clean();
}

// The editor and the visitor come FIRST, before anything is printed, because a
// response that carries no token must also leave the site's page cache alone:
// switching it off for every visitor would be a performance regression dressed
// up as a security fix. Once the administrator's print defines DONOTCACHEPAGE
// the constant cannot be un-defined, so this is the only order that can see it.

// The editor is the case the whole feature turns on: a signed-in user who is
// not an administrator must not receive a token that acts as the owner.
$editor_id = wp_insert_user( array(
	'user_login' => 'morpheus_dock_editor_' . wp_rand( 1000, 9999 ),
	'user_pass'  => wp_generate_password( 20 ),
	'user_email' => 'dock-editor-' . wp_rand( 1000, 9999 ) . '@example.test',
	'role'       => 'editor',
) );
ok( is_int( $editor_id ) && $editor_id > 0, 'an editor fixture was created' );
wp_set_current_user( $editor_id );
ok( ! current_user_can( 'manage_options' ), 'the editor cannot manage options' );
$editor_html = dock_footer();
ok( $editor_html === '', 'an editor gets nothing at all from us' );
ok( strpos( $editor_html, $TOKEN ) === false, 'an editor never sees the token' );
ok( ! defined( 'DONOTCACHEPAGE' ), 'an editor\'s page stays cacheable — the site is not slowed down for everyone' );

wp_set_current_user( 0 );
$guest_html = dock_footer();
ok( $guest_html === '', 'a signed-out visitor gets nothing at all from us' );
ok( strpos( $guest_html, $TOKEN ) === false, 'a visitor never sees the token' );
ok( ! defined( 'DONOTCACHEPAGE' ), 'a visitor\'s page stays cacheable' );

// …and now the administrator, whose page is the one that must not be stored.
wp_set_current_user( $admin_id );
$html = dock_footer();
ok( strpos( $html, 'plugin.js' ) !== false, 'an administrator gets the loader' );
ok( strpos( $html, 'data-dock="1"' ) !== false, 'the tag is the dock variant' );
ok( strpos( $html, 'data-token="' . $TOKEN . '"' ) !== false, 'the tag carries the token' );
ok( strpos( $html, 'src="https://morpheus.nz/plugin.js"' ) !== false, 'the tag loads from the configured host' );
ok( substr_count( $html, '<script' ) === 1, 'exactly one script tag — not one per hook' );
ok( defined( 'DONOTCACHEPAGE' ), 'a response carrying the token opts out of the page cache' );
ok( defined( 'DONOTCACHEOBJECT' ), 'and out of the object cache' );
ok( Morpheus_Dock::status_note( true ) === '', 'the settings screen says nothing is wrong when nothing is' );

// ── the operator's answer when it is not printing ───────────────────────────
echo "\n== why not ==\n";
update_option( 'morpheus_settings', array_merge( $saved, array( 'dock_enabled' => 0 ) ) );
ok( strpos( Morpheus_Dock::status_note( false ), 'Off' ) === 0, 'switched off, the screen says so first' );
update_option( 'morpheus_settings', array_merge( $saved, array( 'widget_token' => '' ) ) );
ok( strpos( Morpheus_Dock::status_note( false ), 'no token' ) !== false, 'no token, the screen says which field is missing' );
update_option( 'morpheus_settings', array_merge( $saved, array( 'widget_token' => 'not-a-token' ) ) );
ok( strpos( Morpheus_Dock::status_note( false ), 'wgt_' ) !== false, 'a malformed token, the screen says what one looks like' );
update_option( 'morpheus_settings', array_merge( $saved, array( 'dock_host' => 'http://morpheus.nz' ) ) );
ok( strpos( Morpheus_Dock::status_note( false ), 'https' ) !== false, 'an http host, the screen says why it is refused' );
update_option( 'morpheus_settings', $saved );
ok( Morpheus_Dock::status_note( false ) === '', 'and back to silence when it is fixed' );

// A screen that says "Ready" while nothing is printed is worse than no screen:
// it sends the operator looking at the theme, the cache and the browser, which
// is exactly the afternoon this change exists to end. So the note and the
// decision are asserted to be the same answer to the same question, over the
// settings an operator actually passes through.
echo "\n== the note and the decision cannot disagree ==\n";
$admin_ctx = array( 'logged_in' => true, 'can_manage' => true, 'is_admin' => false, 'is_feed' => false, 'is_rest' => false, 'doing_ajax' => false );
$matrix = array(
	'the shipped default (off)' => array(),
	'on, no token'              => array( 'dock_enabled' => 1 ),
	'on, a malformed token'     => array( 'dock_enabled' => 1, 'widget_token' => 'nope' ),
	'on, a token, an http host' => array( 'dock_enabled' => 1, 'widget_token' => $TOKEN, 'dock_host' => 'http://morpheus.nz' ),
	'on, a token, a good host'  => array( 'dock_enabled' => 1, 'widget_token' => $TOKEN, 'dock_host' => 'https://morpheus.nz' ),
);
foreach ( $matrix as $label => $overrides ) {
	update_option( 'morpheus_settings', array_merge( Morpheus_Settings::defaults(), $overrides ) );
	$would_print = Morpheus_Dock::should_print( Morpheus_Dock::settings(), $admin_ctx );
	$says_ready  = Morpheus_Dock::status_note( false ) === '';
	ok( $would_print === $says_ready, "the note agrees with the decision — $label" );
}

// Finally: the tag we print and the tag the loader reads are two halves of one
// contract, and the Node guard scripts/verify-dock.mjs compares them against
// public/plugin.js. Asserted there rather than here, because plugin.js is not
// inside the plugin directory this boot has mounted.

// Clean up, so the harness leaves the site as it found it. wp_delete_user()
// lives in wp-admin, which a CLI boot has not loaded — the WordPress card warns
// about exactly this class of admin-only helper.
delete_option( 'morpheus_settings' );
require_once ABSPATH . 'wp-admin/includes/user.php';
wp_delete_user( $editor_id );

echo "\n";
echo "==== $pass passed, $fail failed ====\n";
exit( $fail === 0 ? 0 : 1 );
