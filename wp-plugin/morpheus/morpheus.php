<?php
/**
 * Plugin Name:       Morpheus
 * Description:        Run your site from Morpheus — deploy code from a connected GitHub repo (no FTP), and manage products, stock and content over a signed API. Two modules: Deploy and Store.
 * Version:           0.4.3
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Morpheus (morpheus.nz)
 * License:           GPL-2.0-or-later
 *
 * The WordPress side of the Morpheus plugin (see the "Self-Dev as a Plugin"
 * scope doc). One plugin, two modules, one shared signed-request auth
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
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'MORPHEUS_VERSION', '0.4.3' );
define( 'MORPHEUS_DIR', plugin_dir_path( __FILE__ ) );
define( 'MORPHEUS_REST_NS', 'morpheus/v1' );

// Where the plugin keeps its own state (deploy log, snapshots, manifests).
// Inside wp-content but NOT under uploads — a deploy never touches this.
define( 'MORPHEUS_STATE_DIR', WP_CONTENT_DIR . '/morpheus-state' );

require_once MORPHEUS_DIR . 'includes/helpers.php';
require_once MORPHEUS_DIR . 'includes/class-settings.php';
require_once MORPHEUS_DIR . 'includes/class-rest.php';
require_once MORPHEUS_DIR . 'includes/deploy/class-github.php';
require_once MORPHEUS_DIR . 'includes/deploy/class-deploy.php';
require_once MORPHEUS_DIR . 'includes/store/class-store.php';

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
} );

add_action( 'admin_menu', array( 'Morpheus_Settings', 'register_menu' ) );
add_action( 'admin_init', array( 'Morpheus_Settings', 'register_settings' ) );
add_action( 'rest_api_init', array( 'Morpheus_REST', 'register_routes' ) );
add_action( 'rest_api_init', array( 'Morpheus_Store', 'register_routes' ) );
