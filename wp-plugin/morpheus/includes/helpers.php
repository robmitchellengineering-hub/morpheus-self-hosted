<?php
/**
 * Pure helpers — path safety, the hard deny-list, git blob hashing, logging.
 * These are the security-critical bits; keep them small and obvious.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

/**
 * The hard deny-list. A deploy may NEVER create, modify, or delete any of
 * these, whatever the pushed tree contains — enforced here in PHP, not in
 * the repo's .gitignore. Mirrors server/src/lib/enginePolicy.js
 * PLUGIN_DENY_PATHS on the Morpheus side; this is the backstop.
 *
 * @param string $rel_path  repo-relative path, forward slashes, no leading slash
 * @return bool
 */
function morpheus_is_denied( $rel_path ) {
	$patterns = array(
		'#(^|/)wp-config\.php$#i',
		'#(^|/)\.env(\.|$)#i',
		'#(^|/)\.htaccess$#i',              // server config — WP manages its own section
		'#(^|/)wp-content/uploads(/|$)#i',   // the media library
		'#(^|/)wp-content/(cache|upgrade|upgrade-temp-backup|wp-rocket-config)(/|$)#i',
		'#(^|/)wp-content/morpheus-state(/|$)#i', // this plugin's own state
		'#(^|/)\.git(/|$)#i',
		'#(^|/)\.user\.ini$#i',
	);
	foreach ( $patterns as $re ) {
		if ( preg_match( $re, $rel_path ) ) {
			return true;
		}
	}
	return false;
}

/**
 * Is this repo-relative path safe to resolve under ABSPATH? Rejects
 * traversal, absolute paths, backslashes, NUL bytes, and anything that
 * escapes the site root once resolved.
 *
 * @param string $rel_path
 * @return bool
 */
function morpheus_path_is_safe( $rel_path ) {
	if ( ! is_string( $rel_path ) || $rel_path === '' ) {
		return false;
	}
	if ( strpos( $rel_path, "\0" ) !== false ) {
		return false;
	}
	if ( strpos( $rel_path, '\\' ) !== false ) {
		return false;
	}
	if ( $rel_path[0] === '/' ) {
		return false;
	}
	// no "." or ".." segments
	foreach ( explode( '/', $rel_path ) as $seg ) {
		if ( $seg === '.' || $seg === '..' || $seg === '' ) {
			return false;
		}
	}
	// once joined + normalised, it must still sit under ABSPATH
	$abs  = rtrim( ABSPATH, '/\\' );
	$full = $abs . '/' . $rel_path;
	$norm = morpheus_normalise( $full );
	return strpos( $norm, $abs . '/' ) === 0;
}

/**
 * Collapse "." and ".." in a path string without hitting the filesystem
 * (realpath() would fail for files that don't exist yet).
 */
function morpheus_normalise( $path ) {
	$parts = array();
	foreach ( explode( '/', str_replace( '\\', '/', $path ) ) as $seg ) {
		if ( $seg === '' || $seg === '.' ) {
			continue;
		}
		if ( $seg === '..' ) {
			array_pop( $parts );
			continue;
		}
		$parts[] = $seg;
	}
	$prefix = ( isset( $path[0] ) && $path[0] === '/' ) ? '/' : '';
	return $prefix . implode( '/', $parts );
}

/**
 * Git's blob object hash for a string — sha1("blob <len>\0<content>").
 * Matches gitBlobSha() on the Morpheus side, so the diff agrees.
 */
function morpheus_git_blob_sha( $content ) {
	$content = (string) $content;
	return sha1( 'blob ' . strlen( $content ) . "\0" . $content );
}

/**
 * Constant-time compare of the incoming signature against what we expect.
 *
 * @param string $raw_body   the exact request body bytes
 * @param string $secret     the shared deploy secret
 * @param string $header_sig value of the X-Morpheus-Signature header ("sha256=<hex>")
 * @return bool
 */
function morpheus_signature_ok( $raw_body, $secret, $header_sig ) {
	if ( ! is_string( $secret ) || $secret === '' || ! is_string( $header_sig ) ) {
		return false;
	}
	$expected = 'sha256=' . hash_hmac( 'sha256', $raw_body, $secret );
	return hash_equals( $expected, $header_sig );
}

/** Append a line to the deploy log (JSON-per-line). Best effort. */
function morpheus_log( $event, array $data = array() ) {
	$line = wp_json_encode( array_merge(
		array( 'at' => gmdate( 'c' ), 'event' => $event ),
		$data
	) );
	@file_put_contents(
		MORPHEUS_STATE_DIR . '/deploy.log',
		$line . "\n",
		FILE_APPEND | LOCK_EX
	);
}

/**
 * Clear every page/object cache we can find.
 *
 * A REST-context write does not invalidate a cached page by itself, and a
 * cached page contains the title, the meta description and the links — so the
 * operator would change something, see "Saved", and still be served the old
 * HTML. The store module needed this first; the SEO module needs it for exactly
 * the same reason. Every call is guarded by function_exists/has_action, so this
 * is a no-op on a site with no caching plugin.
 */
function morpheus_purge_caches() {
	if ( function_exists( 'wc_delete_product_transients' ) ) {
		wc_delete_product_transients();
	}
	if ( class_exists( 'WC_Cache_Helper' ) && method_exists( 'WC_Cache_Helper', 'get_transient_version' ) ) {
		WC_Cache_Helper::get_transient_version( 'product', true );
	}
	if ( function_exists( 'rocket_clean_domain' ) )        { rocket_clean_domain(); }        // WP Rocket
	if ( function_exists( 'w3tc_flush_all' ) )             { w3tc_flush_all(); }             // W3 Total Cache
	if ( function_exists( 'wp_cache_clear_cache' ) )       { wp_cache_clear_cache(); }       // WP Super Cache
	if ( function_exists( 'sg_cachepress_purge_cache' ) )  { sg_cachepress_purge_cache(); }  // SiteGround
	if ( has_action( 'litespeed_purge_all' ) )             { do_action( 'litespeed_purge_all' ); } // LiteSpeed
	if ( function_exists( 'wpo_cache_flush' ) )            { wpo_cache_flush(); }            // WP-Optimize
	wp_cache_flush(); // object cache
	morpheus_log( 'cache_purge', array() );
}
