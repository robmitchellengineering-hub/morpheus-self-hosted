<?php
/**
 * TRAFFIC — getting the site's pages indexed, and proving it happened.
 *
 * The first workflow of the traffic tab, and deliberately only one: submit a URL
 * to IndexNow the moment it goes live or changes, and keep a bounded ledger of
 * every submission with the real HTTP status that came back.
 *
 * Why IndexNow and nothing else yet: it is the one indexing lever that needs no
 * account, no OAuth and no third party holding a key — the site hosts a key file
 * and IndexNow accepts the submission. Everything else the tab will show
 * (sitemap hygiene, orphan/internal links, Google Business Profile) is either
 * unbuilt or gated on Google's approval, and the tab says so rather than
 * implying otherwise.
 *
 * Why a ledger: "we submit URLs to search engines" is a claim. A row per
 * submission with a timestamp, the URL and the status code IndexNow actually
 * returned is evidence. A traffic feature with no record of what it did is
 * faith, and this repo does not ship faith.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Traffic {

	const OPTION        = 'morpheus_traffic';        // { enabled: bool }
	const KEY_FILE      = 'indexnow-key.txt';
	const LEDGER_FILE   = 'traffic-ledger.json';
	const KEY_CHECK     = 'morpheus_traffic_keycheck'; // cached result of the self-request
	const ENDPOINT      = 'https://api.indexnow.org/indexnow';
	const CRON_HOOK     = 'morpheus_traffic_submit';

	const MAX_LEDGER    = 500;   // rows kept, newest first — bounded so it cannot grow forever
	const MAX_BATCH     = 100;   // OUR conservative cap, not IndexNow's: the spec documents up to 10,000 URLs per post
	const MAX_BACKFILL  = 200;   // URLs per backfill run, so one click cannot blast a whole site
	const KEY_CHECK_TTL = 3600;  // seconds to trust a key-served check that SUCCEEDED

	// A FAILED check is not trusted for an hour. It was, and that is the wrong
	// half to cache long: the moment the operator fixes the rewrite (saving
	// Permalinks, updating the plugin), the panel kept telling them it was still
	// broken for up to an hour, with nothing on screen to say the answer was old.
	// A miss is cheap to re-ask and worth re-asking.
	const KEY_CHECK_MISS_TTL = 60;

	// Post types whose publication is worth telling an index about. Derived from
	// the site, not hard-coded — see `morpheus_public_post_types()` in
	// includes/helpers.php. The live store's `services` CPT was never announced to
	// IndexNow while this was the constant `array( 'post', 'page', 'product' )`.

	public static function init() {
		add_action( 'transition_post_status', array( __CLASS__, 'on_transition' ), 10, 3 );
		add_action( self::CRON_HOOK, array( __CLASS__, 'run_submission' ), 10, 1 );
		add_action( 'init', array( __CLASS__, 'register_rewrite' ) );
		// PRIORITY 1, before WordPress's own template_redirect work. `redirect_canonical`
		// is registered on the same hook at the default 10 by core's default-filters,
		// which load before any plugin — so it ran FIRST and answered a correct key URL
		// with a 301 to `/<key>.txt/`, only then reaching this handler on the redirected
		// request. The key was served (and IndexNow follows redirects), but a key URL
		// that 200s directly is the correct shape, and it should not depend on what the
		// canonical redirect decides about a file that is not a page. class-redirects.php
		// hooks priority 1 for exactly this reason.
		add_action( 'template_redirect', array( __CLASS__, 'maybe_serve_key' ), 1 );
	}

	/** Activation: make sure there is a key and the rewrite rule is registered. */
	public static function activate() {
		self::key();
		self::register_rewrite();
		flush_rewrite_rules();
	}

	// ── settings ────────────────────────────────────────────────────────────

	public static function settings() {
		$o = get_option( self::OPTION, array() );
		return array( 'enabled' => ! empty( $o['enabled'] ) );
	}

	/**
	 * Default OFF. Submitting to a search engine is an outward action on the
	 * operator's own site, so it starts switched off and the operator turns it on
	 * from the tab — not something we do on their behalf because we think it is
	 * a good idea.
	 */
	public static function save_settings( $data ) {
		$enabled = ! empty( $data['enabled'] );
		update_option( self::OPTION, array( 'enabled' => $enabled ) );
		return self::settings();
	}

	// ── the key ─────────────────────────────────────────────────────────────

	/**
	 * The IndexNow key: generated once, kept in the state dir, never logged.
	 *
	 * 32 hex characters, which is OUR choice rather than the spec's — IndexNow
	 * allows 8–128 characters from [A-Za-z0-9-], and its own example key is not
	 * hex. We generate hex and the rewrite rule serves exactly `[a-f0-9]{32}.txt`,
	 * so both sides use one rule; the app validates the same shape. If this ever
	 * needs to accept a key pasted from elsewhere, the rewrite rule and the app's
	 * validation have to widen together or a key will be accepted and not served.
	 */
	public static function key() {
		$path = MORPHEUS_STATE_DIR . '/' . self::KEY_FILE;
		$cur  = @file_get_contents( $path );
		if ( $cur && preg_match( '/^[a-f0-9]{32}$/', trim( $cur ) ) ) {
			return trim( $cur );
		}
		$key = bin2hex( random_bytes( 16 ) );
		if ( ! is_dir( MORPHEUS_STATE_DIR ) ) {
			wp_mkdir_p( MORPHEUS_STATE_DIR );
		}
		@file_put_contents( $path, $key );
		return $key;
	}

	public static function key_location() {
		return home_url( '/' . self::key() . '.txt' );
	}

	public static function register_rewrite() {
		add_rewrite_rule( '^([a-f0-9]{32})\.txt$', 'index.php?morpheus_indexnow_key=$matches[1]', 'top' );
		add_rewrite_tag( '%morpheus_indexnow_key%', '([a-f0-9]{32})' );
	}

	/**
	 * Serve the key file.
	 *
	 * A plugin cannot reliably write to the webroot, so the key is served through
	 * WordPress. Whether that actually works depends on the host's rewrite setup,
	 * which is why we CHECK it (see key_served()) rather than assume it, and why
	 * the tab can tell the operator to place the file by hand when it does not.
	 */
	public static function maybe_serve_key() {
		$asked = get_query_var( 'morpheus_indexnow_key' );
		if ( ! $asked ) {
			return;
		}
		if ( $asked !== self::key() ) {
			status_header( 404 );
			exit;
		}
		header( 'Content-Type: text/plain; charset=utf-8' );
		echo self::key(); // phpcs:ignore WordPress.Security.EscapeOutput -- a hex key, by design
		exit;
	}

	/**
	 * Did the key URL actually answer with the key?
	 *
	 * Cached for an hour: this is a self-request, and doing it on every status
	 * call would be a small waste. A false answer is not fatal — IndexNow also
	 * accepts the key in the request body — but the operator deserves to know,
	 * because a key that is not served is a submission that will be rejected.
	 */
	public static function key_served( $force = false ) {
		if ( ! $force ) {
			$cached = get_transient( self::KEY_CHECK );
			if ( is_array( $cached ) ) {
				return $cached;
			}
		}
		$key  = self::key();
		$url  = self::key_location();
		$res  = wp_remote_get( $url, array( 'timeout' => 8, 'redirection' => 2 ) );
		$out  = array( 'checked' => true, 'served' => false, 'status' => 0, 'url' => $url );
		if ( is_wp_error( $res ) ) {
			$out['note'] = $res->get_error_message();
		} else {
			$out['status'] = (int) wp_remote_retrieve_response_code( $res );
			$body          = trim( (string) wp_remote_retrieve_body( $res ) );
			$out['served'] = ( 200 === $out['status'] && $body === $key );
		}
		// Cache the answer for as long as it deserves: an hour when the key is
		// being served (nothing is going to change), a minute when it is not
		// (because the operator may be fixing it right now).
		set_transient( self::KEY_CHECK, $out, $out['served'] ? self::KEY_CHECK_TTL : self::KEY_CHECK_MISS_TTL );
		return $out;
	}

	// ── submission ──────────────────────────────────────────────────────────

	/**
	 * A post became published, or a published post changed.
	 *
	 * Scheduled rather than sent here: the operator's publish must not wait on a
	 * third party, and a failure must never appear as an error on their site. The
	 * cron run does the blocking request and records what came back, so the
	 * ledger keeps a real status instead of an optimistic guess.
	 */
	public static function on_transition( $new_status, $old_status, $post ) {
		if ( ! $post || 'auto-draft' === $new_status || 'trash' === $new_status ) {
			return;
		}
		if ( ! in_array( $post->post_type, morpheus_public_post_types(), true ) ) {
			return;
		}
		$s = self::settings();
		if ( empty( $s['enabled'] ) ) {
			return;
		}
		// Newly published, or an update to something already live. A draft that is
		// edited is not public, so there is nothing to tell an index about.
		$went_live = ( 'publish' === $new_status && 'publish' !== $old_status );
		$updated   = ( 'publish' === $new_status && 'publish' === $old_status );
		if ( ! $went_live && ! $updated ) {
			return;
		}
		if ( ! wp_next_scheduled( self::CRON_HOOK, array( $post->ID ) ) ) {
			wp_schedule_single_event( time(), self::CRON_HOOK, array( $post->ID ) );
		}
	}

	/**
	 * Is this URL one a search engine should be TOLD about?
	 *
	 * The type filter above answers it for post types; this answers it for the URL that
	 * came out of one, because two things only show up in the value:
	 *
	 *   * a permalink with no path is `?post_type=slug`, which is what get_permalink()
	 *     returns for a type with no rewrite. It resolves, so it looks like a page in a
	 *     ledger — fifteen of them reached IndexNow from a real site before this existed;
	 *   * the store's own utility pages. Nobody wants the cart in an index, and a shop
	 *     page is `post_type=page`, so no post-type rule can ever exclude it.
	 *
	 * `morpheus_announce_url` is the seam for anything else — another shop, a membership
	 * plugin, a one-off "thank you" page — because a list of slugs would be a guess and a
	 * filter is not.
	 */
	public static function announceable( $post_id, $url ) {
		$path = (string) wp_parse_url( (string) $url, PHP_URL_PATH );
		if ( '' === trim( $path, '/' ) ) {
			return false;
		}
		if ( function_exists( 'wc_get_page_id' ) ) {
			foreach ( array( 'cart', 'checkout', 'myaccount', 'terms' ) as $key ) {
				$page = (int) wc_get_page_id( $key );
				if ( $page > 0 && $page === (int) $post_id ) {
					return false;
				}
			}
		}
		/**
		 * Filters whether Morpheus announces one URL to IndexNow.
		 *
		 * @param bool   $announce Whether to submit it.
		 * @param int    $post_id  The post the URL came from.
		 * @param string $url      The permalink.
		 */
		return (bool) apply_filters( 'morpheus_announce_url', true, (int) $post_id, (string) $url );
	}

	/** Cron: submit one post's permalink and record the outcome. */
	public static function run_submission( $post_id ) {
		$url = get_permalink( (int) $post_id );
		if ( ! $url || ! self::announceable( $post_id, $url ) ) {
			return;
		}
		self::submit( array( $url ), 'publish' );
	}

	/**
	 * POST a batch to IndexNow and write one ledger row per URL.
	 *
	 * Returns the raw outcome so a caller (backfill) can report it. Errors are
	 * values, never exceptions: this runs inside a cron event and inside a REST
	 * call, and neither may take the site down over an indexing nicety.
	 */
	public static function submit( array $urls, $action = 'manual' ) {
		$urls = array_values( array_unique( array_filter( array_map( 'esc_url_raw', $urls ) ) ) );
		if ( empty( $urls ) ) {
			return array( 'ok' => false, 'status' => 0, 'note' => 'nothing to submit', 'count' => 0 );
		}
		$key  = self::key();
		$body = array(
			'host'        => wp_parse_url( home_url(), PHP_URL_HOST ),
			'key'         => $key,
			'keyLocation' => self::key_location(),
			'urlList'     => array_slice( $urls, 0, self::MAX_BATCH ),
		);
		$res = wp_remote_post( self::ENDPOINT, array(
			'timeout'     => 15,
			'headers'     => array( 'Content-Type' => 'application/json; charset=utf-8' ),
			'body'        => wp_json_encode( $body ),
			'data_format' => 'body',
		) );

		if ( is_wp_error( $res ) ) {
			$status = 0;
			$note   = $res->get_error_message();
		} else {
			$status = (int) wp_remote_retrieve_response_code( $res );
			$note   = trim( wp_strip_all_tags( (string) wp_remote_retrieve_body( $res ) ) );
		}
		self::ledger_add( $body['urlList'], $action, $status, $note );

		return array(
			'ok'     => ( $status >= 200 && $status < 300 ),
			'status' => $status,
			'note'   => '' !== $note ? mb_substr( $note, 0, 200 ) : self::status_note( $status ),
			'count'  => count( $body['urlList'] ),
		);
	}

	/** What a status code means, in words the operator can act on. */
	public static function status_note( $status ) {
		// 200 and 202 are NOT the same answer, and collapsing them would hide the
		// one an operator most needs to see: 200 is "URL submitted successfully",
		// 202 is "URL received — key validation pending". A site whose key file is
		// not being served yet gets 202s, and it has to be told that rather than
		// shown a green tick (indexnow.org/documentation).
		if ( 200 === $status ) {
			return 'submitted';
		}
		if ( 202 === $status ) {
			return 'received — key validation pending; check the key file is being served';
		}
		if ( 400 === $status ) {
			return 'bad request — the key or host did not match what IndexNow expects';
		}
		if ( 403 === $status ) {
			return 'forbidden — the key file was not found at its location';
		}
		if ( 422 === $status ) {
			return 'rejected — the URLs did not belong to this host';
		}
		if ( 429 === $status ) {
			return 'rate limited — try again later';
		}
		if ( $status >= 500 ) {
			return 'IndexNow had a server error';
		}
		if ( 0 === $status ) {
			return 'could not reach IndexNow';
		}
		return 'unexpected response';
	}

	// ── the ledger ──────────────────────────────────────────────────────────

	private static function ledger_path() {
		return MORPHEUS_STATE_DIR . '/' . self::LEDGER_FILE;
	}

	public static function ledger() {
		$path = self::ledger_path();
		$raw  = @file_get_contents( $path );
		$rows = $raw ? json_decode( $raw, true ) : array();
		return is_array( $rows ) ? $rows : array();
	}

	/**
	 * Append rows and trim to MAX_LEDGER.
	 *
	 * Bounded on purpose: this file is read by a tab and written on every publish
	 * for the life of the site, so an unbounded log would eventually be a
	 * performance problem the operator cannot see coming.
	 */
	private static function ledger_add( array $urls, $action, $status, $note ) {
		$rows = self::ledger();
		$at   = gmdate( 'c' );
		foreach ( $urls as $url ) {
			array_unshift( $rows, array(
				'at'     => $at,
				'url'    => $url,
				'action' => (string) $action,
				'status' => (int) $status,
				'note'   => mb_substr( (string) $note, 0, 120 ),
			) );
		}
		$rows = array_slice( $rows, 0, self::MAX_LEDGER );
		if ( ! is_dir( MORPHEUS_STATE_DIR ) ) {
			wp_mkdir_p( MORPHEUS_STATE_DIR );
		}
		@file_put_contents( self::ledger_path(), wp_json_encode( $rows ) );
		return $rows;
	}

	/** URLs already accepted by IndexNow — the basis of an idempotent backfill. */
	public static function accepted_urls() {
		$done = array();
		foreach ( self::ledger() as $row ) {
			$status = isset( $row['status'] ) ? (int) $row['status'] : 0;
			if ( $status >= 200 && $status < 300 && ! empty( $row['url'] ) ) {
				$done[ $row['url'] ] = true;
			}
		}
		return $done;
	}

	// ── backfill ────────────────────────────────────────────────────────────

	/**
	 * Submit the site's existing published URLs, in bounded batches.
	 *
	 * Idempotent: a URL IndexNow already accepted is skipped, so running it twice
	 * does the right thing the second time (nothing) rather than re-submitting a
	 * whole site. Bounded per run so one click cannot blast thousands of URLs at
	 * a free service.
	 */
	public static function backfill() {
		$done  = self::accepted_urls();
		$query = new WP_Query( array(
			'post_type'      => morpheus_public_post_types(),
			'post_status'    => 'publish',
			'posts_per_page' => self::MAX_BACKFILL,
			'fields'         => 'ids',
			'no_found_rows'  => true,
			'orderby'        => 'modified',
			'order'          => 'DESC',
		) );
		$urls = array();
		foreach ( $query->posts as $id ) {
			$url = get_permalink( $id );
			if ( $url && self::announceable( $id, $url ) && ! isset( $done[ $url ] ) ) {
				$urls[] = $url;
			}
		}
		if ( empty( $urls ) ) {
			return array( 'ok' => true, 'submitted' => 0, 'batches' => 0, 'note' => 'every published URL has already been accepted' );
		}
		$results  = array();
		$batches  = 0;
		foreach ( array_chunk( $urls, self::MAX_BATCH ) as $batch ) {
			$results[] = self::submit( $batch, 'backfill' );
			$batches++;
		}
		$ok = true;
		foreach ( $results as $r ) {
			if ( empty( $r['ok'] ) ) {
				$ok = false;
			}
		}
		return array(
			'ok'        => $ok,
			'submitted' => count( $urls ),
			'batches'   => $batches,
			'results'   => $results,
		);
	}

	// ── what the tab reads ──────────────────────────────────────────────────

	public static function status() {
		$s     = self::settings();
		$rows  = self::ledger();
		$sent  = 0;
		$ok    = 0;
		$last  = null;
		foreach ( $rows as $row ) {
			$sent++;
			$status = isset( $row['status'] ) ? (int) $row['status'] : 0;
			if ( $status >= 200 && $status < 300 ) {
				$ok++;
				if ( null === $last ) {
					$last = isset( $row['at'] ) ? $row['at'] : null;
				}
			}
		}
		return array(
			'ok'           => true,
			'enabled'      => ! empty( $s['enabled'] ),
			'key'          => self::key(),
			'key_location' => self::key_location(),
			'key_served'   => self::key_served(),
			'endpoint'     => self::ENDPOINT,
			'submitted'    => $sent,
			'accepted'     => $ok,
			'last_ok'      => $last,
			'ledger_max'   => self::MAX_LEDGER,
			'batch_max'    => self::MAX_BATCH,
			'backfill_max' => self::MAX_BACKFILL,
			// Named so the tab does not have to invent a list: these are the parts
			// of the plan that do not exist in this build.
			'not_built'    => array(
				'orphans'   => 'Orphan pages and internal-link automation are not built yet.',
				'areas'     => 'Service and area pages are not built yet.',
				'gbp'       => 'Google Business Profile needs Google\'s API approval before anything here can use it.',
			),
			// The other half of the same honesty, and it corrects a false claim: this
			// list used to be led by "Sitemap hygiene is not built yet.", which was
			// simply wrong. The SEO module keeps robots.txt pointing at the sitemap the
			// site really serves and replaces a dead path left by a removed SEO plugin
			// — Morpheus_SEO::filter_robots_txt(), with eight harness assertions behind
			// it. A missing half reads as a finished whole; a finished half written
			// down as missing reads as a smaller product than the one that ships.
			'handled'      => array(
				'sitemap'   => 'Sitemap hygiene is handled: robots.txt is kept pointing at the sitemap this site really serves, and a dead path left by a removed SEO plugin is replaced.',
			),
		);
	}

	/** The public half: what the /status route adds, without admin-only detail. */
	public static function public_status() {
		$s = self::settings();
		return array(
			'available' => true,
			'enabled'   => ! empty( $s['enabled'] ),
		);
	}

	// ── REST ────────────────────────────────────────────────────────────────

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/traffic', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle' ),
		) );
	}

	/**
	 * Signed like every other module route: `status` returns the site's own
	 * configuration (its key, whether the key is being served) and `backfill`
	 * WRITES by talking to a third party on the operator's behalf.
	 *
	 * `settings` is the only action that changes what this site does, and it is
	 * the only way the operator can turn the feature on — the default is off.
	 */
	public static function handle( WP_REST_Request $request ) {
		$body = Morpheus_REST::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		$action = isset( $body['action'] ) ? sanitize_key( $body['action'] ) : '';
		$data   = isset( $body['data'] ) && is_array( $body['data'] ) ? $body['data'] : array();

		morpheus_log( 'traffic', array( 'action' => $action ) );

		switch ( $action ) {
			case 'status':
				$r = self::status();
				break;
			case 'ledger':
				$r = array( 'ok' => true, 'rows' => self::ledger(), 'max' => self::MAX_LEDGER );
				break;
			case 'backfill':
				$r = self::backfill();
				break;
			case 'settings':
				$r = array( 'ok' => true, 'settings' => self::save_settings( $data ) );
				break;
			default:
				return Morpheus_REST::err( 'unknown_action', 'action must be status, ledger, backfill or settings.', 400 );
		}
		return new WP_REST_Response( $r, empty( $r['ok'] ) ? 409 : 200 );
	}
}
