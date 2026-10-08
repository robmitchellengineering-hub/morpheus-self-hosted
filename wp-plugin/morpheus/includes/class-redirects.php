<?php
/**
 * Redirects and the 404 log.
 *
 * WHY THIS EXISTS. Nothing in this plugin managed a redirect: the only one was the
 * legacy SEO-plugin sitemap path. On a WooCommerce store that is the content-ops
 * feature that pays for itself — every product URL that changes, every retired
 * category, every campaign link, and every `?orderby=`/`?filter_…` variant a theme
 * invents is a URL that someone, somewhere, has already linked to. WordPress
 * answers all of them with a 404 unless something is watching.
 *
 * And nothing was watching: a 404 was invisible. The plugin could tell an operator
 * their files were fine and their SEO was set, while a hundred visitors a day hit a
 * dead product link and nothing anywhere recorded it.
 *
 * THE TWO HALVES, and they are one feature:
 *   * a rule list — from → to, with a real HTTP status, applied before the theme;
 *   * a 404 log — what was asked for and not found, grouped by path, bounded.
 * The log is what tells you which rule to write, so a 404 row is the input to a
 * redirect, not a separate report.
 *
 * ⚠️ THE ADMIN SURFACE IS NEVER REDIRECTABLE. A rule matching `wp-admin`, the login
 * form, the REST API or cron would lock the owner out of their own site with no way
 * back — the one failure here that cannot be fixed from inside WordPress. Those
 * paths are refused when a rule is saved AND ignored when a rule is matched, so a
 * rule that predates the check (or arrived by some other route) still cannot do it.
 *
 * ⚠️ AND THE LOG IS BOUNDED, WITH A DELIBERATE EVICTION POLICY. A 404 log fills up
 * fastest when a site is being scanned: a bot asking for a thousand unique paths
 * would evict every real broken link under a first-in-first-out cap. When the log is
 * full the entry with the FEWEST HITS is dropped, so a flood of one-off probes
 * cannot push out the URL that forty visitors a day are hitting.
 */
class Morpheus_Redirects {

	const OPTION     = 'morpheus_redirects';  // { enabled: bool, rules: [...] }
	const LOG_OPTION = 'morpheus_404_log';    // { rows: [...], total: int, since: iso }

	const MAX_RULES = 500;
	const MAX_LOG   = 200;      // distinct paths kept
	const LOG_DAYS  = 60;       // and nothing older than this
	const LOG_MAX_REFERRER = 200;

	/**
	 * Never redirectable, whatever the rules say. Compared against the normalised
	 * request path, so `wp-admin/` and `/wp-admin` are the same refusal.
	 */
	const PROTECTED = array(
		'wp-admin',
		'wp-login.php',
		'wp-json',
		'wp-cron.php',
		'xmlrpc.php',
		'wp-content/morpheus-state',
	);

	/** The statuses a rule may carry. 410 is a real answer, not a redirect. */
	const STATUSES = array( 301, 302, 307, 410 );

	/**
	 * A 404 storm must not turn into a write storm. When a path that is already in
	 * the log is hit again inside this window AND it is already the most recently
	 * written entry, the write is skipped — the counter is then a FLOOR under a
	 * flood, which is why the panel says "at least". A NEW path is always written.
	 */
	const LOG_THROTTLE_SECONDS = 2;

	// ── settings ────────────────────────────────────────────────────────────

	public static function init() {
		// Priority 1: before the theme, before canonical redirects and before core
		// decides what to render. A redirect that runs after output has started
		// cannot send a header at all.
		add_action( 'template_redirect', array( __CLASS__, 'maybe_redirect' ), 1 );
	}

	public static function defaults() {
		return array( 'enabled' => true, 'rules' => array() );
	}

	public static function settings() {
		$raw = get_option( self::OPTION, array() );
		$raw = is_array( $raw ) ? $raw : array();
		return array(
			'enabled' => ! isset( $raw['enabled'] ) || ! empty( $raw['enabled'] ),
			'rules'   => isset( $raw['rules'] ) && is_array( $raw['rules'] ) ? array_values( $raw['rules'] ) : array(),
		);
	}

	private static function save_settings( array $s ) {
		update_option( self::OPTION, array(
			'enabled' => ! empty( $s['enabled'] ),
			'rules'   => array_slice( array_values( $s['rules'] ), 0, self::MAX_RULES ),
		), false );
		return self::settings();
	}

	// ── paths ───────────────────────────────────────────────────────────────

	/**
	 * One shape for comparison: a leading slash, no query, no fragment, no doubled
	 * slashes, no trailing slash (except the root). The stored value is what the
	 * operator typed; THIS is what is matched, so `/old/` and `/old` are one rule.
	 */
	public static function normalise_path( $path ) {
		$path = (string) $path;
		$path = preg_replace( '/[?#].*$/', '', $path );
		$path = '/' . ltrim( $path, '/' );
		$path = preg_replace( '#/+#', '/', $path );
		if ( strlen( $path ) > 1 ) {
			$path = rtrim( $path, '/' );
		}
		return $path === '' ? '/' : $path;
	}

	/** The request path, the same shape. */
	private static function request_path() {
		$uri = isset( $_SERVER['REQUEST_URI'] ) ? (string) $_SERVER['REQUEST_URI'] : '/';
		return self::normalise_path( $uri );
	}

	/** Would this path hit the admin surface or the state directory? */
	public static function is_protected( $path ) {
		$p = ltrim( self::normalise_path( $path ), '/' );
		foreach ( self::PROTECTED as $prefix ) {
			if ( $p === $prefix || 0 === strpos( $p, $prefix . '/' ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Where a rule may point. A site-relative path, or an absolute http(s) URL —
	 * anything else is refused, because `javascript:` and `data:` in a Location
	 * header are how an operator's mistake becomes a security report.
	 */
	public static function safe_target( $to ) {
		$to = trim( (string) $to );
		if ( '' === $to ) {
			return false;
		}
		if ( 0 === strpos( $to, '//' ) ) {
			return false; // protocol-relative: an external host in disguise
		}
		if ( '/' === $to[0] ) {
			// A site-relative path, restricted to characters that are safe in a
			// Location header. `wp_validate_redirect` is not consulted here: it
			// exists to stop a Host-header attack, not to vet a path the operator
			// typed into their own admin, and its fallback would silently rewrite
			// the destination.
			return self::is_relative_ok( $to ) ? $to : false;
		}
		if ( preg_match( '#^https?://#i', $to ) ) {
			return $to;
		}
		return false;
	}

	private static function is_relative_ok( $path ) {
		return (bool) preg_match( '#^/[A-Za-z0-9\-._~!$&\'()*+,;=:@/%]*$#', $path );
	}

	// ── rules ───────────────────────────────────────────────────────────────

	public static function rules() {
		$s = self::settings();
		return $s['rules'];
	}

	/**
	 * Validate one rule. Returns the clean rule or a WP_Error naming what is wrong —
	 * every refusal is something the operator can act on, because "it did not save"
	 * is the worst answer a form can give.
	 */
	public static function clean_rule( array $in, array $existing = array(), $id = '' ) {
		$from = self::normalise_path( isset( $in['from'] ) ? $in['from'] : '' );
		if ( '/' === $from ) {
			return new WP_Error( 'bad_from', 'Enter the path to redirect — the home page cannot be redirected.' );
		}
		if ( self::is_protected( $from ) ) {
			return new WP_Error( 'protected_from', 'That path is part of the WordPress admin or the Morpheus state directory. Redirecting it could lock you out of your own site, so Morpheus will not.' );
		}
		$status = isset( $in['status'] ) ? (int) $in['status'] : 301;
		if ( ! in_array( $status, self::STATUSES, true ) ) {
			return new WP_Error( 'bad_status', 'Status must be one of ' . implode( ', ', self::STATUSES ) . '.' );
		}

		// ⚠️ 410 IS AN ANSWER, NOT A REDIRECT, SO IT CARRIES NO DESTINATION — and it is
		// returned BEFORE the destination rules apply. The first version validated
		// `to` first, which made a 410 impossible to create without inventing one: a
		// "Gone" rule with an empty destination was refused as `bad_to`. The harness
		// caught it; there is no way to see it from the code without reading the order.
		if ( 410 === $status ) {
			return array(
				'from'   => (string) ( isset( $in['from'] ) ? trim( (string) $in['from'] ) : '' ),
				'to'     => '',
				'status' => 410,
			);
		}

		$to = self::safe_target( isset( $in['to'] ) ? $in['to'] : '' );
		if ( false === $to ) {
			return new WP_Error( 'bad_to', 'Enter where it should go: a path on this site (starting with /) or a full https:// address.' );
		}

		$to_n = self::normalise_path( $to );
		if ( $to_n === $from ) {
			return new WP_Error( 'self_redirect', 'A redirect to itself is a loop, so it was not saved.' );
		}
		// The one cycle worth refusing outright: A→B while B→A already exists.
		// A longer ring is not detectable for free, which is why a rule can be
		// edited and deleted at any time.
		foreach ( $existing as $r ) {
			if ( ( $r['id'] ?? '' ) === $id ) {
				continue;
			}
			if ( self::normalise_path( $r['from'] ?? '' ) === $to_n && self::normalise_path( $r['to'] ?? '' ) === $from ) {
				return new WP_Error( 'loop', 'That would make a loop with the existing rule ' . $r['from'] . ' → ' . $r['to'] . '.' );
			}
		}

		return array(
			'from'   => (string) ( isset( $in['from'] ) ? trim( (string) $in['from'] ) : '' ),
			'to'     => $to,
			'status' => $status,
		);
	}

	public static function create( array $data ) {
		$s = self::settings();
		if ( count( $s['rules'] ) >= self::MAX_RULES ) {
			return new WP_Error( 'too_many', 'This site already has the maximum of ' . self::MAX_RULES . ' redirects. Delete one first.' );
		}
		$clean = self::clean_rule( $data, $s['rules'] );
		if ( is_wp_error( $clean ) ) {
			return $clean;
		}
		$from_n = self::normalise_path( $clean['from'] );
		foreach ( $s['rules'] as $r ) {
			if ( self::normalise_path( $r['from'] ?? '' ) === $from_n ) {
				return new WP_Error( 'duplicate', 'There is already a redirect for ' . $clean['from'] . '. Edit that one instead.' );
			}
		}
		$rule = array(
			'id'      => self::new_id(),
			'from'    => $clean['from'],
			'to'      => $clean['to'],
			'status'  => $clean['status'],
			'hits'    => 0,
			'created' => gmdate( 'c' ),
		);
		$s['rules'][] = $rule;
		self::save_settings( $s );
		morpheus_log( 'redirect_created', array( 'from' => $rule['from'], 'status' => $rule['status'] ) );
		return array( 'ok' => true, 'rule' => $rule, 'rules' => self::rules() );
	}

	public static function update( $id, array $data ) {
		$s = self::settings();
		$found = null;
		foreach ( $s['rules'] as $i => $r ) {
			if ( ( $r['id'] ?? '' ) === $id ) {
				$found = $i;
				break;
			}
		}
		if ( null === $found ) {
			return new WP_Error( 'not_found', 'That redirect no longer exists. Reload the panel.', array( 'status' => 404 ) );
		}
		$clean = self::clean_rule( $data, $s['rules'], $id );
		if ( is_wp_error( $clean ) ) {
			return $clean;
		}
		$s['rules'][ $found ]['from']   = $clean['from'];
		$s['rules'][ $found ]['to']     = $clean['to'];
		$s['rules'][ $found ]['status'] = $clean['status'];
		self::save_settings( $s );
		return array( 'ok' => true, 'rule' => $s['rules'][ $found ], 'rules' => self::rules() );
	}

	public static function delete( $id ) {
		$s = self::settings();
		$before = count( $s['rules'] );
		$s['rules'] = array_values( array_filter( $s['rules'], function ( $r ) use ( $id ) {
			return ( $r['id'] ?? '' ) !== $id;
		} ) );
		if ( count( $s['rules'] ) === $before ) {
			return new WP_Error( 'not_found', 'That redirect no longer exists. Reload the panel.', array( 'status' => 404 ) );
		}
		self::save_settings( $s );
		return array( 'ok' => true, 'rules' => self::rules() );
	}

	public static function set_enabled( $enabled ) {
		$s = self::settings();
		$s['enabled'] = (bool) $enabled;
		self::save_settings( $s );
		return array( 'ok' => true, 'enabled' => $s['enabled'] );
	}

	private static function new_id() {
		return substr( md5( uniqid( (string) mt_rand(), true ) ), 0, 12 );
	}

	// ── applying a rule ─────────────────────────────────────────────────────

	/**
	 * The front-end half. Runs on every request, so it does nothing until a rule
	 * exists: no rules means one option read and a return.
	 */
	public static function maybe_redirect() {
		if ( is_admin() || ( defined( 'REST_REQUEST' ) && REST_REQUEST ) ) {
			return;
		}
		$path = self::request_path();

		// The protection is applied HERE as well as at save time. A rule that
		// somehow got into the option can still not take the owner out of wp-admin.
		if ( self::is_protected( $path ) ) {
			return;
		}

		$s = self::settings();
		if ( ! empty( $s['enabled'] ) && ! empty( $s['rules'] ) ) {
			foreach ( $s['rules'] as $r ) {
				if ( self::normalise_path( $r['from'] ?? '' ) !== $path ) {
					continue;
				}
				self::bump_hits( $r['id'] ?? '' );
				$status = (int) ( $r['status'] ?? 301 );
				if ( 410 === $status ) {
					// Gone, not a redirect: tell the crawler the page is finished and
					// let the theme render its own 404 body under that status.
					global $wp_query;
					if ( $wp_query instanceof WP_Query ) {
						$wp_query->set_404();
					}
					status_header( 410 );
					nocache_headers();
					return;
				}
				$to = (string) ( $r['to'] ?? '' );
				if ( '' === $to ) {
					return;
				}
				// An external destination is deliberate (a domain move, a partner
				// page) and `wp_safe_redirect` would rewrite it to wp-admin, so the
				// choice is explicit rather than accidental.
				if ( preg_match( '#^https?://#i', $to ) && wp_parse_url( $to, PHP_URL_HOST ) !== wp_parse_url( home_url(), PHP_URL_HOST ) ) {
					wp_redirect( $to, $status, 'Morpheus' );
				} else {
					wp_safe_redirect( $to, $status, 'Morpheus' );
				}
				exit;
			}
		}

		if ( is_404() ) {
			self::record_404( $path );
		}
	}

	/** A rule's own count, so the panel can say which ones are actually working. */
	private static function bump_hits( $id ) {
		if ( '' === $id ) {
			return;
		}
		$s = self::settings();
		$changed = false;
		foreach ( $s['rules'] as $i => $r ) {
			if ( ( $r['id'] ?? '' ) === $id ) {
				$s['rules'][ $i ]['hits'] = (int) ( $r['hits'] ?? 0 ) + 1;
				$s['rules'][ $i ]['last_at'] = gmdate( 'c' );
				$changed = true;
				break;
			}
		}
		if ( $changed ) {
			// Deliberately quiet: a redirect hit is the product working, not an event
			// worth a log line per request.
			update_option( self::OPTION, array( 'enabled' => $s['enabled'], 'rules' => $s['rules'] ), false );
		}
	}

	// ── the 404 log ─────────────────────────────────────────────────────────

	private static function log_state() {
		$raw = get_option( self::LOG_OPTION, array() );
		$raw = is_array( $raw ) ? $raw : array();
		return array(
			'rows'  => isset( $raw['rows'] ) && is_array( $raw['rows'] ) ? array_values( $raw['rows'] ) : array(),
			'total' => isset( $raw['total'] ) ? (int) $raw['total'] : 0,
			'since' => isset( $raw['since'] ) ? (string) $raw['since'] : gmdate( 'c' ),
		);
	}

	private static function write_log( array $state ) {
		update_option( self::LOG_OPTION, array(
			'rows'  => array_slice( array_values( $state['rows'] ), 0, self::MAX_LOG ),
			'total' => (int) $state['total'],
			'since' => (string) $state['since'],
		), false );
	}

	/**
	 * Record one 404, grouped by path.
	 *
	 * The policy, all three parts deliberate:
	 *   * GROUPED BY PATH — a thousand hits on one dead link is one row with a
	 *     count, not a thousand rows;
	 *   * BOUNDED, EVICTING THE LEAST-HIT — a scanner asking for a thousand unique
	 *     paths must not push out the URL forty visitors a day are hitting;
	 *   * THROTTLED — a storm is not a reason to write an option on every request,
	 *     and the throttle is why BOTH counters here are FLOORS under a flood
	 *     rather than exact totals. The panel says "at least" for that reason.
	 *
	 * PUBLIC so the harness can drive it: the eviction policy is the part that has to
	 * be right, and proving it through a real 404 would need an HTTP request the
	 * Playground boot does not have.
	 */
	public static function record_404( $path ) {
		$state = self::log_state();
		$now   = time();

		$index = null;
		foreach ( $state['rows'] as $i => $row ) {
			if ( ( $row['path'] ?? '' ) === $path ) {
				$index = $i;
				break;
			}
		}

		$last_write = isset( $state['rows'][0]['last_ts'] ) ? (int) $state['rows'][0]['last_ts'] : 0;
		if ( null !== $index && 0 === $index && ( $now - $last_write ) < self::LOG_THROTTLE_SECONDS ) {
			// The busiest path, hit again immediately. Dropped entirely rather than
			// counted in memory: a count that is persisted nowhere but displayed
			// somewhere is worse than a counter that admits it is a floor.
			return;
		}

		$state['total']++;

		$referrer = '';
		if ( ! empty( $_SERVER['HTTP_REFERER'] ) ) {
			$referrer = mb_substr( esc_url_raw( wp_unslash( (string) $_SERVER['HTTP_REFERER'] ) ), 0, self::LOG_MAX_REFERRER );
		}

		if ( null === $index ) {
			$row = array(
				'path'     => $path,
				'hits'     => 1,
				'first_at' => gmdate( 'c' ),
				'last_at'  => gmdate( 'c' ),
				'last_ts'  => $now,
				'referrer' => $referrer,
			);
			array_unshift( $state['rows'], $row );
		} else {
			$state['rows'][ $index ]['hits']    = (int) ( $state['rows'][ $index ]['hits'] ?? 0 ) + 1;
			$state['rows'][ $index ]['last_at'] = gmdate( 'c' );
			$state['rows'][ $index ]['last_ts'] = $now;
			if ( '' === (string) ( $state['rows'][ $index ]['referrer'] ?? '' ) && '' !== $referrer ) {
				$state['rows'][ $index ]['referrer'] = $referrer;
			}
			// Keep the busiest first so the throttle above always looks at row 0.
			$state['rows'] = self::sort_rows( $state['rows'] );
		}

		$state['rows'] = self::prune_rows( $state['rows'] );
		self::write_log( $state );
	}

	/** Most hits first, then most recent. The eviction order and the reading order. */
	private static function sort_rows( array $rows ) {
		usort( $rows, function ( $a, $b ) {
			$ha = (int) ( $a['hits'] ?? 0 );
			$hb = (int) ( $b['hits'] ?? 0 );
			if ( $ha === $hb ) {
				return strcmp( (string) ( $b['last_at'] ?? '' ), (string) ( $a['last_at'] ?? '' ) );
			}
			return $hb - $ha;
		} );
		return array_values( $rows );
	}

	/** Drop what is older than LOG_DAYS, then the least-hit until it fits. */
	private static function prune_rows( array $rows ) {
		$cutoff = time() - ( self::LOG_DAYS * DAY_IN_SECONDS );
		$rows   = array_values( array_filter( $rows, function ( $r ) use ( $cutoff ) {
			$ts = isset( $r['last_ts'] ) ? (int) $r['last_ts'] : 0;
			return 0 === $ts || $ts >= $cutoff;
		} ) );

		if ( count( $rows ) > self::MAX_LOG ) {
			$rows = array_slice( self::sort_rows( $rows ), 0, self::MAX_LOG );
		}
		return $rows;
	}

	public static function log_rows() {
		$state = self::log_state();
		return array(
			'ok'    => true,
			'rows'  => self::sort_rows( $state['rows'] ),
			'total' => $state['total'],
			'since' => $state['since'],
			'max'   => self::MAX_LOG,
			'days'  => self::LOG_DAYS,
		);
	}

	/**
	 * Empty the log. Allowed HERE, unlike the PHP error log this plugin reads but
	 * never touches: this is Morpheus's own record of what it observed, not the
	 * operator's server evidence. Clearing it never loses anything the site wrote.
	 */
	public static function clear_log() {
		$state = self::log_state();
		self::write_log( array( 'rows' => array(), 'total' => 0, 'since' => gmdate( 'c' ) ) );
		morpheus_log( 'redirect_log_cleared', array( 'rows' => count( $state['rows'] ) ) );
		return array( 'ok' => true, 'cleared' => count( $state['rows'] ), 'rows' => array(), 'total' => 0 );
	}

	// ── reporting ───────────────────────────────────────────────────────────

	public static function status() {
		$s     = self::settings();
		$state = self::log_state();
		$hits  = 0;
		foreach ( $s['rules'] as $r ) {
			$hits += (int) ( $r['hits'] ?? 0 );
		}
		return array(
			'ok'            => true,
			'available'     => true,
			'enabled'       => (bool) $s['enabled'],
			'rules'         => $s['rules'],
			'rules_max'     => self::MAX_RULES,
			'rule_hits'     => $hits,
			'not_found'     => count( $state['rows'] ),
			'not_found_all' => $state['total'],
			'log_max'       => self::MAX_LOG,
			'log_days'      => self::LOG_DAYS,
			'statuses'      => self::STATUSES,
			'protected'     => self::PROTECTED,
		);
	}

	public static function public_status() {
		$s = self::settings();
		return array(
			'available' => true,
			'enabled'   => (bool) $s['enabled'],
			'rules'     => count( $s['rules'] ),
		);
	}

	// ── REST ────────────────────────────────────────────────────────────────

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/redirects', array(
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
		$id     = isset( $body['id'] ) ? sanitize_text_field( (string) $body['id'] ) : '';

		morpheus_log( 'redirects', array( 'action' => $action ) );

		switch ( $action ) {
			case 'status':
				$r = self::status();
				break;
			case 'log':
				$r = self::log_rows();
				break;
			case 'create':
				$r = self::create( $data );
				break;
			case 'update':
				$r = self::update( $id, $data );
				break;
			case 'delete':
				$r = self::delete( $id );
				break;
			case 'clear_log':
				$r = self::clear_log();
				break;
			case 'settings':
				$r = self::set_enabled( ! empty( $data['enabled'] ) );
				break;
			default:
				return Morpheus_REST::err( 'unknown_action', 'action must be status, log, create, update, delete, clear_log or settings.', 400 );
		}

		if ( is_wp_error( $r ) ) {
			$status = $r->get_error_data();
			$status = is_array( $status ) && isset( $status['status'] ) ? (int) $status['status'] : 400;
			return Morpheus_REST::err( $r->get_error_code(), $r->get_error_message(), $status );
		}
		return new WP_REST_Response( $r, empty( $r['ok'] ) ? 409 : 200 );
	}
}
