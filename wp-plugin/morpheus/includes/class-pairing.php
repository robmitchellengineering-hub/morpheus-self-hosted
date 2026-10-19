<?php
/**
 * Pairing: connect this site to Morpheus with a one-time code.
 *
 * WHY THIS EXISTS
 *
 * Connecting used to be: invent a random string, paste it into Settings →
 * Morpheus, then type the same string into Morpheus by hand. Two manual copies
 * of a secret, one of them invented by the operator, on a phone, for every site
 * — and the SETUP panel could not tell the difference between "wrong secret"
 * and "wrong site URL" when it failed.
 *
 * So the plugin generates the secret instead, and shows a short code that
 * trades for it:
 *
 *   1. wp-admin → Settings → Morpheus shows a code (letters and digits, no
 *      look-alikes), valid for 20 minutes, usable once.
 *   2. The operator types the site URL and that code into Morpheus.
 *   3. Morpheus calls POST /wp-json/morpheus/v1/pair with the code. The plugin
 *      generates a strong secret, stores it, burns the code, and returns the
 *      secret over HTTPS. Both sides now hold the same value and the operator
 *      copied nothing.
 *
 * WHAT PROTECTS IT
 *
 *   * the code is the credential, so it is short-lived (20 minutes), single-use,
 *     and compared with hash_equals();
 *   * five wrong codes BURN the current code — an attacker guessing cannot keep
 *     grinding, they need an administrator to issue a new one;
 *   * independent of that, ten attempts per ten minutes per IP, so a bot cannot
 *     enumerate codes quickly;
 *   * only an administrator can see a code, and the endpoint never says whether
 *     the site is already paired (that is /status's business, and it says only
 *     a boolean);
 *   * the secret itself never appears in the admin screen, so shoulder-surfing
 *     a laptop cannot leak what actually signs requests.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Pairing {

	const OPTION       = 'morpheus_pairing';
	const TTL          = 1200;   // 20 minutes
	const MAX_FAILURES = 5;      // then the code must be reissued
	const RATE_OPTION  = 'morpheus_pairing_rate';
	const RATE_MAX     = 10;     // attempts
	const RATE_WINDOW  = 600;    // per 10 minutes

	// No I, L, O, 0 or 1 — a code gets read off one screen and typed into
	// another, usually on a phone, and those are the characters people confuse.
	const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/pair', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle' ),
		) );
	}

	/** Is a shared secret already set? */
	public static function is_paired() {
		return (string) Morpheus_Settings::get( 'webhook_secret' ) !== '';
	}

	/** The stored pairing state, normalised. */
	private static function state() {
		$s = get_option( self::OPTION, array() );
		$s = is_array( $s ) ? $s : array();
		return array(
			'code'       => isset( $s['code'] ) ? (string) $s['code'] : '',
			'created'    => isset( $s['created'] ) ? (int) $s['created'] : 0,
			'used'       => ! empty( $s['used'] ),
			'failures'   => isset( $s['failures'] ) ? (int) $s['failures'] : 0,
			'paired_at'  => isset( $s['paired_at'] ) ? (int) $s['paired_at'] : 0,
		);
	}

	public static function code_is_live( $state = null ) {
		$s = $state ?: self::state();
		return ! $s['used']
			&& $s['code'] !== ''
			&& $s['failures'] < self::MAX_FAILURES
			&& ( time() - $s['created'] ) < self::TTL;
	}

	public static function seconds_left( $state = null ) {
		$s = $state ?: self::state();
		if ( ! self::code_is_live( $s ) ) {
			return 0;
		}
		return max( 0, self::TTL - ( time() - $s['created'] ) );
	}

	/** Issue a fresh code. Called by the admin screen and when one expires. */
	public static function rotate() {
		$code = '';
		for ( $i = 0; $i < 8; $i++ ) {
			if ( $i === 4 ) {
				$code .= '-'; // easier to read back in fours
			}
			$code .= self::ALPHABET[ random_int( 0, strlen( self::ALPHABET ) - 1 ) ];
		}
		$prev = self::state();
		update_option( self::OPTION, array(
			'code'      => $code,
			'created'   => time(),
			'used'      => false,
			'failures'  => 0,
			'paired_at' => $prev['paired_at'],
		), false );
		morpheus_log( 'pairing_code_issued', array() );
		return $code;
	}

	/** The code to show on the admin screen, issuing one if needed. */
	public static function current_code() {
		$s = self::state();
		if ( self::code_is_live( $s ) ) {
			return $s['code'];
		}
		return self::rotate();
	}

	/** Forget the code and the shared secret (a deliberate disconnect). */
	public static function disconnect() {
		update_option( self::OPTION, array( 'code' => '', 'created' => 0, 'used' => true, 'failures' => 0, 'paired_at' => 0 ), false );
		$o = Morpheus_Settings::get();
		$o['webhook_secret'] = '';
		update_option( Morpheus_Settings::OPTION, $o, false );
		morpheus_log( 'pairing_disconnected', array() );
	}

	/** Per-IP attempt counter — stops a bot grinding codes quickly. */
	private static function rate_limited() {
		$key  = 'morpheus_pair_rl_' . substr( md5( (string) ( $_SERVER['REMOTE_ADDR'] ?? 'unknown' ) ), 0, 16 );
		$seen = get_transient( $key );
		$seen = is_array( $seen ) ? $seen : array( 'n' => 0, 'at' => time() );
		if ( ( time() - (int) $seen['at'] ) > self::RATE_WINDOW ) {
			$seen = array( 'n' => 0, 'at' => time() );
		}
		$seen['n']++;
		set_transient( $key, $seen, self::RATE_WINDOW );
		return $seen['n'] > self::RATE_MAX;
	}

	/**
	 * Trade a code for the shared secret.
	 *
	 * Returns the secret ONLY when the code is live and correct. Every failure
	 * mode returns the same shape of message: which part was wrong is not
	 * something an unauthenticated caller gets to learn.
	 */
	public static function handle( WP_REST_Request $request ) {
		$body = json_decode( (string) $request->get_body(), true );
		$body = is_array( $body ) ? $body : array();
		$code = isset( $body['code'] ) ? strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', (string) $body['code'] ) ) : '';

		if ( self::rate_limited() ) {
			morpheus_log( 'pair_rejected', array( 'why' => 'rate limited' ) );
			return Morpheus_REST::err( 'rate_limited', 'Too many attempts. Wait ten minutes and try again.', 429 );
		}

		$s       = self::state();
		$stored  = strtoupper( preg_replace( '/[^A-Za-z0-9]/', '', $s['code'] ) );
		$is_live = self::code_is_live( $s );

		if ( ! $is_live || $code === '' || $stored === '' || ! hash_equals( $stored, $code ) ) {
			// Count the failure that matters: a wrong code against a live one.
			if ( $is_live && $code !== '' ) {
				$s['failures']++;
				update_option( self::OPTION, array(
					'code'      => $s['code'],
					'created'   => $s['created'],
					'used'      => $s['failures'] >= self::MAX_FAILURES,
					'failures'  => $s['failures'],
					'paired_at' => $s['paired_at'],
				), false );
			}
			morpheus_log( 'pair_rejected', array( 'why' => $is_live ? 'wrong code' : 'no live code' ) );
			return Morpheus_REST::err(
				'invalid_code',
				$is_live
					? 'That code is not right. Check Settings → Morpheus in WordPress and use the code shown there.'
					: 'That code has expired or has already been used. Generate a new one in Settings → Morpheus.',
				403
			);
		}

		// Correct: mint the secret both sides will use, burn the code.
		$secret = bin2hex( random_bytes( 24 ) );
		$o = Morpheus_Settings::get();
		$o['webhook_secret'] = $secret;
		update_option( Morpheus_Settings::OPTION, $o, false );
		update_option( self::OPTION, array(
			'code'      => '',
			'created'   => 0,
			'used'      => true,
			'failures'  => 0,
			'paired_at' => time(),
		), false );

		morpheus_log( 'paired', array( 'version' => MORPHEUS_VERSION ) );

		return new WP_REST_Response( array(
			'ok'     => true,
			'paired' => true,
			// The one response that carries the secret. HTTPS is assumed — the
			// Morpheus side refuses a non-https site for exactly this reason.
			'secret' => $secret,
			'site'   => array(
				'url'     => home_url(),
				'name'    => get_bloginfo( 'name' ),
				'version' => MORPHEUS_VERSION,
			),
		), 200 );
	}
}
