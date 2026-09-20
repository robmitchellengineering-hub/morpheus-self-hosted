<?php
/**
 * Exporting the active theme, so a site that is NOT in git can get a working
 * copy in one step.
 *
 * WHY THIS EXISTS
 *
 * Everything Morpheus does to a site's code goes through a GitHub repo: it
 * opens a pull request, CI runs, it merges, then the plugin applies the merge
 * commit. That means the operator has to already have their theme in a repo —
 * create one, copy the files in, point the plugin at it, make a token. For
 * someone whose site was set up by an agency, or who has never used git, that
 * is where the whole product stops.
 *
 * So the plugin can hand its own theme over instead: the app creates the repo
 * and commits what this returns. After that everything else is unchanged —
 * deploys still diff real commits, and nothing here is a special case.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 *
 *   * It exports ONLY the active theme, and if that is a child theme it says so
 *     and names the parent. The parent is a third-party theme that a deploy
 *     must not be allowed to overwrite; the child is where customisations live.
 *   * It sends TEXT ONLY. Images, fonts and archives are reported as skipped,
 *     not silently dropped, because a deploy only ever touches files a commit
 *     changed — so a repo without the media is a complete working copy for
 *     code, and nothing will delete them from the site. Saying that plainly
 *     beats copying 20MB of binaries into a repo nobody will diff.
 *   * It caps everything (files, per-file size, total, per-batch) and reports
 *     `truncated` when a cap bites, so a huge theme can never turn into a
 *     runaway request or a half-silent export.
 *
 * Paths are returned relative to ABSPATH (`wp-content/themes/<slug>/…`) because
 * that is exactly what the deploy adapter writes back to, so a file's path in
 * the repo is the same path on the site.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Export {

	const MAX_FILES        = 2000;
	const MAX_FILE_BYTES   = 1048576;   // 1 MB per file
	const MAX_TOTAL_BYTES  = 12582912;  // 12 MB for the whole theme
	const MAX_BATCH_FILES  = 200;
	const MAX_BATCH_BYTES  = 4194304;   // 4 MB per theme_files call

	// Never worth copying, and copying them is actively harmful.
	const SKIP_DIRS = array( '.git', 'node_modules', 'bower_components', '.sass-cache', 'vendor/.cache' );

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/export', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle' ),
		) );
	}

	public static function handle( WP_REST_Request $request ) {
		$body = Morpheus_REST::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		$action = isset( $body['action'] ) ? sanitize_key( $body['action'] ) : '';
		$data   = isset( $body['data'] ) && is_array( $body['data'] ) ? $body['data'] : array();

		morpheus_log( 'export', array( 'action' => $action ) );

		switch ( $action ) {
			case 'theme_tree':  $r = self::theme_tree(); break;
			case 'theme_files': $r = self::theme_files( $data ); break;
			default:
				return Morpheus_REST::err( 'unknown_action', "Unknown export action: {$action}", 400 );
		}

		if ( is_wp_error( $r ) ) {
			$d = $r->get_error_data();
			$s = is_array( $d ) && isset( $d['status'] ) ? $d['status'] : 422;
			return Morpheus_REST::err( $r->get_error_code(), $r->get_error_message(), $s );
		}
		return new WP_REST_Response( array_merge( array( 'ok' => true, 'action' => $action ), $r ), 200 );
	}

	/** The active theme: its slug, whether it is a child, and its parent. */
	public static function active_theme() {
		$theme  = wp_get_theme();
		$slug   = $theme->get_stylesheet();          // the ACTIVE one (child if there is one)
		$parent = $theme->get_template();            // the parent when a child is active
		return array(
			'slug'        => (string) $slug,
			'name'        => (string) $theme->get( 'Name' ),
			'version'     => (string) $theme->get( 'Version' ),
			'is_child'    => $parent !== $slug,
			'parent_slug' => $parent !== $slug ? (string) $parent : '',
			'dir'         => trailingslashit( get_theme_root( $slug ) ) . $slug,
		);
	}

	/**
	 * Every text file in the active theme, with a hash each.
	 *
	 * The hash is what lets the app tell "already identical" from "changed"
	 * without shipping the contents twice, and it is what makes a second export
	 * cheap.
	 */
	public static function theme_tree() {
		$theme = self::active_theme();
		$root  = $theme['dir'];
		if ( ! is_dir( $root ) ) {
			return new WP_Error( 'no_theme', 'The active theme directory could not be read.', array( 'status' => 500 ) );
		}

		$files     = array();
		$skipped   = array();
		$bytes     = 0;
		$truncated = false;

		$it = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $root, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::SELF_FIRST
		);
		foreach ( $it as $file ) {
			if ( $file->isDir() ) {
				continue;
			}
			$rel = ltrim( str_replace( $root, '', $file->getPathname() ), '/\\' );
			if ( self::should_skip( $rel ) ) {
				continue;
			}
			if ( count( $files ) >= self::MAX_FILES ) {
				$truncated = true;
				break;
			}
			$size = (int) $file->getSize();
			if ( $size > self::MAX_FILE_BYTES ) {
				$skipped[] = array( 'path' => $rel, 'reason' => 'larger than 1 MB' );
				continue;
			}
			if ( $bytes + $size > self::MAX_TOTAL_BYTES ) {
				$truncated = true;
				break;
			}
			if ( ! self::is_text_file( $file->getPathname(), $rel ) ) {
				$skipped[] = array( 'path' => $rel, 'reason' => 'not a text file' );
				continue;
			}
			$files[] = array(
				'path' => 'wp-content/themes/' . $theme['slug'] . '/' . $rel,
				'size' => $size,
				'hash' => (string) hash_file( 'sha256', $file->getPathname() ),
			);
			$bytes += $size;
		}

		usort( $files, function ( $a, $b ) { return strcmp( $a['path'], $b['path'] ); } );

		return array(
			'theme'     => array(
				'slug'        => $theme['slug'],
				'name'        => $theme['name'],
				'version'     => $theme['version'],
				'is_child'    => $theme['is_child'],
				'parent_slug' => $theme['parent_slug'],
			),
			'files'     => $files,
			'count'     => count( $files ),
			'bytes'     => $bytes,
			'skipped'   => array_slice( $skipped, 0, 100 ),
			'skipped_count' => count( $skipped ),
			'truncated' => $truncated,
			'limits'    => array(
				'max_files'       => self::MAX_FILES,
				'max_file_bytes'  => self::MAX_FILE_BYTES,
				'max_total_bytes' => self::MAX_TOTAL_BYTES,
			),
		);
	}

	/** Contents for a bounded batch of those paths. */
	public static function theme_files( $data ) {
		$paths = isset( $data['paths'] ) && is_array( $data['paths'] ) ? $data['paths'] : array();
		if ( ! $paths ) {
			return new WP_Error( 'no_paths', 'Provide paths: [...].', array( 'status' => 400 ) );
		}

		$theme = self::active_theme();
		$root  = $theme['dir'];
		$out   = array();
		$bytes = 0;
		$failed = array();

		foreach ( array_slice( $paths, 0, self::MAX_BATCH_FILES ) as $path ) {
			$rel = self::path_in_theme( (string) $path, $theme['slug'] );
			if ( is_wp_error( $rel ) ) {
				$failed[] = array( 'path' => $path, 'reason' => $rel->get_error_message() );
				continue;
			}
			$full = $root . '/' . $rel;
			if ( ! is_file( $full ) || ! is_readable( $full ) ) {
				$failed[] = array( 'path' => $path, 'reason' => 'not readable' );
				continue;
			}
			if ( ! self::is_text_file( $full, $rel ) ) {
				$failed[] = array( 'path' => $path, 'reason' => 'not a text file' );
				continue;
			}
			$size = (int) filesize( $full );
			if ( $size > self::MAX_FILE_BYTES ) {
				$failed[] = array( 'path' => $path, 'reason' => 'larger than 1 MB' );
				continue;
			}
			if ( $bytes + $size > self::MAX_BATCH_BYTES ) {
				break; // the caller asks again with the rest
			}
			$content = file_get_contents( $full );
			$out[] = array(
				'path'    => 'wp-content/themes/' . $theme['slug'] . '/' . $rel,
				'content' => (string) $content,
				'size'    => $size,
				'hash'    => hash( 'sha256', (string) $content ),
			);
			$bytes += $size;
		}

		return array(
			'files'    => $out,
			'count'    => count( $out ),
			'bytes'    => $bytes,
			'failed'   => $failed,
			'complete' => count( $out ) + count( $failed ) >= count( $paths ),
		);
	}

	// ── helpers ────────────────────────────────────────────────────────────

	/**
	 * Turn a repo-style path into a theme-relative one, or explain why not.
	 *
	 * The ONLY paths this endpoint will read are inside the active theme. A
	 * traversal, an absolute path, a backslash, a NUL byte, or another theme's
	 * directory is refused — this reads the filesystem on someone's live server,
	 * and "the caller sent a path" is not authorisation.
	 */
	public static function path_in_theme( $path, $slug ) {
		$p = trim( $path );
		if ( $p === '' ) {
			return new WP_Error( 'bad_path', 'empty path' );
		}
		if ( strpos( $p, "\0" ) !== false || strpos( $p, '\\' ) !== false ) {
			return new WP_Error( 'bad_path', 'illegal characters' );
		}
		$prefix = 'wp-content/themes/' . $slug . '/';
		if ( strpos( $p, $prefix ) !== 0 ) {
			return new WP_Error( 'outside_theme', 'not inside the active theme' );
		}
		$rel = substr( $p, strlen( $prefix ) );
		if ( $rel === '' || strpos( $rel, '..' ) !== false || $rel[0] === '/' ) {
			return new WP_Error( 'bad_path', 'not a relative path inside the theme' );
		}
		if ( self::should_skip( $rel ) ) {
			return new WP_Error( 'skipped', 'not part of the working copy' );
		}
		return $rel;
	}

	private static function should_skip( $rel ) {
		foreach ( self::SKIP_DIRS as $dir ) {
			if ( strpos( $rel, $dir . '/' ) === 0 || strpos( $rel, '/' . $dir . '/' ) !== false ) {
				return true;
			}
		}
		return false;
	}

	/** Binary detection that does not need the fileinfo extension. */
	private static function is_text_file( $full, $rel ) {
		$binary_ext = '#\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|eot|otf|mp[34]|m4a|wav|ogg|mov|avi|webm|pdf|zip|gz|tgz|rar|7z|exe|dll|so|dylib|psd|ai|sketch|mo|po|pot|jar|class|pyc|wasm)$#i';
		if ( preg_match( $binary_ext, $rel ) ) {
			return false;
		}
		$fh = @fopen( $full, 'rb' );
		if ( ! $fh ) {
			return false;
		}
		$chunk = (string) fread( $fh, 8192 );
		fclose( $fh );
		return strpos( $chunk, "\0" ) === false;
	}
}
