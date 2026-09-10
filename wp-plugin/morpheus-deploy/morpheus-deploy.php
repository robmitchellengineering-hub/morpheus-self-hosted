<?php
/**
 * Plugin Name:       Morpheus Deploy
 * Description:        Deploys code changes to this site from a connected GitHub repo — no FTP. Receives a signed webhook, pulls the changed files, writes them with PHP, health-checks the site, and rolls back automatically on failure.
 * Version:           0.2.0
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * Author:            Morpheus (morpheus.nz)
 * License:           GPL-2.0-or-later
 *
 * This is the deploy half of the Morpheus WordPress plugin (see the
 * "Self-Dev as a Plugin" scope doc). Morpheus builds the change, opens a PR
 * on the connected repo, and once CI is green and the PR merges, POSTs a
 * signed request to /wp-json/morpheus/v1/deploy. This plugin verifies the
 * signature, diffs the merge commit against its parent (GitHub compare, so
 * only the changed files are ever considered), snapshots what it's about to
 * touch, writes the changed files, health-checks the site, and restores the
 * snapshot automatically if anything breaks.
 *
 * Writing is gated behind the "Armed" setting. Off (default) → the deploy
 * endpoint reports what it *would* change and writes nothing. On → it
 * writes. The hard deny-list (wp-config.php, wp-content/uploads, cache,
 * .git, .htaccess, .env) is enforced in this plugin's code regardless.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'MORPHEUS_DEPLOY_VERSION', '0.2.0' );
define( 'MORPHEUS_DEPLOY_DIR', plugin_dir_path( __FILE__ ) );
define( 'MORPHEUS_DEPLOY_REST_NS', 'morpheus/v1' );

// Where this plugin keeps its own state (deploy log, snapshots, manifest).
// Inside wp-content but NOT under uploads — the deploy never touches this.
define( 'MORPHEUS_DEPLOY_STATE_DIR', WP_CONTENT_DIR . '/morpheus-deploy-state' );

require_once MORPHEUS_DEPLOY_DIR . 'includes/helpers.php';
require_once MORPHEUS_DEPLOY_DIR . 'includes/class-settings.php';
require_once MORPHEUS_DEPLOY_DIR . 'includes/class-github.php';
require_once MORPHEUS_DEPLOY_DIR . 'includes/class-deployer.php';
require_once MORPHEUS_DEPLOY_DIR . 'includes/class-rest.php';

register_activation_hook( __FILE__, function () {
	if ( ! is_dir( MORPHEUS_DEPLOY_STATE_DIR ) ) {
		wp_mkdir_p( MORPHEUS_DEPLOY_STATE_DIR );
	}
	// Deny listing / direct access to the state dir.
	$htaccess = MORPHEUS_DEPLOY_STATE_DIR . '/.htaccess';
	if ( ! file_exists( $htaccess ) ) {
		@file_put_contents( $htaccess, "Deny from all\n" );
	}
	if ( ! file_exists( MORPHEUS_DEPLOY_STATE_DIR . '/index.php' ) ) {
		@file_put_contents( MORPHEUS_DEPLOY_STATE_DIR . '/index.php', "<?php // Silence is golden.\n" );
	}
} );

add_action( 'admin_menu', array( 'Morpheus_Deploy_Settings', 'register_menu' ) );
add_action( 'admin_init', array( 'Morpheus_Deploy_Settings', 'register_settings' ) );
add_action( 'rest_api_init', array( 'Morpheus_Deploy_REST', 'register_routes' ) );
