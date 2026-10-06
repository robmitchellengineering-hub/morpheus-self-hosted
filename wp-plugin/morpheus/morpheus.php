<?php
/**
 * Plugin Name:       Morpheus
 * Description:        Run your site from Morpheus — deploy code from a connected GitHub repo (no FTP), and manage products, stock, content and SEO over a signed API. Deploy, Store, SEO and Traffic, plus the admin-only Morpheus dock printed on the site itself.
 * Version:           0.8.6
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Morpheus (morpheus.nz)
 * License:           GPL-2.0-or-later
 *
 * The WordPress side of the Morpheus plugin (see the "Self-Dev as a Plugin"
 * scope doc). One plugin, three modules, one shared signed-request auth
 * (HMAC-SHA256 over the raw body, verified against a secret set here and on
 * the Morpheus side).
 *
 *  Deploy  — Morpheus opens a PR on the connected repo; once CI is green and
 *            it merges, a signed POST to /wp-json/morpheus/v1/deploy makes
 *            this plugin diff the merge commit, snapshot what it touches,
 *            write the changed files, health-check the site, and roll the
 *            snapshot back if anything breaks. Gated behind "Armed".
 *            The hard deny-list (wp-config.php, wp-content/uploads, cache,
 *            .git, .htaccess, .env) is enforced here regardless.
 *
 *  Store   — signed POST to /wp-json/morpheus/v1/store for WooCommerce and
 *            content actions (create a product, set stock, draft a post…),
 *            so the operator can run the shop from their phone through
 *            Morpheus. (Added in 0.4.)
 *
 *  SEO     — signed POST to /wp-json/morpheus/v1/seo: read and write every
 *            SEO field on any page/post/product, list content, read one item's
 *            text, and audit for real problems. Works with NO third-party SEO
 *            plugin (Morpheus emits the tags itself) and, when Yoast / Rank
 *            Math / AIOSEO / SEOPress is active, drives that plugin's own keys
 *            instead so two plugins never emit competing <title>/description
 *            tags.
 *
 *            Site-wide title/description templates (%title%, %sitename%,
 *            %tagline%, %excerpt%, %content%) fill the gap for content nobody
 *            has set by hand, with per-post-type overrides; bulk_apply_defaults
 *            writes them into items that have nothing set, which is the path
 *            that also works on a site where another SEO plugin owns the head.
 *            bulk_add_links proposes internal links and wraps a phrase that
 *            already exists in an item's text, dry-run first.
 *
 *            One-time pairing codes (Settings → Morpheus) replace inventing and
 *            retyping a shared secret in 0.5.4. The active theme can be exported
 *            as a text-only working copy in 0.5.5, so a site that is not in git
 *            still gets the full dev pipeline. readme.txt carries the same
 *            history for anyone reading this from the WordPress plugin screen.
 *
 *            Version history: module added in 0.5, read_content in 0.5.1,
 *            templates + internal links + the shared page-cache purge in 0.5.2,
 *            one-click updates (with a verified package hash) in 0.5.3,
 *            pairing codes in 0.5.4, theme export in 0.5.5, plugin details in
 *            0.5.6.
 *
 *  Dock    — the floating Morpheus button, printed on the site's own pages for
 *            a signed-in administrator and nobody else (0.8). It used to be a
 *            <script> tag pasted into the theme by hand, which a theme update
 *            silently deletes — the dock then "just stops appearing" with
 *            nothing anywhere saying why. A plugin cannot be deleted by a
 *            theme update, and Settings → Morpheus can now say whether the dock
 *            is on and, if not, the one reason. See includes/class-dock.php for
 *            the security rule and why the response is opted out of caching.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

// Must equal the `Version:` in this file's header and the readme's Stable tag.
// Three copies of one fact, so scripts/verify-pairing.mjs asserts all three agree.
//
// It drifted to 0.6.3 while the header said 0.6.4, and it is the value the REST
// status reports to Morpheus AND the value class-updates.php compares an update
// manifest against — so is_newer( '0.6.4', '0.6.3' ) stayed true and every site
// was offered an update it already had. class-updates.php warns about exactly
// that outcome in its own comment ("a stale response here would nag every site
// forever") and it was a stale CONSTANT, not a stale response.
define( 'MORPHEUS_VERSION', '0.8.6' );
define( 'MORPHEUS_DIR', plugin_dir_path( __FILE__ ) );
define( 'MORPHEUS_REST_NS', 'morpheus/v1' );

// Where the plugin keeps its own state (deploy log, snapshots, manifests).
// Inside wp-content but NOT under uploads — a deploy never touches this.
define( 'MORPHEUS_STATE_DIR', WP_CONTENT_DIR . '/morpheus-state' );

require_once MORPHEUS_DIR . 'includes/helpers.php';
require_once MORPHEUS_DIR . 'includes/class-settings.php';
require_once MORPHEUS_DIR . 'includes/class-rest.php';
require_once MORPHEUS_DIR . 'includes/class-updates.php';
require_once MORPHEUS_DIR . 'includes/class-pairing.php';
require_once MORPHEUS_DIR . 'includes/class-export.php';
require_once MORPHEUS_DIR . 'includes/class-health.php';
require_once MORPHEUS_DIR . 'includes/class-clean.php';
require_once MORPHEUS_DIR . 'includes/class-maintenance.php';
require_once MORPHEUS_DIR . 'includes/class-fixes.php';
require_once MORPHEUS_DIR . 'includes/deploy/class-github.php';
require_once MORPHEUS_DIR . 'includes/deploy/class-deploy.php';
require_once MORPHEUS_DIR . 'includes/store/class-store.php';
require_once MORPHEUS_DIR . 'includes/seo/class-seo.php';
require_once MORPHEUS_DIR . 'includes/class-traffic.php';
require_once MORPHEUS_DIR . 'includes/class-dock.php';

register_activation_hook( __FILE__, function () {
	if ( ! is_dir( MORPHEUS_STATE_DIR ) ) {
		wp_mkdir_p( MORPHEUS_STATE_DIR );
	}
	// Deny listing / direct access to the state dir.
	$htaccess = MORPHEUS_STATE_DIR . '/.htaccess';
	if ( ! file_exists( $htaccess ) ) {
		@file_put_contents( $htaccess, "Deny from all\n" );
	}
	if ( ! file_exists( MORPHEUS_STATE_DIR . '/index.php' ) ) {
		@file_put_contents( MORPHEUS_STATE_DIR . '/index.php', "<?php // Silence is golden.\n" );
	}
	// A key to host, and a rewrite rule to serve it: IndexNow authenticates the
	// submission with a file on the site, so both must exist before the first one.
	Morpheus_Traffic::activate();
} );

add_action( 'admin_menu', array( 'Morpheus_Settings', 'register_menu' ) );
add_action( 'admin_init', array( 'Morpheus_Settings', 'register_settings' ) );
add_action( 'admin_init', array( 'Morpheus_Settings', 'handle_pair_action' ) );
add_action( 'rest_api_init', array( 'Morpheus_REST', 'register_routes' ) );
add_action( 'rest_api_init', array( 'Morpheus_Store', 'register_routes' ) );
add_action( 'rest_api_init', array( 'Morpheus_SEO', 'register_routes' ) );
add_action( 'rest_api_init', array( 'Morpheus_Traffic', 'register_routes' ) );
add_action( 'rest_api_init', array( 'Morpheus_Pairing', 'register_routes' ) );
add_action( 'rest_api_init', array( 'Morpheus_Export', 'register_routes' ) );
// The one-tap dock setup the owner's own Morpheus account calls. Signed like the
// rest — see Morpheus_Dock::register_routes().
add_action( 'rest_api_init', array( 'Morpheus_Dock', 'register_routes' ) );
// Tag emission is registered on init and short-circuits when another SEO
// plugin is active — see Morpheus_SEO::bootstrap() for the duplicate-tag rule.
add_action( 'init', array( 'Morpheus_SEO', 'bootstrap' ) );
// The update channel: lets WordPress offer this plugin's own updates (checked
// and hash-verified) instead of the operator re-uploading a zip — see
// includes/class-updates.php.
Morpheus_Updates::init();
// Traffic: the IndexNow submission on publish and the ledger that proves it.
Morpheus_Traffic::init();
// Dock: the floating panel button, printed on the site's own pages — for a
// signed-in administrator only. See includes/class-dock.php.
Morpheus_Dock::init();
