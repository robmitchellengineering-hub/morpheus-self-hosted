<?php
/**
 * SECURITY — the handful of things a WordPress site gets wrong BY DEFAULT, and one switch
 * per thing.
 *
 * This is administration, not configuration: nothing here is a preference. WordPress ships
 * publishing its usernames, announcing its version, and sending no HSTS header, and all
 * three are the same kind of default — invisible, on every site, and closed by a few lines
 * that a person would have to know to write. Morpheus knows, and the operator should not
 * have to.
 *
 * WHY THIS IS A CLASS AND NOT A FIX. The fix machinery in class-fixes.php changes a FILE or
 * an OPTION and verifies it took. What it cannot do is keep a behaviour: a filter has to run
 * on every request afterwards. So the behaviour lives here, and BOTH of those things are
 * true or the feature is a lie:
 *
 *   1. every behaviour below is gated by an option, and OFF MEANS OFF — `init()` adds no hook
 *      at all unless the option is set, so "Morpheus is not hardening this site" is a fact
 *      about the request, not a claim in a panel;
 *   2. the fix writes that option through `set_option`, the SAME rail every other setting
 *      fix uses, so it is verified, reported and undoable by turning the option off.
 *
 * WHAT EACH ONE DOES NOT DO is written next to it. A hardening switch that overstates itself
 * is worse than none, because the operator stops looking.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Security {

	/** Stop anonymous username enumeration over REST and the `?author=N` probe. */
	const OPT_ENUMERATION = 'morpheus_hide_user_enumeration';

	/** Stop WordPress announcing its own version in the generator tag. */
	const OPT_VERSION = 'morpheus_hide_wp_version';

	/** HSTS max-age in seconds; 0 means the header is never sent. */
	const OPT_HSTS = 'morpheus_hsts_max_age';

	/**
	 * The max-age Morpheus offers: six months.
	 *
	 * NOT a year, and deliberately NOT `includeSubDomains` or `preload`. Those two are the
	 * parts that cannot be taken back quickly — a preloaded or subdomain-wide pin outlives
	 * the site that set it, and a subdomain this shop does not run today (mail, staging) can
	 * be broken by a header it never asked for. Six months with neither of them is the
	 * version whose worst case is "wait, or turn it off and wait".
	 */
	const HSTS_MAX_AGE = 15552000;

	/**
	 * Register only what is switched on.
	 *
	 * Safe to call twice — every hook below is idempotent — because the harness and any
	 * future settings screen both need to re-run it after a change.
	 */
	public static function init() {
		if ( self::enabled( self::OPT_ENUMERATION ) ) {
			add_filter( 'rest_endpoints', array( __CLASS__, 'restrict_user_endpoints' ) );
			add_action( 'template_redirect', array( __CLASS__, 'refuse_author_probe' ) );
		}
		if ( self::enabled( self::OPT_VERSION ) ) {
			remove_action( 'wp_head', 'wp_generator' );
			add_filter( 'the_generator', array( __CLASS__, 'empty_generator' ) );
		}
		if ( self::hsts_max_age() > 0 ) {
			add_action( 'send_headers', array( __CLASS__, 'send_hsts' ) );
		}
	}

	/** An option that means "on" only when it is really set. */
	private static function enabled( $option ) {
		return (bool) get_option( $option, false );
	}

	/**
	 * Is this SITE served over HTTPS — asked of the site, not of one request.
	 *
	 * ⚠️ THIS WAS `is_ssl()` AND THAT WAS WRONG, in the way that costs the most: it is not a
	 * preference, it is a fact about the REQUEST, and the two are different on every host
	 * that terminates TLS in front of PHP. `is_ssl()` reads `$_SERVER['HTTPS']`, which a
	 * proxy or a load balancer that forwards plain HTTP leaves unset or 'off' — so a site
	 * whose own address is `https://` and whose visitors are on HTTPS reports "not secure",
	 * and BOTH halves of this feature switched themselves off: the finding was never
	 * offered, and the header would never have been sent if it had been. Seen on the first
	 * real site this shipped to, which is the only reason it is written down.
	 *
	 * The site's own address is the authority — `home_url()` is what WordPress is configured
	 * to serve, and it is the thing HSTS is a statement about. `is_ssl()` stays as the second
	 * test because a site mid-migration (https addresses, still answering plain HTTP) should
	 * not be told it is insecure either.
	 */
	public static function site_is_https() {
		if ( is_ssl() ) {
			return true;
		}
		$scheme = wp_parse_url( home_url(), PHP_URL_SCHEME );
		return 'https' === strtolower( (string) $scheme );
	}

	/** The configured HSTS max-age, or 0 when it is off or unusable. */
	public static function hsts_max_age() {
		$max = (int) get_option( self::OPT_HSTS, 0 );
		return $max > 0 ? $max : 0;
	}

	/**
	 * Is the header ACTUALLY being served? 'served' · 'not_served' · 'unknown'.
	 *
	 * ⚠️ THE POINT OF ASKING. Setting an option proves nothing about what a visitor
	 * receives: the host, a proxy or a page cache sits between PHP and the browser, and any
	 * of them can drop a header this site asked for. Claiming "browsers are told to use
	 * HTTPS" on the strength of an option is exactly the kind of claim this plugin exists to
	 * stop making — so the check asks the site, and reports three answers, not two.
	 *
	 * 'unknown' is not a failure and must never be reported as 'not_served': a host that
	 * blocks loopback requests is common, and "I could not look" is a different sentence
	 * from "it is not there".
	 */
	public static function hsts_served() {
		if ( self::hsts_max_age() <= 0 ) {
			return 'not_served';
		}
		$cached = get_transient( 'morpheus_hsts_probe' );
		if ( is_string( $cached ) && '' !== $cached ) {
			return $cached;
		}

		$res = wp_remote_get(
			home_url( '/' ),
			array(
				'timeout'     => 10,
				'redirection' => 0,
				'headers'     => array( 'Cache-Control' => 'no-cache' ),
				// A self-signed or otherwise unusual certificate on the site's own address is
				// not what is being tested here, and refusing to look would report 'unknown'
				// on precisely the sites that need the answer.
				'sslverify'   => false,
			)
		);

		if ( is_wp_error( $res ) ) {
			$verdict = 'unknown';
		} else {
			$header  = wp_remote_retrieve_header( $res, 'strict-transport-security' );
			$verdict = ( is_string( $header ) && '' !== trim( $header ) ) ? 'served' : 'not_served';
		}

		// Short, because this is a probe and the answer changes the moment the host does.
		set_transient( 'morpheus_hsts_probe', $verdict, 5 * MINUTE_IN_SECONDS );
		return $verdict;
	}

	/**
	 * What the switches are set to, and whether HSTS is worth offering at all.
	 *
	 * ONE PLACE, so the checks, the panel and the fix registry cannot disagree about what is
	 * on — a settings screen that reads a different value from the one the filter tests is
	 * how a hardening toggle comes to say "on" while the site stays open.
	 */
	public static function state() {
		return array(
			'enumeration' => self::enabled( self::OPT_ENUMERATION ),
			'version'     => self::enabled( self::OPT_VERSION ),
			// HSTS is meaningless without HTTPS: browsers ignore the header over plain HTTP.
			'https'       => self::site_is_https(),
			'hsts'        => self::hsts_max_age(),
			// 'not_served' is the honest starting point when the switch is off.
			'hsts_served' => self::hsts_max_age() > 0 ? self::hsts_served() : 'not_served',
		);
	}

	// ── 1. Username enumeration ─────────────────────────────────────────────

	/**
	 * Anonymous requests lose the two user-listing REST routes.
	 *
	 * WordPress answers `/wp-json/wp/v2/users` with every author's id, display name, slug
	 * and avatar. That is an API meant for the block editor, and it is public by default:
	 * on this site it returned the admin account, and the slug it hands out is the value
	 * `/author/…/` resolves — so it is the login name for anyone who never changed it.
	 *
	 * ⚠️ WHAT IS REMOVED AND WHAT IS NOT. `/wp/v2/users` and `/wp/v2/users/<id>` go; the
	 * collection is what enumerates, and the single route merely does the same one at a
	 * time. `/wp/v2/users/me` STAYS — the editor, the admin and this plugin's own Dock all
	 * need it, and it only ever describes the caller to themselves. Signed-in requests are
	 * untouched entirely, which is why this is a filter on the anonymous case rather than a
	 * restriction on the route.
	 */
	public static function restrict_user_endpoints( $endpoints ) {
		if ( is_user_logged_in() || ! is_array( $endpoints ) ) {
			return $endpoints;
		}
		unset( $endpoints['/wp/v2/users'] );
		unset( $endpoints['/wp/v2/users/(?P<id>[\d]+)'] );
		return $endpoints;
	}

	/**
	 * `/?author=1`, `/?author=2` … is the other half, and the older one.
	 *
	 * WordPress resolves a numeric `author` query to that user's archive and redirects to
	 * it, which turns "guess an integer" into "read somebody's login name". Refused for
	 * anonymous requests, before the theme can answer.
	 *
	 * ⚠️ NOT DONE: the author archive at `/author/<slug>/` still resolves. Closing that
	 * means closing author archives entirely, which is a real behaviour change a multi-author
	 * site would miss, and it is not what "enumeration" means — this stops DISCOVERING the
	 * names, not reading one you already have. The finding says so too.
	 */
	public static function refuse_author_probe() {
		if ( is_user_logged_in() || is_admin() ) {
			return;
		}
		if ( ! isset( $_GET['author'] ) ) {
			return;
		}
		$author = is_scalar( $_GET['author'] ) ? (string) $_GET['author'] : '';
		if ( '' === $author || ! ctype_digit( $author ) ) {
			return;
		}
		wp_safe_redirect( home_url( '/' ), 301 );
		exit;
	}

	// ── 2. The version fingerprint ──────────────────────────────────────────

	/**
	 * Stop announcing the WordPress version.
	 *
	 * `<meta name="generator" content="WordPress 7.1.3">` is in the head of every page, put
	 * there by `wp_generator`, and it is the most direct version disclosure a WordPress site
	 * has — more so than `/readme.html`, which on a current install carries no version at
	 * all (checked against this site's own, which does not have one).
	 *
	 * `remove_action` handles the head tag; `the_generator` handles the same string in feeds
	 * and anywhere else core asks for it. Anything that still wants the version for its own
	 * use reads `get_bloginfo( 'version' )`, which this does not touch.
	 */
	public static function empty_generator() {
		return '';
	}

	// ── 3. HSTS ─────────────────────────────────────────────────────────────

	/**
	 * Tell the browser to use HTTPS for this host, for the configured window.
	 *
	 * ⚠️ WHY THIS IS A COMMITMENT AND WHY IT IS STILL WORTH MAKING. A browser that has seen
	 * this header refuses plain HTTP to this host until the max-age runs out, even if you
	 * turn the header off — turning it off stops renewing the pin, it does not remove it.
	 * That is the whole point (it is what closes the first-request downgrade), and it is why
	 * the value is six months rather than a year and why `includeSubDomains` and `preload`
	 * are not offered here.
	 *
	 * It is sent only where the SITE is served over HTTPS — asked via site_is_https(), not
	 * `is_ssl()`, for the reason written there: on a host that terminates TLS in front of
	 * PHP, `is_ssl()` reports the request as plain, and the header would never be sent on
	 * exactly the sites that need it. Over a genuinely plain-HTTP request the header is
	 * ignored by every browser anyway, so the wider test cannot pin a browser to a scheme
	 * the site is not already serving.
	 */
	public static function send_hsts() {
		$max = self::hsts_max_age();
		if ( $max <= 0 || ! self::site_is_https() || headers_sent() ) {
			return;
		}
		header( 'Strict-Transport-Security: max-age=' . $max );
	}

	/**
	 * Human-readable max-age, so a panel can say "six months" without inventing the number.
	 * Kept here rather than in the fix registry because it is the same fact.
	 */
	public static function describe_hsts() {
		$max = self::hsts_max_age();
		if ( $max <= 0 ) {
			return '';
		}
		$days = (int) round( $max / 86400 );
		return $days . ' day' . ( 1 === $days ? '' : 's' );
	}
}
