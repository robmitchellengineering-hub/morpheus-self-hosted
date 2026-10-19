<?php
/**
 * Runs when the plugin is deleted (not just deactivated). Removes every store
 * the plugin keeps and its own state directory. Never touches site files.
 *
 * ⚠️ THE LIST MUST BE COMPLETE, AND THAT IS NOW A GATE RATHER THAN A HOPE.
 * Until 2026-10-08 this file removed two options (`morpheus_settings` and
 * `morpheus_deploy_last`) while five more survived, so delete-then-reinstall
 * inherited the previous site's SEO templates, fix history, pairing record and
 * traffic toggle — a fresh install that was not fresh, with nothing on screen
 * saying so. `scripts/verify-plugin-uninstall.mjs` walks the option constants in
 * `includes/` and fails if one is missing here, because "complete" stops being
 * something a reader can check by eye as the modules multiply.
 *
 * WordPress runs this file with the plugin NOT loaded, so the constants that
 * name these options (`Morpheus_Settings::OPTION`, `Morpheus_SEO::DEFAULTS_OPTION`
 * and the rest) cannot be referenced — they are spelled out as literals, and the
 * comment on each names the constant it must equal. That duplication is precisely
 * what the guard above exists to police.
 *
 * Transients are deliberately NOT deleted. Every one of them carries a TTL (the
 * longest, `morpheus_plugin_state_*`, is a day) and WordPress expires them on its
 * own, so listing them here would be a second, drift-prone list of keys that
 * mostly names keys this file cannot compute (they carry a per-IP or per-slug
 * hash). The options below never expire, which is why they are the ones that
 * have to go.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'morpheus_settings' );      // Morpheus_Settings::OPTION
delete_option( 'morpheus_deploy_last' );   // includes/deploy/class-deploy.php (a literal, not a constant)
delete_option( 'morpheus_seo_defaults' );  // Morpheus_SEO::DEFAULTS_OPTION
delete_option( 'morpheus_pairing' );       // Morpheus_Pairing::OPTION
delete_option( 'morpheus_pairing_rate' );  // Morpheus_Pairing::RATE_OPTION
delete_option( 'morpheus_fix_attempts' );  // Morpheus_Fixes::ATTEMPTS_OPTION
delete_option( 'morpheus_traffic' );       // Morpheus_Traffic::OPTION
delete_option( 'morpheus_redirects' );     // Morpheus_Redirects::OPTION
delete_option( 'morpheus_404_log' );       // Morpheus_Redirects::LOG_OPTION

// The traffic module registers a rewrite rule that serves the IndexNow key file.
// Deactivating does not remove it from the stored `rewrite_rules` option, and the
// plugin is not loaded here, so flushing now is what actually drops it — otherwise
// a 32-hex `.txt` path keeps routing to a query var nothing handles.
flush_rewrite_rules();

$state = WP_CONTENT_DIR . '/morpheus-state';
if ( is_dir( $state ) ) {
	$it = new RecursiveIteratorIterator(
		new RecursiveDirectoryIterator( $state, FilesystemIterator::SKIP_DOTS ),
		RecursiveIteratorIterator::CHILD_FIRST
	);
	foreach ( $it as $f ) {
		$f->isDir() ? @rmdir( $f->getPathname() ) : @unlink( $f->getPathname() );
	}
	@rmdir( $state );
}
