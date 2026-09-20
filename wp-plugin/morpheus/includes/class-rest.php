<?php
/**
 * The REST endpoint Morpheus calls: POST /wp-json/morpheus/v1/deploy
 *
 * Auth is the HMAC signature, not a WP login — the caller is a server, not
 * a user. permission_callback returns true and the handler verifies the
 * signature itself against the raw body (WP would otherwise re-encode it).
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_REST {

	const MAX_SKEW = 300; // seconds — reject a request whose `at` is older than this

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/deploy', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle_deploy' ),
		) );
		register_rest_route( MORPHEUS_REST_NS, '/rollback', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle_rollback' ),
		) );
		register_rest_route( MORPHEUS_REST_NS, '/status', array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle_status' ),
		) );
	}

	public static function handle_status() {
		$s = Morpheus_Settings::get();
		return new WP_REST_Response( array(
			'plugin'     => 'morpheus',
			'version'    => MORPHEUS_VERSION,
			'signing'    => (bool) $s['webhook_secret'],
			'deploy'     => array(
				'configured' => (bool) ( $s['repo'] && $s['webhook_secret'] ),
				'armed'      => (bool) $s['armed'],
				'repo'       => $s['repo'] ?: null,
				'branch'     => $s['branch'],
				'last'       => get_option( 'morpheus_deploy_last', null ),
			),
			'store'      => array(
				'available'   => class_exists( 'WooCommerce' ),
				'woocommerce' => defined( 'WC_VERSION' ) ? WC_VERSION : null,
			),
			// The SEO module is core to this plugin — no third-party SEO
			// plugin required — so `available` really means "this build has
			// it", which is how the panel knows whether to offer the SEO tab.
			// `owns_head` tells the operator whether Morpheus or another SEO
			// plugin is producing the tags (class-seo.php's duplicate-tag rule).
			'seo'        => array(
				'available'     => class_exists( 'Morpheus_SEO' ),
				'owns_head'     => class_exists( 'Morpheus_SEO' ) ? Morpheus_SEO::owns_head() : null,
				'active_plugin' => class_exists( 'Morpheus_SEO' ) ? Morpheus_SEO::active_plugin() : null,
			),
			// How the connect wizard knows this build supports pairing codes,
			// and whether the site is already connected. No code is exposed —
			// the code is the credential and only wp-admin shows it.
			'pairing'    => array(
				'available' => true,
				'paired'    => Morpheus_Pairing::is_paired(),
			),
			// Whether this build can hand its theme over as a working copy —
			// the wizard offers to create the repo only when it can.
			'export'     => array(
				'theme' => true,
			),
			// kept flat for older callers
			'configured' => (bool) ( $s['repo'] && $s['webhook_secret'] ),
			'armed'      => (bool) $s['armed'],
			'writes'     => (bool) $s['armed'],
		), 200 );
	}

	/**
	 * Shared front door for the signed POST endpoints (used by both the
	 * deploy and store modules): verify the HMAC over the raw body, check
	 * the replay window, and return the decoded body or a WP_REST_Response
	 * error.
	 */
	public static function verified_body( WP_REST_Request $request ) {
		$raw    = $request->get_body();
		$secret = Morpheus_Settings::get( 'webhook_secret' );
		$sig    = $request->get_header( 'X-Morpheus-Signature' );

		if ( ! $secret ) {
			return self::err( 'not_configured', 'The signing secret is not set in Settings → Morpheus.', 400 );
		}
		if ( ! morpheus_signature_ok( $raw, $secret, (string) $sig ) ) {
			morpheus_log( 'rejected', array( 'why' => 'bad signature', 'route' => $request->get_route() ) );
			return self::err( 'bad_signature', 'Signature verification failed.', 401 );
		}
		$body = json_decode( $raw, true );
		if ( ! is_array( $body ) ) {
			return self::err( 'bad_request', 'Body must be JSON.', 400 );
		}
		if ( ! empty( $body['at'] ) ) {
			$ts = strtotime( $body['at'] );
			if ( $ts && abs( time() - $ts ) > self::MAX_SKEW ) {
				return self::err( 'stale', 'Request timestamp is outside the allowed window.', 401 );
			}
		}
		return $body;
	}

	public static function handle_deploy( WP_REST_Request $request ) {
		$body = self::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		if ( empty( $body['commit'] ) ) {
			return self::err( 'bad_request', 'Body needs a "commit".', 400 );
		}
		$commit = preg_replace( '/[^0-9a-f]/i', '', (string) $body['commit'] );
		if ( strlen( $commit ) < 7 || strlen( $commit ) > 40 ) {
			return self::err( 'bad_request', 'commit must be a git SHA.', 400 );
		}
		$reason = isset( $body['reason'] ) ? sanitize_text_field( $body['reason'] ) : '';

		$settings = Morpheus_Settings::get();
		$deployer = new Morpheus_Deploy( $settings );

		// Armed → write; otherwise (or with ?dry=1) report only.
		$force_dry = $request->get_param( 'dry' ) || ! empty( $body['dry_run'] );
		$result    = ( $settings['armed'] && ! $force_dry )
			? $deployer->deploy( $commit, $reason )
			: $deployer->dry_run( $commit, $reason );

		if ( is_wp_error( $result ) ) {
			$data   = $result->get_error_data();
			$status = is_array( $data ) && isset( $data['status'] ) ? $data['status'] : 502;
			return self::err( $result->get_error_code(), $result->get_error_message(), $status, is_array( $data ) ? $data : array() );
		}

		// A rolled-back deploy is a real, reportable outcome — not an HTTP error.
		return new WP_REST_Response( $result, empty( $result['ok'] ) && empty( $result['rolled_back'] ) ? 502 : 200 );
	}

	public static function handle_rollback( WP_REST_Request $request ) {
		$body = self::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		$result = ( new Morpheus_Deploy( Morpheus_Settings::get() ) )->rollback_last();
		if ( is_wp_error( $result ) ) {
			$data   = $result->get_error_data();
			$status = is_array( $data ) && isset( $data['status'] ) ? $data['status'] : 502;
			return self::err( $result->get_error_code(), $result->get_error_message(), $status );
		}
		return new WP_REST_Response( $result, 200 );
	}

	public static function err( $code, $message, $status, array $extra = array() ) {
		return new WP_REST_Response( array_merge( array( 'ok' => false, 'error' => $code, 'message' => $message ), $extra ), $status );
	}
}
