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
 * Do two response bodies carry the same bytes, line endings aside?
 *
 * THE ONE DEFINITION OF "the URL is serving this file". Two places ask that
 * question — Morpheus_SEO::robots_txt_state() about a physical robots.txt, and
 * Morpheus_Clean::debug_log_state() about wp-content/debug.log — and an HTTP
 * status cannot answer it. A host whose front controller answers every path
 * under wp-content with 200 plus its own HTML page (a `try_files … /index.php`
 * rule, a custom 404 that returns 200, a WAF interstitial) serves a body for a
 * file that is not there at all. Comparing the bytes the URL returns with the
 * bytes on disk is the only test that survives that, so both callers share it.
 *
 * Line endings and trailing whitespace are normalised because a host or a proxy
 * can rewrite those on the way out without changing a single byte of meaning —
 * and a comparison one `\r` too strict would decide a served log is "not
 * served", which would miss a real leak. Everything else has to match.
 *
 * Moved out of Morpheus_SEO verbatim (2026-09-23); that method now delegates to
 * this, so the SEO side's behaviour is unchanged and there is still ONE
 * implementation of the rule.
 */
function morpheus_bodies_match( $a, $b ) {
	if ( ! is_string( $a ) || ! is_string( $b ) ) {
		return false;
	}
	$norm = function ( $s ) {
		return rtrim( str_replace( array( "\r\n", "\r" ), "\n", $s ) );
	};
	return $norm( $a ) === $norm( $b );
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

/**
 * The site's PUBLIC content types — the set the SEO and traffic modules work on.
 *
 * This was a hard-coded `array( 'post', 'page', 'product' )` in both modules until
 * 2026-10-08, and it is wrong for the site it runs on: the live store publishes a
 * `services` CPT whose head tags were being emitted all along (`emit_head()` keys
 * off `is_singular()`), while the panel could not list, audit or bulk-fill it, and
 * IndexNow was never told when one was published. The visible result was a services
 * page whose meta description was its own first words including "Home / Services /",
 * with nothing in the panel able to say so.
 *
 * ⚠️ AND IT FOLLOWS THE SITE'S OWN `public` FLAG, RATHER THAN SECOND-GUESSING IT.
 * The same theme also registers a `portfolio` archive, and it does NOT come out of
 * this function: WordPress's sitemap is built from exactly `public => true` types,
 * and on the live store `/wp-sitemap-posts-services-1.xml` answers 200 while
 * `…-portfolio-1.xml` answers 404. So `portfolio` is one the site itself keeps out
 * of the public web, and it stays out of the panel and out of what we submit to an
 * index. Listing it would mean overriding the site's own declaration — a product
 * decision, not a bug, and it is with Rob.
 *
 * Derived rather than assumed, because which types exist is a property of the
 * SITE, not of this plugin. What is NOT derived is what to leave out: WordPress
 * reports `attachment` as public, and an attachment has no title tag, no meta
 * description and no URL worth submitting to an index. The rest of the list is the
 * internals WordPress itself registers as public (`wp_block`, the template and
 * global-style types) — named rather than pattern-matched, so a plugin that adds
 * a `wp_`-prefixed post type of its own is not silently dropped.
 *
 * `post` and `page` are seeded first so the panel's familiar order survives, and
 * `post_type_exists` guards them: a site that removed pages still gets a sane list.
 *
 * @return string[] Post type names, `post` and `page` first, then the rest sorted.
 */
function morpheus_public_post_types() {
	// `public => true` IS NOT THE QUESTION.
	//
	// A page builder registers its own templates and blocks as public, and a real site's
	// IndexNow submissions came back with `?elementor_library=default-kit`,
	// `?cms_block=equipment-repair` and `woodmart_layout/product-archive-layout/` in them
	// (2026-10-08) — fifteen internal builder artefacts pinged to Bing and Yandex as if
	// they were pages, plus `/cart/`, `/my-account/` and `/wishlist/`.
	//
	// The question is "is this a URL a search engine should be told about?", and the
	// answer is three properties, none of which is `public`:
	//
	//   publicly_queryable     — it has a single view at all (a builder library does not);
	//   ! exclude_from_search  — the SITE has not asked to keep it out of search;
	//   a rewrite              — or get_permalink() hands back `?post_type=slug`, which
	//                            is the tell: a URL with no path is not a page.
	//
	// `post` and `page` are exempt from the rewrite test because their permalink comes
	// from the permalink structure rather than from the type's own rewrite argument.
	$not_content = array(
		'attachment',
		'revision',
		'nav_menu_item',
		'custom_css',
		'customize_changeset',
		'oembed_cache',
		'user_request',
		'wp_block',
		'wp_navigation',
		'wp_template',
		'wp_template_part',
		'wp_global_styles',
		'wp_font_family',
		'wp_font_face',
		'wp_pattern',
	);

	$out = array();
	foreach ( array( 'post', 'page' ) as $core ) {
		if ( post_type_exists( $core ) ) {
			$out[] = $core;
		}
	}

	$rest = array();
	foreach ( (array) get_post_types( array( 'public' => true ), 'objects' ) as $type ) {
		$name = isset( $type->name ) ? (string) $type->name : '';
		if ( '' === $name || in_array( $name, $out, true ) || in_array( $name, $not_content, true ) ) {
			continue;
		}
		if ( empty( $type->publicly_queryable ) ) {
			continue;
		}
		if ( ! empty( $type->exclude_from_search ) ) {
			continue;
		}
		if ( empty( $type->rewrite ) ) {
			continue;
		}
		$rest[] = $name;
	}
	sort( $rest );

	return array_merge( $out, $rest );
}

/**
 * Where WordPress actually writes its error log.
 *
 * The standard debug block is `define( 'WP_DEBUG_LOG', true )`, and TRUE means
 * `wp-content/debug.log` — INSIDE the web root, on every WordPress site, reachable
 * by anyone who asks unless the host happens to block it. It may also be a path,
 * and a site whose previous developer pointed it somewhere sensible logs there.
 *
 * WHY THIS FUNCTION EXISTS AT ALL. The reader used to open
 * `wp-content/debug.log` unconditionally and merely NOTE the configured path in a
 * footnote ("Morpheus reads the file CLEAN MY SITE judges served or not"). That was
 * survivable while nothing moved the log. It is not survivable now: the
 * "move the error log outside the web root" fix repoints `WP_DEBUG_LOG`, and
 * without a single shared resolver that fix would blind the reader it was written
 * for — a site would stop leaking its log and stop being able to read it, which is
 * a worse trade than the leak.
 *
 * WordPress's own rule, from `wp_debug_mode()`: a string is used as the path,
 * `true` means the content directory. Anything else (false, unset) means no file.
 */
function morpheus_debug_log_file() {
	$configured = defined( 'WP_DEBUG_LOG' ) ? WP_DEBUG_LOG : false;
	if ( is_string( $configured ) && '' !== $configured ) {
		return $configured;
	}
	return trailingslashit( WP_CONTENT_DIR ) . 'debug.log';
}

/**
 * The URL a file is reachable at, or null when nothing on the web can reach it.
 *
 * This is the question the whole relocate fix turns on: a log is safe to leave
 * logging exactly when no URL serves it. It is a CONTAINMENT test rather than a
 * guess from the filename — the file is reachable only if it sits under `ABSPATH`,
 * which is the only tree the site's front controller serves from.
 *
 * The default path is answered by `content_url()` rather than by the containment
 * test, deliberately: `WP_CONTENT_DIR` can be moved or symlinked, and the leak
 * check that has always asked about `wp-content/debug.log` must keep asking exactly
 * the same question it asked before.
 */
function morpheus_debug_log_url( $file ) {
	$file = wp_normalize_path( (string) $file );

	$default = trailingslashit( wp_normalize_path( WP_CONTENT_DIR ) ) . 'debug.log';
	if ( $file === $default ) {
		return content_url( 'debug.log' );
	}

	$root = trailingslashit( wp_normalize_path( ABSPATH ) );
	if ( '' !== $file && 0 === strpos( $file, $root ) ) {
		return site_url( '/' . ltrim( substr( $file, strlen( $root ) ), '/' ) );
	}

	// Outside the web root: no URL reaches it, which is the point of putting it there.
	return null;
}

