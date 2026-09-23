<?php
/**
 * The dock — printed by the site itself, for the site's own administrator.
 *
 * WHAT THIS IS
 *
 * The Morpheus dock is a floating button that opens the Morpheus panel over any
 * page of this site. Until now the only way to get it there was to paste a
 * <script> tag into the theme (or a snippets plugin) by hand:
 *
 *   <script src="https://morpheus.nz/plugin.js" data-token="wgt_…" data-dock="1"></script>
 *
 * That copy lives in the theme, so a theme update takes it with it — and that
 * is exactly what happened on valiantmusic.com.au: `plugin.js` answered 200,
 * `/embed` answered 200, and the dock had simply stopped appearing, with
 * nothing on the site or in wp-admin saying why. The snippet was gone and
 * nothing replaced it.
 *
 * So the plugin prints it instead. A theme cannot delete a plugin. The tag goes
 * out on every page for an administrator and on no page for anybody else, and
 * Settings → Morpheus states plainly whether it is on and, when it is not, the
 * one reason why.
 *
 * THE SECURITY RULE, IN ONE PLACE
 *
 * The token is a credential: whoever receives it can act as the owner, scoped
 * to what the token grants. So the rule is not decoration — it is the reason
 * this file exists rather than a one-line hook. `should_print()` is the single
 * place that decides, and it is a **pure function of its arguments**, so
 * `tests/harness-dock.php` pins every branch (visitor, subscriber, editor,
 * administrator, feed, REST, AJAX, disabled, malformed token, http host)
 * without needing a request for each one.
 *
 * CACHING
 *
 * A page cache that stored an administrator's page and served it to a visitor
 * would hand that visitor the token. Caches normally skip logged-in users
 * anyway; this is the belt on top of the braces, because "normally" is doing a
 * lot of work in the one outcome that must never happen. DONOTCACHEPAGE and
 * DONOTCACHEOBJECT are the WordPress-wide convention (WP Rocket, W3 Total
 * Cache, WP Super Cache and others all honour them) and are set only on a
 * response that actually carries the tag.
 *
 * They are set here rather than via nocache_headers(): wp_footer runs after
 * output has begun, so sending headers at that point is a "headers already
 * sent" warning, while the constants are read by the cache when the finished
 * response is being written.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Dock {

	/** Where the loader lives when the site has not said otherwise. */
	const DEFAULT_HOST = 'https://morpheus.nz';

	/** A wrong host must fail closed, so the scheme is checked, not assumed. */
	const REQUIRE_SCHEME = '#^https://#i';

	public static function init() {
		// Late, so a theme or another plugin that queues scripts in wp_footer has
		// already done so — this tag must not be the thing that reorders a page.
		add_action( 'wp_footer', array( __CLASS__, 'maybe_print' ), 99 );
	}

	/**
	 * The token shape Morpheus issues today: `wgt_` + 48 hex characters
	 * (`server/src/lib/widgetToken.js`, `WIDGET_TOKEN_PREFIX + randomBytes(24)`).
	 *
	 * Deliberately a little looser than that — the point is to refuse anything
	 * that cannot be a token (empty, truncated, pasted with a quote or a space,
	 * an API key from the wrong field) without refusing the next token format
	 * for a reason a site owner cannot act on. `scripts/verify-dock.mjs`
	 * asserts this rule still admits what widgetToken.js generates.
	 *
	 * @param mixed $token
	 * @return bool
	 */
	public static function is_valid_token( $token ) {
		if ( ! is_string( $token ) ) {
			return false;
		}
		return (bool) preg_match( '/^wgt_[A-Za-z0-9_-]{16,96}$/', $token );
	}

	/**
	 * The loader URL, or '' when the host is unusable.
	 *
	 * HTTPS only, and that is not tidiness: the token travels in the query
	 * string, so an http:// loader would put a live credential on the wire in
	 * clear text on every page load.
	 *
	 * @param mixed $host
	 * @return string
	 */
	public static function loader_url( $host ) {
		if ( ! is_string( $host ) ) {
			return '';
		}
		$host = trim( $host );
		if ( $host === '' ) {
			return '';
		}
		$host = untrailingslashit( esc_url_raw( $host ) );
		if ( ! preg_match( self::REQUIRE_SCHEME, $host ) ) {
			return '';
		}
		return $host . '/plugin.js';
	}

	/**
	 * THE decision. Pure — every input is an argument, so every branch is
	 * testable without a WordPress request and there is exactly one place to
	 * read when asking "who can get this tag?".
	 *
	 * @param array $settings enabled (bool), token (string), host (string)
	 * @param array $context  logged_in, can_manage, is_admin, is_feed, is_rest, doing_ajax (all bool)
	 * @return bool
	 */
	public static function should_print( array $settings, array $context ) {
		if ( empty( $settings['enabled'] ) ) {
			return false;
		}
		if ( ! self::is_valid_token( isset( $settings['token'] ) ? $settings['token'] : '' ) ) {
			return false;
		}
		if ( self::loader_url( isset( $settings['host'] ) ? $settings['host'] : '' ) === '' ) {
			return false;
		}
		// The whole point: an administrator, and only an administrator.
		if ( empty( $context['logged_in'] ) || empty( $context['can_manage'] ) ) {
			return false;
		}
		// Responses that are not a page anyone looks at.
		if ( ! empty( $context['is_feed'] ) || ! empty( $context['is_rest'] ) || ! empty( $context['doing_ajax'] ) ) {
			return false;
		}
		if ( ! empty( $context['is_admin'] ) ) {
			return false;
		}
		return true;
	}

	/** The settings this class reads, in the shape should_print() wants. */
	public static function settings() {
		return array(
			'enabled' => 1 === (int) Morpheus_Settings::get( 'dock_enabled' ),
			'token'   => (string) Morpheus_Settings::get( 'widget_token' ),
			'host'    => (string) Morpheus_Settings::get( 'dock_host' ),
		);
	}

	/** The request this is, in the shape should_print() wants. */
	public static function context() {
		return array(
			'logged_in'  => is_user_logged_in(),
			'can_manage' => current_user_can( 'manage_options' ),
			'is_admin'   => is_admin(),
			'is_feed'    => is_feed(),
			'is_rest'    => defined( 'REST_REQUEST' ) && REST_REQUEST,
			'doing_ajax' => function_exists( 'wp_doing_ajax' ) && wp_doing_ajax(),
		);
	}

	/**
	 * Why the tag is not going out — the operator's answer, rendered on the
	 * settings screen. One reason, the first that applies, in the order that
	 * matters: a switched-off dock is not a broken one.
	 *
	 * Returns '' when the tag WILL be printed for an administrator.
	 *
	 * @param bool $for_this_request describe this request rather than the settings alone
	 * @return string
	 */
	public static function status_note( $for_this_request = true ) {
		$s = self::settings();
		if ( ! $s['enabled'] ) {
			return 'Off — the dock is not printed on any page.';
		}
		if ( trim( $s['token'] ) === '' ) {
			return 'On, but no token is saved — nothing is printed. Paste the embed token from Morpheus → WEBSITE → EMBED.';
		}
		if ( ! self::is_valid_token( $s['token'] ) ) {
			return 'On, but the saved token does not look like an embed token (it starts with "wgt_"). Nothing is printed.';
		}
		if ( self::loader_url( $s['host'] ) === '' ) {
			return 'On, but the Morpheus address must be a full https:// URL. Nothing is printed.';
		}
		if ( $for_this_request ) {
			$c = self::context();
			if ( ! $c['logged_in'] || ! $c['can_manage'] ) {
				return 'On and ready — this page is not printed for you only because you are not signed in as an administrator right now. Sign in and reload to see the dock.';
			}
		}
		return '';
	}

	/** Print the tag when, and only when, the decision says so. */
	public static function maybe_print() {
		$s = self::settings();
		$c = self::context();
		if ( ! self::should_print( $s, $c ) ) {
			return;
		}

		// This response carries a credential — see the note at the top of this
		// file. Set before output so every cache that honours the convention
		// writes nothing for it.
		if ( ! defined( 'DONOTCACHEPAGE' ) ) {
			define( 'DONOTCACHEPAGE', true );
		}
		if ( ! defined( 'DONOTCACHEOBJECT' ) ) {
			define( 'DONOTCACHEOBJECT', true );
		}

		$src = esc_url( self::loader_url( $s['host'] ) );
		printf(
			"<!-- Morpheus dock — printed by the Morpheus plugin for this administrator only. See Settings → Morpheus. -->\n" .
			"<script src=\"%s\" data-token=\"%s\" data-dock=\"1\"></script>\n",
			$src,
			esc_attr( $s['token'] )
		);
	}

	// ── one-tap setup ───────────────────────────────────────────────────────

	/**
	 * The signed route the owner's own Morpheus account uses to set this up.
	 *
	 * The manual route is "copy the embed token out of WEBSITE → EMBED and paste
	 * it into Settings → Morpheus by hand", which is a person carrying a
	 * credential between two screens — the step that ends with a live token in a
	 * chat transcript, and the step that goes wrong on a phone. The app already
	 * holds the token and already has a signed channel to this site, so it can
	 * do it here instead.
	 *
	 * SIGNED, like /deploy and /maintenance, and for a stronger reason than
	 * either: this WRITES the credential the dock acts as. An unsigned caller
	 * must not be able to point this site's dock at a token of their choosing.
	 */
	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/dock', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle' ),
		) );
	}

	/**
	 * What a caller is told about the dock.
	 *
	 * THE TOKEN IS NOT IN HERE, and that is the point of this method existing
	 * rather than callers assembling the array themselves: the echo is what
	 * would turn a write-only endpoint into a read of the site's credential.
	 * What comes back is what the settings screen shows its operator — on/off,
	 * whether it is actually configured, and the one-line verdict from
	 * status_note(), which is '' when the tag will print.
	 *
	 * @return array
	 */
	public static function state() {
		$s = self::settings();
		return array(
			'enabled'    => (bool) $s['enabled'],
			'configured' => self::is_valid_token( $s['token'] ) && self::loader_url( $s['host'] ) !== '',
			'note'       => self::status_note( false ),
		);
	}

	/**
	 * `get` reads the state, `set` writes it.
	 *
	 * Every refusal carries the same three fields a success does, so the app can
	 * show the site's own reason instead of a generic failure — the whole value
	 * of pushing from the app is that the operator sees what the SITE thinks.
	 */
	public static function handle( WP_REST_Request $request ) {
		$body = Morpheus_REST::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		$action = isset( $body['action'] ) ? sanitize_key( $body['action'] ) : '';

		// Never the token — see state().
		morpheus_log( 'dock', array( 'action' => $action, 'enabled' => ! empty( $body['enabled'] ) ) );

		if ( 'get' === $action ) {
			return new WP_REST_Response( array_merge( array( 'ok' => true ), self::state() ), 200 );
		}
		if ( 'set' === $action ) {
			return self::apply( $body );
		}
		return Morpheus_REST::err(
			'unknown_action',
			'The dock route handles "get" and "set".',
			400,
			self::state()
		);
	}

	/**
	 * `set` — validate first, write second, and refuse without writing anything.
	 *
	 * The token is judged by the SAME function the settings screen's verdict
	 * uses, so a token the screen would call invalid cannot arrive by push and
	 * be stored anyway. Turning it OFF is a first-class action, because a
	 * one-tap setup that cannot be undone from the same place is half a feature.
	 *
	 * @param array $body
	 * @return WP_REST_Response
	 */
	private static function apply( array $body ) {
		$o = Morpheus_Settings::get();

		if ( empty( $body['enabled'] ) ) {
			$o['dock_enabled'] = 0;
			update_option( Morpheus_Settings::OPTION, $o, false );
			return new WP_REST_Response( array_merge( array( 'ok' => true ), self::state() ), 200 );
		}

		$token = isset( $body['widget_token'] ) ? trim( (string) $body['widget_token'] ) : '';
		if ( ! self::is_valid_token( $token ) ) {
			return Morpheus_REST::err(
				'invalid_token',
				'That is not an embed token (they start with "wgt_"), so nothing was saved.',
				400,
				self::state()
			);
		}

		// The app may name the host it is served from; it is judged by the same
		// rule the screen uses, and a bad one is refused rather than stored.
		if ( isset( $body['host'] ) && trim( (string) $body['host'] ) !== '' ) {
			$host = trim( (string) $body['host'] );
			if ( self::loader_url( $host ) === '' ) {
				return Morpheus_REST::err(
					'invalid_host',
					'The Morpheus address must be a full https:// URL, so nothing was saved.',
					400,
					self::state()
				);
			}
			$o['dock_host'] = $host;
		}
		if ( self::loader_url( isset( $o['dock_host'] ) ? $o['dock_host'] : '' ) === '' ) {
			return Morpheus_REST::err(
				'invalid_host',
				'The saved Morpheus address is not a full https:// URL, so nothing was saved.',
				400,
				self::state()
			);
		}

		$o['widget_token'] = sanitize_text_field( $token );
		$o['dock_enabled'] = 1;
		update_option( Morpheus_Settings::OPTION, $o, false );

		return new WP_REST_Response( array_merge( array( 'ok' => true ), self::state() ), 200 );
	}
}
