<?php
/**
 * Runs when the plugin is deleted (not just deactivated). Removes settings
 * and the plugin's own state directory. Never touches site files.
 */

if ( ! defined( 'WP_UNINSTALL_PLUGIN' ) ) {
	exit;
}

delete_option( 'morpheus_deploy_settings' );
delete_option( 'morpheus_deploy_last' );

$state = WP_CONTENT_DIR . '/morpheus-deploy-state';
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
