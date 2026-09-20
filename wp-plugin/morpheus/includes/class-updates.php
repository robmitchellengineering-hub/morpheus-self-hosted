<?php
/**
 * One-click updates: let WordPress offer this plugin's own updates.
 *
 * WHY THIS EXISTS
 *
 * Installing the plugin by hand is unavoidable the first time — WordPress has
 * to run the installer, and nothing outside the site can write to its disk.
 * Every update after that should not need a human at all: the SETUP tab used to
 * tell the operator to download a zip and re-upload it with "Replace current
 * with uploaded", which is a chore nobody does promptly, leaving sites on old
 * builds (and old builds are what made the SEO module invisible on a live shop).
 *
 * So the plugin registers the standard WordPress update channel — the same
 * mechanism every commercial plugin uses. WordPress then lists the update on
 * its own Plugins screen, and "Update now" is one tap. WP unzips to a temp
 * directory and swaps it in, so a failed update leaves the working plugin in
 * place rather than a half-written one.
 *
 * THE HASH IS THE POINT
 *
 * A component that installs code over the network must not install whatever
 * arrives. The manifest (published by the app's build) carries the SHA-256 of
 * the zip, and the download is verified against it BEFORE WordPress unpacks it.
 * A mismatch aborts the update with a message the operator can act on. That is
 * what stops a tampered mirror, a truncated download, or a stale manifest from
 * silently becoming the code that runs on someone's shop.
 *
 * The manifest fetch is cached for a few hours so an admin page load never
 * waits on it.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Updates {

	const MANIFEST_URL = 'https://morpheus.nz/plugin-manifest.json';
	const CACHE_KEY    = 'morpheus_update_manifest';
	const CACHE_TTL    = 6 * HOUR_IN_SECONDS;

	/** The plugin's own basename, e.g. morpheus/morpheus.php. */
	public static function basename() {
		return plugin_basename( MORPHEUS_DIR . 'morpheus.php' );
	}

	public static function init() {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'offer_update' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_info' ), 10, 3 );
		add_filter( 'upgrader_pre_download', array( __CLASS__, 'verify_download' ), 10, 4 );
	}

	/**
	 * The published manifest, or null. Cached, and overridable for tests —
	 * tests/harness.php supplies a fixture through the filter rather than
	 * reaching the real morpheus.nz.
	 */
	public static function manifest( $force = false ) {
		if ( ! $force ) {
			$cached = get_transient( self::CACHE_KEY );
			if ( is_array( $cached ) ) {
				return $cached;
			}
			if ( 'none' === $cached ) {
				return null; // remembered miss — do not hammer the endpoint
			}
		}

		$url = apply_filters( 'morpheus_update_manifest_url', self::MANIFEST_URL );
		$res = wp_remote_get( $url, array( 'timeout' => 10, 'headers' => array( 'Accept' => 'application/json' ) ) );
		$data = null;
		if ( ! is_wp_error( $res ) && 200 === (int) wp_remote_retrieve_response_code( $res ) ) {
			$body = json_decode( wp_remote_retrieve_body( $res ), true );
			if ( is_array( $body ) && ! empty( $body['version'] ) ) {
				$data = $body;
			}
		}
		if ( $data ) {
			set_transient( self::CACHE_KEY, $data, self::CACHE_TTL );
		} else {
			// A miss is cached briefly too: a site whose host blocks outbound
			// requests would otherwise pay a 10-second timeout on every admin
			// page load.
			set_transient( self::CACHE_KEY, 'none', 15 * MINUTE_IN_SECONDS );
		}
		return $data;
	}

	/** Is `$remote` a newer version than the one running? */
	public static function is_newer( $remote, $local = MORPHEUS_VERSION ) {
		return version_compare( (string) $remote, (string) $local, '>' );
	}

	/**
	 * Offer the update to WordPress's own plugin list.
	 *
	 * Returned untouched when there is nothing newer — WordPress shows what it
	 * is told and nothing else, so a stale response here would nag every site
	 * forever.
	 */
	public static function offer_update( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}
		$manifest = self::manifest();
		if ( ! $manifest || empty( $manifest['version'] ) || ! self::is_newer( $manifest['version'] ) ) {
			return $transient;
		}
		if ( empty( $manifest['url'] ) ) {
			return $transient;
		}
		if ( ! isset( $transient->response ) || ! is_array( $transient->response ) ) {
			$transient->response = array();
		}

		$package = (string) $manifest['url'];
		$transient->response[ self::basename() ] = (object) array(
			'slug'         => 'morpheus',
			'plugin'       => self::basename(),
			'new_version'  => (string) $manifest['version'],
			'url'          => 'https://morpheus.nz',
			'package'      => $package,
			// Carried through to verify_download(); WordPress does not know or
			// care about these, so they ride along on the object.
			'morpheus_sha256' => isset( $manifest['sha256'] ) ? (string) $manifest['sha256'] : '',
			'morpheus_bytes'  => isset( $manifest['bytes'] ) ? (int) $manifest['bytes'] : 0,
		);

		// A plugin listed in `no_update` while also being in `response` is a
		// WordPress quirk that hides the update — keep them consistent.
		if ( isset( $transient->no_update[ self::basename() ] ) ) {
			unset( $transient->no_update[ self::basename() ] );
		}
		return $transient;
	}

	/** The "View version details" modal. */
	public static function plugin_info( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || 'morpheus' !== $args->slug ) {
			return $result;
		}
		$manifest = self::manifest();
		if ( ! $manifest || empty( $manifest['version'] ) ) {
			return $result;
		}
		return (object) array(
			'name'          => 'Morpheus',
			'slug'          => 'morpheus',
			'version'       => (string) $manifest['version'],
			'author'        => '<a href="https://morpheus.nz">Morpheus</a>',
			'homepage'      => 'https://morpheus.nz',
			'requires'      => isset( $manifest['requires'] ) ? (string) $manifest['requires'] : '6.0',
			'tested'        => isset( $manifest['tested'] ) ? (string) $manifest['tested'] : '',
			'requires_php'  => isset( $manifest['requires_php'] ) ? (string) $manifest['requires_php'] : '7.4',
			'download_link' => isset( $manifest['url'] ) ? (string) $manifest['url'] : '',
			'sections'      => array(
				'description' => '<p>Run your WordPress site from Morpheus: deploy code from a connected repository, manage products and content, and own your SEO — with or without another SEO plugin.</p>',
				'changelog'   => '<p>See the Morpheus changelog in the app. The update is verified against a published SHA-256 before it is installed.</p>',
			),
		);
	}

	/**
	 * Verify the downloaded package before WordPress unpacks it.
	 *
	 * `upgrader_pre_download` is the only hook that sees the archive itself: the
	 * download is fetched here, hashed, and either handed to WordPress as a
	 * local file (verified) or refused with a WP_Error (not verified). Only our
	 * own package is intercepted — every other plugin's update downloads
	 * normally.
	 *
	 * A package that cannot be verified is REFUSED, not installed. The first
	 * version of this fell through to WordPress's own download when the
	 * manifest carried no hash — which meant anything that could stop the
	 * plugin reading morpheus.nz (a blocked outbound request, a DNS problem, a
	 * tampered mirror) downgraded the site to installing an unchecked package.
	 * The refusal is the safe direction, and the message says how to recover.
	 */
	public static function verify_download( $reply, $package, $upgrader, $hook_extra = array() ) {
		if ( false !== $reply || ! is_string( $package ) || '' === $package ) {
			return $reply;
		}
		$manifest = self::manifest();
		$ours     = $manifest && ! empty( $manifest['url'] ) && untrailingslashit( (string) $manifest['url'] ) === untrailingslashit( $package );
		// Also intercept a package URL recorded on the update object, because a
		// store-cached transient (a site with an object cache) may carry the old
		// manifest's URL while the manifest has since been updated.
		if ( ! $ours && is_object( $upgrader ) && ! empty( $upgrader->skin ) ) {
			$ours = strpos( $package, 'morpheus-wordpress-plugin.zip' ) !== false;
		}
		if ( ! $ours ) {
			return $reply;
		}

		$expected = $manifest && ! empty( $manifest['sha256'] ) ? strtolower( (string) $manifest['sha256'] ) : '';
		if ( '' === $expected ) {
			morpheus_log( 'update_rejected', array( 'reason' => 'no published checksum available' ) );
			return new WP_Error(
				'morpheus_update_unverifiable',
				'The Morpheus update could not be verified — its published checksum was unavailable — so it was NOT installed. Try again in a few minutes; if it keeps happening, download the plugin from morpheus.nz and upload it manually.'
			);
		}

		if ( ! function_exists( 'download_url' ) ) {
			require_once ABSPATH . 'wp-admin/includes/file.php';
		}
		$tmp = download_url( $package, 60 );
		if ( is_wp_error( $tmp ) ) {
			return $tmp;
		}

		$actual = strtolower( (string) hash_file( 'sha256', $tmp ) );
		if ( $actual !== $expected ) {
			@unlink( $tmp );
			morpheus_log( 'update_rejected', array(
				'expected' => $expected,
				'actual'   => $actual,
			) );
			return new WP_Error(
				'morpheus_update_hash_mismatch',
				sprintf(
					'The Morpheus update did not match its published checksum (expected %s, got %s), so it was NOT installed. Try again; if it keeps happening, download the plugin from morpheus.nz and upload it manually.',
					substr( $expected, 0, 12 ) . '…',
					substr( $actual, 0, 12 ) . '…'
				)
			);
		}

		morpheus_log( 'update_verified', array( 'sha256' => $actual ) );
		return $tmp;
	}
}
