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

class Morpheus_Deploy_REST {

	const MAX_SKEW = 300; // seconds — reject a request whose `at` is older than this

	public static function register_routes() {
		register_rest_route( MORPHEUS_DEPLOY_REST_NS, '/deploy', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle_deploy' ),
		) );
		register_rest_route( MORPHEUS_DEPLOY_REST_NS, '/rollback', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle_rollback' ),
		) );
		register_rest_route( MORPHEUS_DEPLOY_REST_NS, '/status', array(
			'methods'             => 'GET',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle_status' ),
		) );
	}

	public static function handle_status() {
		$s = Morpheus_Deploy_Settings::get();
		return new WP_REST_Response( array(
			'plugin'     => 'morpheus-deploy',
			'version'    => MORPHEUS_DEPLOY_VERSION,
			'configured' => (bool) ( $s['repo'] && $s['deploy_secret'] ),
			'armed'      => (bool) $s['armed'],
			'writes'     => (bool) $s['armed'], // armed → the deploy endpoint writes files
			'repo'       => $s['repo'] ?: null,
			'branch'     => $s['branch'],
			'last'       => get_option( 'morpheus_deploy_last', null ),
		), 200 );
	}

	/**
	 * Shared front door for the signed POST endpoints: verify the HMAC over
	 * the raw body, check the replay window, and return the decoded body or
	 * a WP_REST_Response error.
	 */
	private static function verified_body( WP_REST_Request $request ) {
		$raw    = $request->get_body();
		$secret = Morpheus_Deploy_Settings::get( 'deploy_secret' );
		$sig    = $request->get_header( 'X-Morpheus-Signature' );

		if ( ! $secret ) {
			return self::err( 'not_configured', 'Deploy secret is not set.', 400 );
		}
		if ( ! morpheus_deploy_signature_ok( $raw, $secret, (string) $sig ) ) {
			morpheus_deploy_log( 'rejected', array( 'why' => 'bad signature', 'route' => $request->get_route() ) );
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

		$settings = Morpheus_Deploy_Settings::get();
		$deployer = new Morpheus_Deploy_Deployer( $settings );

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
		$result = ( new Morpheus_Deploy_Deployer( Morpheus_Deploy_Settings::get() ) )->rollback_last();
		if ( is_wp_error( $result ) ) {
			$data   = $result->get_error_data();
			$status = is_array( $data ) && isset( $data['status'] ) ? $data['status'] : 502;
			return self::err( $result->get_error_code(), $result->get_error_message(), $status );
		}
		return new WP_REST_Response( $result, 200 );
	}

	private static function err( $code, $message, $status, array $extra = array() ) {
		return new WP_REST_Response( array_merge( array( 'ok' => false, 'error' => $code, 'message' => $message ), $extra ), $status );
	}
}
