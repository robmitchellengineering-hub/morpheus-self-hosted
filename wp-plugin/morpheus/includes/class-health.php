<?php
/**
 * Site health + maintenance scan.
 *
 * WHY THIS USES WORDPRESS'S OWN TESTS
 *
 * WordPress already ships 34 direct Site Health tests (PHP version and
 * extensions, database server, scheduled events, HTTP requests, REST
 * availability, debug mode, file uploads, auto-update configuration, the
 * temporary-backup directory, disk space, autoloaded options, open
 * registration, search-engine visibility, opcode and object caches) plus
 * whatever an active plugin registers — WooCommerce adds ten more. Reimplementing
 * those would guarantee two answers to the same question that disagree, so this
 * runs WordPress's tests and reports their verdicts verbatim.
 *
 * HOW A DIRECT TEST IS INVOKED (verified against a real WordPress, not recalled)
 *
 * `WP_Site_Health::get_tests()` returns `direct` and `async`. A direct test's
 * `test` key is EITHER a callable (WooCommerce registers `array( $this, 'method' )`)
 * OR — for every core test — a STRING that is a method-name SUFFIX: core stores
 * `'test' => 'php_version'` and the admin screen resolves it to
 * `get_test_php_version()`. Calling the string throws. That is exactly what the
 * first version of this scan did, and it died with a fatal error, which is why
 * both shapes are handled explicitly below.
 *
 * ASYNC TESTS ARE NOT RUN, AND THAT IS REPORTED
 *
 * The six async tests (communication with WordPress.org, background updates,
 * loopback requests, HTTPS status, the authorization header, page cache) are
 * triggered from the browser against `/wp-site-health/v1/...`, where WordPress
 * can authenticate the admin. This scan is called over a signed server request
 * with no login, so it cannot honestly claim to have run them. They are listed as
 * not-run, with the reason, rather than silently omitted — an absent test reads
 * as a passing one.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Health {

	/** How long a scan is reused before it runs again. */
	const CACHE_TTL = 300;

	/**
	 * Everything, in one call.
	 *
	 * The SCAN is read-only — it writes no file and changes no setting. Its only
	 * write is its own short-lived cache, because a full scan costs seconds
	 * (WordPress's tests include loopback HTTP requests, and one of our own
	 * checks fetches each active plugin's wordpress.org listing): 18s in the
	 * WASM test environment. Re-running that every time the panel opens would be
	 * both slow and rude to wordpress.org. Pass $force to bypass the cache.
	 */
	public static function scan( $force = false ) {
		$cache_key = 'morpheus_health_scan';
		if ( ! $force ) {
			$cached = get_transient( $cache_key );
			if ( is_array( $cached ) ) {
				$cached['cached'] = true;
				return $cached;
			}
		}
		self::admin_includes();
		$updates = self::updates();
		$host    = self::host();
		// Every finding carries its action, and anything attention-worthy with no
		// registered action is reported rather than left as prose (see class-fixes.php).
		$tests    = self::direct_tests();
		$own      = self::own_checks( $host );
		// WordPress's `debug_enabled` test says debug mode is ON. Morpheus used to
		// append a STATIC sentence to it claiming the log is "readable over the
		// web" — a claim nothing had checked. Replace it with the verified answer
		// BEFORE annotation, so what the panel shows for that test is what was
		// actually measured.
		self::describe_public_debug_log( $tests );
		$unmapped = array_merge( Morpheus_Fixes::annotate( $tests ), Morpheus_Fixes::annotate( $own ) );
		// What the last attempt at each of these did, so a refusal the operator
		// already met is on the row they are looking at — read from the site, so
		// it survives a reload (class-fixes.php::record_attempt()).
		Morpheus_Fixes::attach_attempts( $tests );
		Morpheus_Fixes::attach_attempts( $own );

		$result = array(
			'scan_version'      => 1,
			'plugin_version'    => MORPHEUS_VERSION,
			'wp_version'        => get_bloginfo( 'version' ),
			'php_version'       => PHP_VERSION,
			'generated_at'      => gmdate( 'c' ),
			// Age matters: WordPress only checks for updates twice a day, so a
			// "no updates" line is only as fresh as this.
			'update_checked_at' => $updates['checked_at'],
			'tests'             => $tests,
			'own_checks'        => $own,
			// Findings that ask for something and have no action Morpheus can take.
			// A non-empty list is a gap in the fix registry, not a site problem.
			'unmapped'          => $unmapped,
			'updates'           => $updates,
			'auto_updates'      => self::auto_updates(),
			'host'              => $host,
			'async_not_run'     => array_merge( self::async_tests(), self::session_bound_not_run() ),
			// WHAT MORPHEUS MAY PROPOSE, per finding — the vocabulary, sent with the
			// scan so the app can ask a model a question it cannot widen. It comes from
			// the plugin's own registry (Morpheus_Fixes::ai_operations()) rather than
			// from the request, which is what keeps the bound on the side that writes.
			'ai_operations'     => class_exists( 'Morpheus_Fixes' ) ? Morpheus_Fixes::ai_operations() : array(),
			'can'               => self::capability( $host ),
		);
		$result['cached'] = false;
		set_transient( $cache_key, $result, self::CACHE_TTL );
		return $result;
	}

	// ── WordPress's own direct tests ────────────────────────────────────────

	/**
	 * Load what the Site Health ADMIN SCREEN loads.
	 *
	 * Not optional, and not obvious. The tests are written for that screen and
	 * call admin-only helpers — `get_test_wordpress_version()` reaches
	 * `get_core_updates()`, `get_test_plugin_version()` reaches `get_plugins()`,
	 * and so on. Running them from a signed REST request without these includes
	 * makes the FIRST test a fatal "call to undefined function", and in the
	 * WASM/CLI context this was developed in that produced NO error output at
	 * all: the scan printed one line and died, which reads exactly like a crash
	 * in the scan itself. Loading `wp-admin/includes/admin.php` — the same file
	 * `wp-admin/admin.php` pulls in — makes all 34 direct tests run.
	 */
	private static function admin_includes() {
		$file = ABSPATH . 'wp-admin/includes/admin.php';
		if ( file_exists( $file ) ) {
			require_once $file;
		}
		$health = ABSPATH . 'wp-admin/includes/class-wp-site-health.php';
		if ( file_exists( $health ) ) {
			require_once $health;
		}
	}

	private static function direct_tests() {
		self::admin_includes();
		if ( ! class_exists( 'WP_Site_Health' ) ) {
			return array();
		}

		$site_health = WP_Site_Health::get_instance();
		if ( ! method_exists( $site_health, 'get_tests' ) ) {
			return array();
		}
		$registered = $site_health->get_tests();
		$out        = array();

		// Tests that measure the CALLER'S SESSION rather than the site. Running
		// them here does not report on the site, it reports on the fact that a
		// signed scan has no logged-in user — see session_bound_tests(). They go
		// to the not-run list instead, with the reason, so the panel says "not
		// checked" rather than a verdict the scan cannot honestly reach.
		$session_bound = self::session_bound_tests();

		foreach ( (array) ( $registered['direct'] ?? array() ) as $id => $test ) {
			if ( isset( $session_bound[ $id ] ) ) {
				continue;
			}
			$callback = self::resolve_test_callback( $site_health, $test );
			if ( ! $callback ) {
				continue;
			}
			$result = call_user_func( $callback );
			if ( ! is_array( $result ) ) {
				continue;
			}
			$out[] = array(
				'id'          => (string) $id,
				'label'       => self::plain( $result['label'] ?? ( $test['label'] ?? $id ) ),
				'status'      => self::status( $result['status'] ?? '' ),
				'badge'       => self::badge( $result['badge'] ?? null ),
				'description' => self::plain( $result['description'] ?? '' ),
				'links'       => self::links( $result['actions'] ?? '' ),
				'source'      => 'wordpress',
			);
		}
		return $out;
	}

	/** A direct test's callback, in either shape core and plugins use. */
	private static function resolve_test_callback( $site_health, $test ) {
		$entry = $test['test'] ?? null;
		if ( is_string( $entry ) && '' !== $entry ) {
			$method = 'get_test_' . $entry;
			if ( method_exists( $site_health, $method ) && is_callable( array( $site_health, $method ) ) ) {
				return array( $site_health, $method );
			}
			return null;
		}
		return is_callable( $entry ) ? $entry : null;
	}

	/**
	 * Give WordPress's `debug_enabled` test the VERIFIED answer about the log.
	 *
	 * WHY THIS IS NOT A SENTENCE IN THE REGISTRY
	 *
	 * WordPress's test asks whether debug MODE is on, and it is right to say so.
	 * Morpheus annotates it with what it can add — whether the log WordPress
	 * writes is reachable — and that annotation used to be a fixed sentence
	 * asserting "readable over the web". Nothing had checked it, and it was
	 * false on a live site whose host answers every /wp-content path with 200
	 * and its own HTML page: the operator was told his log leaked when it did
	 * not. The sentence now comes from Morpheus_Clean::debug_log_state() — the
	 * SAME served-bytes answer the clean scan uses, so the two screens cannot
	 * disagree — and when the question cannot be answered it says THAT rather
	 * than guessing either way.
	 *
	 * `action_does` is read by Morpheus_Fixes::annotate() in place of the
	 * registry's static sentence (class-fixes.php).
	 */
	private static function describe_public_debug_log( &$tests ) {
		$index = null;
		foreach ( $tests as $i => $f ) {
			if ( 'debug_enabled' === ( $f['id'] ?? '' ) ) {
				$index = $i;
				break;
			}
		}
		// WordPress only registers this test when WP_DEBUG is on, so its absence
		// is an answer of its own — and no fetch is spent on a site not logging.
		if ( null === $index ) {
			return;
		}

		$url = content_url( 'debug.log' );
		if ( ! class_exists( 'Morpheus_Clean' ) ) {
			$tests[ $index ]['action_does'] = 'WP_DEBUG_LOG is on, so WordPress writes wp-content/debug.log. This build of the plugin cannot check whether that file is reachable over the web, so it does not claim either way.';
			return;
		}

		$state = Morpheus_Clean::debug_log_state();
		if ( null === $state ) {
			$tests[ $index ]['action_does'] = 'WP_DEBUG_LOG is on, so WordPress writes wp-content/debug.log. Morpheus asked ' . $url . ' whether that file is served and got no answer, so whether it is readable over the web is UNCONFIRMED — not a pass, and not a leak.';
		} elseif ( empty( $state['exists'] ) ) {
			$tests[ $index ]['action_does'] = 'WP_DEBUG_LOG is on, but there is no wp-content/debug.log on disk right now, so nothing is being leaked by one.';
		} elseif ( ! empty( $state['empty'] ) ) {
			$tests[ $index ]['action_does'] = 'WP_DEBUG_LOG is on and wp-content/debug.log exists, but the file is empty — there is nothing in it to leak over the web.';
		} elseif ( empty( $state['served'] ) ) {
			$tests[ $index ]['action_does'] = 'WP_DEBUG_LOG is on, so WordPress writes wp-content/debug.log. Morpheus requested ' . $url . ' and was served something that is not this file, so the log exists on disk and is not being served over the web.';
		} else {
			$tests[ $index ]['action_does'] = 'WP_DEBUG_LOG is on AND ' . $url . ' returns this file\'s own contents to anyone who asks, with no login. Move the log outside the web root or switch WP_DEBUG_LOG off — CLEAN MY SITE quarantines the file itself.';
		}
	}

	private static function async_tests() {
		self::admin_includes();
		if ( ! class_exists( 'WP_Site_Health' ) ) {
			return array();
		}
		$registered = WP_Site_Health::get_instance()->get_tests();
		$out        = array();
		// Two of these are genuinely covered by a check we CAN run, so say which
		// — a blanket "we did not run this" would hide that the answer is above.
		$covered = array(
			'loopback_requests' => 'Morpheus answers this one directly: see "The site can reach itself" below. WordPress\'s own version additionally inspects the response body for errors.',
			'https_status'      => 'Morpheus reports the site\'s own is_ssl() under host.ssl. WordPress\'s version also confirms the HTTPS URL actually resolves from outside.',
		);
		foreach ( (array) ( $registered['async'] ?? array() ) as $id => $test ) {
			$out[] = array(
				'id'     => (string) $id,
				'label'  => self::plain( $test['label'] ?? $id ),
				// The honest reason, shown in the panel next to the name.
				'reason' => $covered[ $id ] ?? 'WordPress runs this one from the browser as a logged-in administrator; a signed server scan cannot. Check it in Tools → Site Health.',
			);
		}
		return $out;
	}

	/**
	 * WordPress's DIRECT tests whose answer belongs to the browser's session.
	 *
	 * WordPress's `rest_availability` test does not merely fetch a URL: it makes a
	 * request from the site to its own REST API carrying the CURRENT USER'S
	 * cookies plus an `X-WP-Nonce`, then asks for `context=edit`, which only a
	 * logged-in editor may see. Run it from the Site Health screen and it passes.
	 *
	 * Run it from here and it CANNOT pass, on any site, whatever the host does:
	 * this scan arrives as a signed POST from Morpheus's backend, so there is no
	 * logged-in user, `$_COOKIE` is empty, and the nonce it mints is for nobody.
	 * WordPress's own rule for "cookie auth was used but no nonce arrived" is to
	 * de-authenticate the request, so its permission check answers
	 * `401 rest_forbidden_context` — every time. Verified on a live site: the
	 * public route answers 200, a WRONG nonce answers 403, and only the missing
	 * nonce produces the 401 we were reporting as a site problem.
	 *
	 * It was reported as "Something is intercepting /wp-json/ — usually a security
	 * plugin or the host", which sent the operator to their host about a finding
	 * Morpheus had manufactured. A test that can only fail where we run it is not
	 * a finding; it is a not-run, and it is listed as one.
	 */
	private static function session_bound_tests() {
		return array(
			'rest_availability' => 'This one is answered by the browser as you: WordPress makes a request from the site to its own REST API carrying YOUR cookies and a REST nonce, and asks for a context only a logged-in editor may see. A signed server scan has no user session, so that request arrives with no nonce, WordPress treats it as logged out by its own rule, and the answer is 401 on every site regardless of host. Open Tools → Site Health while logged in to answer it.',
		);
	}

	/** The session-bound tests as not-run rows, labelled from WordPress's own registration. */
	private static function session_bound_not_run() {
		self::admin_includes();
		$labels = array();
		if ( class_exists( 'WP_Site_Health' ) ) {
			$registered = WP_Site_Health::get_instance()->get_tests();
			foreach ( (array) ( $registered['direct'] ?? array() ) as $id => $test ) {
				$labels[ $id ] = $test['label'] ?? $id;
			}
		}
		$out = array();
		foreach ( self::session_bound_tests() as $id => $reason ) {
			$out[] = array(
				'id'     => (string) $id,
				'label'  => self::plain( $labels[ $id ] ?? $id ),
				'reason' => $reason,
			);
		}
		return $out;
	}

	// ── Checks WordPress's own tests do not cover ───────────────────────────

	/**
	 * Ours, and labelled as ours in the payload so the panel never presents them
	 * as WordPress's verdict. Each one is something that actually bites on a
	 * managed site and that core's Site Health does not ask about.
	 */
	private static function own_checks( $host ) {
		$checks = array();

		// 1. Can this site be updated at all? The single most useful fact
		//    before offering to update anything.
		$checks[] = array(
			'id'          => 'morpheus_can_update_files',
			'label'       => 'Morpheus can write plugin and theme files',
			'status'      => $host['can_update_files'] ? 'good' : 'critical',
			'description' => $host['can_update_files']
				? 'The filesystem is writable directly, so updates can be applied without asking your host for credentials.'
				: 'This site cannot be updated by anyone until this is fixed: ' . implode( '; ', $host['blockers'] ) . '. On many hosts this is normal — WordPress asks for FTP/SSH credentials instead, and Morpheus will not ask you for those.',
			'source'      => 'morpheus',
		);

		// 2. The built-in file editor: a live code editor on a production site
		//    turns any admin-account compromise into remote code execution.
		$editor = defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT;
		$checks[] = array(
			'id'          => 'morpheus_file_editor',
			'label'       => 'Built-in plugin/theme file editor disabled',
			'status'      => $editor ? 'good' : 'recommended',
			'description' => $editor
				? 'DISALLOW_FILE_EDIT is set, so the Appearance → Theme File Editor and Plugins → Plugin File Editor screens cannot be used to run arbitrary code.'
				: 'The built-in file editor is available. Anyone who gets into an admin account can run arbitrary PHP through Appearance → Theme File Editor. Adding define( \'DISALLOW_FILE_EDIT\', true ); to wp-config.php closes that door.',
			'source'      => 'morpheus',
		);

		// 3. Debug output on a live site leaks paths and configuration to
		//    visitors. WP_DEBUG alone is fine; display is not.
		$debug_display = defined( 'WP_DEBUG_DISPLAY' ) ? (bool) WP_DEBUG_DISPLAY : ( defined( 'WP_DEBUG' ) && WP_DEBUG );
		$checks[] = array(
			'id'          => 'morpheus_debug_display',
			'label'       => 'PHP errors are not printed to visitors',
			'status'      => $debug_display ? 'recommended' : 'good',
			'description' => $debug_display
				? 'WP_DEBUG_DISPLAY is on, so PHP notices and errors are printed into your pages. They expose file paths and plugin versions to anyone who triggers one. Keep WP_DEBUG for logging if you like, and set WP_DEBUG_DISPLAY to false.'
				: 'Errors are not printed into pages.',
			'source'      => 'morpheus',
		);

		// 3b. And where the log is WRITTEN matters as much as whether it is printed.
		//     `WP_DEBUG_LOG` defaults to `true`, which means wp-content/debug.log —
		//     inside the web root, on every WordPress site that was ever debugged by
		//     somebody who then left. Most hosts serve it as plain text; the site
		//     this was built against blocks it with a 403, which is a host setting
		//     away from not doing that. The leak check elsewhere in this plugin only
		//     fires once the URL is ALREADY serving the file; this is the check that
		//     can act before it is, and it clears itself once the log lives outside
		//     the root, because then no URL reaches it.
		$log_file = morpheus_debug_log_file();
		$log_url  = morpheus_debug_log_url( $log_file );
		$logging  = ( defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG );
		if ( $logging && null !== $log_url ) {
			$checks[] = array(
				'id'          => 'morpheus_debug_log_in_web_root',
				'label'       => 'The error log is not inside the web root',
				'status'      => 'recommended',
				'description' => 'Debug logging is on and WordPress writes it to ' . self::display_path( $log_file ) . ', which is inside the site. Nothing executes a .log, so a web server hands it out as plain text to anyone who asks for it — full server paths, plugin and theme versions, database error text and sometimes credentials. Whether your host is serving it today is a separate question (Morpheus checks that too); this is the setting that decides whether it can. Morpheus can point WP_DEBUG_LOG at a file outside the web root and move the log that is there now, so you keep the logging and lose the exposure.',
				'source'      => 'morpheus',
			);
		}

		// 4. A loopback is what every one of WordPress's async tests depends on,
		//    and what a scheduled update depends on being able to survive.
		$loop = self::loopback_check();
		$checks[] = array(
			'id'          => 'morpheus_loopback',
			'label'       => 'The site can reach itself',
			'status'      => $loop['ok'] ? 'good' : 'recommended',
			'description' => $loop['ok']
				? 'A request from the site to its own REST API succeeded (' . (int) $loop['ms'] . 'ms).'
				: 'The site could not reach its own REST API: ' . $loop['error'] . '. Some hosts block this. It matters because WordPress runs background updates and several health checks through exactly this path.',
			'source'      => 'morpheus',
		);

		// 5. A physical robots.txt in the site root STOPS WordPress serving its
		//    own — core's file and Morpheus's own robots_txt filter both go
		//    silent, and nothing in wp-admin mentions it. If that file also went
		//    stale (the SEO plugin that owned its sitemap path was removed, so
		//    the path 404s) the site advertises a sitemap that is not there and
		//    never mentions the one that is. Reported only when Morpheus can
		//    PROVE the file is the one being served; see
		//    Morpheus_SEO::robots_txt_state() for the three-step judgement.
		$robots = self::robots_finding();
		if ( is_array( $robots ) ) {
			$checks[] = $robots;
		}

		// 6. Abandoned plugins: closed on wordpress.org means no security fixes
		//    will ever arrive, which no update list can tell you.
		$closed = self::closed_plugins();
		if ( null !== $closed ) {
			$checks[] = array(
				'id'          => 'morpheus_closed_plugins',
				'label'       => 'No active plugin is withdrawn from wordpress.org',
				'status'      => $closed ? 'critical' : 'good',
				'description' => $closed
					? 'These active plugins are no longer available on wordpress.org, so they will never receive another security fix: ' . implode( ', ', $closed ) . '. Replace them or accept the risk deliberately.'
					: 'Every active plugin is still published on wordpress.org.',
				'source'      => 'morpheus',
			);
		}

		return $checks;
	}

	/**
	 * The robots.txt finding, or null when the state cannot be established.
	 *
	 * PUBLIC because CLEAN MY SITE includes this finding rather than competing
	 * with it (see class-clean.php): there is one judgement about whether a stale
	 * physical robots.txt is being served, one finding shape, and one fix. Two
	 * copies would eventually disagree about a file on a live site.
	 */
	public static function robots_finding() {
		if ( ! class_exists( 'Morpheus_SEO' ) ) {
			return null;
		}
		$state = Morpheus_SEO::robots_txt_state();
		return is_array( $state ) ? self::robots_check( $state ) : null;
	}

	/**
	 * The robots.txt check, as one of exactly four honest verdicts.
	 *
	 * The LABEL is the good claim and never changes (the same shape every other
	 * check here uses): a `recommended` verdict means the statement below it is
	 * not true right now, and the description says in the site's own words what
	 * was actually found — the dead URL it advertises, or the absence of any
	 * working one. Morpheus_Fixes carries the action for the id.
	 */
	private static function robots_check( $state ) {
		$file = $state['file'];

		if ( empty( $state['physical'] ) ) {
			return array(
				'id'          => 'morpheus_stale_robots_txt',
				'label'       => 'robots.txt is built by WordPress, and its sitemap answers',
				'status'      => 'good',
				'description' => 'There is no physical robots.txt in the site root, so WordPress builds it on every request — including the sitemap line. Nothing to do here.',
				'source'      => 'morpheus',
			);
		}

		if ( empty( $state['served'] ) ) {
			return array(
				'id'          => 'morpheus_stale_robots_txt',
				'label'       => 'robots.txt is built by WordPress, and its sitemap answers',
				'status'      => 'good',
				// A file nobody is serving is debris, not a problem. Saying so is
				// the honest answer, and it is also the reassurance the operator
				// needs after being told a robots.txt file exists on the host.
				'description' => 'A robots.txt file exists at ' . $file . ', but the file being served at /robots.txt is NOT that one — WordPress\'s own is. The leftover file is not affecting anything, so Morpheus is leaving it alone.',
				'source'      => 'morpheus',
			);
		}

		if ( empty( $state['stale'] ) ) {
			return array(
				'id'          => 'morpheus_stale_robots_txt',
				'label'       => 'robots.txt is built by WordPress, and its sitemap answers',
				'status'      => 'good',
				'description' => (string) $state['reason'],
				'source'      => 'morpheus',
			);
		}

		return array(
			'id'          => 'morpheus_stale_robots_txt',
			'label'       => 'robots.txt is built by WordPress, and its sitemap answers',
			'status'      => 'recommended',
			'description' => (string) $state['reason'],
			'source'      => 'morpheus',
		);
	}

	private static function loopback_check() {
		$start = microtime( true );
		$res   = wp_remote_get( rest_url(), array( 'timeout' => 8, 'sslverify' => true ) );
		$ms    = ( microtime( true ) - $start ) * 1000;
		if ( is_wp_error( $res ) ) {
			return array( 'ok' => false, 'ms' => $ms, 'error' => $res->get_error_message() );
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( $code < 200 || $code >= 400 ) {
			return array( 'ok' => false, 'ms' => $ms, 'error' => 'HTTP ' . $code . ' from the site\'s own REST API' );
		}
		return array( 'ok' => true, 'ms' => $ms, 'error' => null );
	}

	/**
	 * Active plugins whose wordpress.org listing is closed — withdrawn plugins
	 * keep working and stop receiving fixes, which is invisible in any update
	 * list. Cached for a day: this is one API call per plugin otherwise.
	 *
	 * Returns null when the answer is not known (no connectivity, or the API
	 * could not be reached), so the caller omits the check rather than claiming
	 * everything is fine.
	 */
	private static function closed_plugins() {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		$active = (array) get_option( 'active_plugins', array() );
		$all    = get_plugins();
		$named  = array();
		foreach ( $active as $file ) {
			if ( isset( $all[ $file ] ) ) {
				$named[ $file ] = $all[ $file ];
			}
		}
		$closed  = array();
		$unknown = false;
		foreach ( $named as $file => $data ) {
			$slug = self::plugin_slug( $file );
			if ( '' === $slug ) {
				continue;
			}
			$state = get_transient( 'morpheus_plugin_state_' . md5( $slug ) );
			if ( false === $state ) {
				$info = self::fetch_plugin_info( $slug );
				if ( null === $info ) {
					$unknown = true;
					continue;
				}
				$state = $info;
				set_transient( 'morpheus_plugin_state_' . md5( $slug ), $state, DAY_IN_SECONDS );
			}
			if ( ! empty( $state['closed'] ) ) {
				$closed[] = ( $data['Name'] ?? $slug );
			}
		}
		return $unknown && ! $closed ? null : $closed;
	}

	private static function plugin_slug( $file ) {
		$parts = explode( '/', (string) $file );
		return count( $parts ) > 1 ? sanitize_key( $parts[0] ) : '';
	}

	/** The wordpress.org plugin info API; null on any failure (never a guess). */
	private static function fetch_plugin_info( $slug ) {
		$url = 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=' . rawurlencode( $slug );
		$res = wp_remote_get( $url, array( 'timeout' => 8 ) );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			return null;
		}
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( ! is_array( $data ) ) {
			return null;
		}
		return array(
			'closed'      => ! empty( $data['error'] ) || ( isset( $data['closed'] ) && $data['closed'] ),
			'last_update' => $data['last_updated'] ?? null,
		);
	}

	// ── Updates ─────────────────────────────────────────────────────────────

	private static function updates() {
		require_once ABSPATH . 'wp-admin/includes/update.php';
		require_once ABSPATH . 'wp-admin/includes/plugin.php';

		$counts = array();
		if ( function_exists( 'wp_get_update_data' ) ) {
			$data   = wp_get_update_data();
			$counts = is_array( $data['counts'] ?? null ) ? $data['counts'] : array();
		}

		$plugins = array();
		foreach ( (array) get_plugin_updates() as $file => $p ) {
			$plugins[] = array(
				'file'        => (string) $file,
				'name'        => self::plain( $p->Name ?? $file ),
				'version'     => (string) ( $p->Version ?? '' ),
				'new_version' => (string) ( $p->update->new_version ?? '' ),
			);
		}

		$themes = array();
		foreach ( (array) get_theme_updates() as $stylesheet => $t ) {
			$themes[] = array(
				'stylesheet'  => (string) $stylesheet,
				'name'        => self::plain( $t->get( 'Name' ) ?: $stylesheet ),
				'version'     => (string) $t->get( 'Version' ),
				'new_version' => (string) ( $t->update['new_version'] ?? '' ),
			);
		}

		$core = array();
		foreach ( (array) get_core_updates() as $c ) {
			$c = (array) $c;
			// 'latest' means "you are current" — not an update.
			if ( empty( $c['response'] ) || 'latest' === $c['response'] ) {
				continue;
			}
			$core[] = array(
				'current'  => (string) ( $c['current'] ?? '' ),
				'version'  => (string) ( $c['version'] ?? '' ),
				'response' => (string) $c['response'],
			);
		}

		return array(
			'counts'     => $counts,
			'plugins'    => $plugins,
			'themes'     => $themes,
			'core'       => $core,
			'checked_at' => self::updates_checked_at(),
		);
	}

	/** When WordPress last asked wordpress.org, so the panel can date the answer. */
	private static function updates_checked_at() {
		$transient = get_site_transient( 'update_plugins' );
		if ( is_object( $transient ) && ! empty( $transient->last_checked ) ) {
			return (int) $transient->last_checked;
		}
		return null;
	}

	private static function auto_updates() {
		$type = function ( $which ) {
			return function_exists( 'wp_is_auto_update_enabled_for_type' )
				? (bool) wp_is_auto_update_enabled_for_type( $which )
				: null;
		};
		$constant = null;
		if ( defined( 'WP_AUTO_UPDATE_CORE' ) ) {
			$constant = is_bool( WP_AUTO_UPDATE_CORE ) ? ( WP_AUTO_UPDATE_CORE ? 'true' : 'false' ) : (string) WP_AUTO_UPDATE_CORE;
		}
		return array(
			'plugins_global'             => $type( 'plugin' ),
			'themes_global'              => $type( 'theme' ),
			// 'unset' is WordPress's default and means major core updates are
			// NOT automatic; only minor/security ones are (since 5.6).
			'core_major'                 => get_site_option( 'auto_update_core_major', 'unset' ),
			'core_minor'                 => get_site_option( 'auto_update_core_minor', 'unset' ),
			'core_constant'              => $constant,
			// The master switch: true here means NOTHING updates automatically.
			'automatic_updater_disabled' => (bool) apply_filters( 'automatic_updater_disabled', false ),
			'email_on_core_update'       => get_site_option( 'auto_core_update_send_email', 'unset' ),
			// Explicit per-item opt-ins, as WordPress stores them.
			'plugins_list'               => array_values( array_map( 'strval', (array) get_site_option( 'auto_update_plugins', array() ) ) ),
			'themes_list'                => array_values( array_map( 'strval', (array) get_site_option( 'auto_update_themes', array() ) ) ),
		);
	}

	// ── Host capability ─────────────────────────────────────────────────────

	private static function host() {
		require_once ABSPATH . 'wp-admin/includes/file.php';

		$uploads       = wp_upload_dir();
		$theme_root    = get_theme_root();
		$plugin_dir    = defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins';
		$file_mods_off = defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS;
		$method        = function_exists( 'get_filesystem_method' ) ? get_filesystem_method() : 'unknown';
		$plugin_write  = wp_is_writable( $plugin_dir );
		$theme_write   = wp_is_writable( $theme_root );

		$blockers = array();
		if ( $file_mods_off ) {
			$blockers[] = 'DISALLOW_FILE_MODS is set in wp-config.php, which forbids all file changes from WordPress';
		}
		if ( 'direct' !== $method ) {
			$blockers[] = 'the filesystem method is "' . $method . '", so writing files needs host credentials WordPress does not have';
		}
		if ( ! $plugin_write ) {
			$blockers[] = 'the plugins directory is not writable by PHP';
		}

		return array(
			'filesystem_method'   => $method,
			'plugin_dir_writable' => (bool) $plugin_write,
			'theme_dir_writable'  => (bool) $theme_write,
			'uploads_writable'    => ! empty( $uploads['basedir'] ) && wp_is_writable( $uploads['basedir'] ),
			'file_mods_disallowed' => (bool) $file_mods_off,
			'file_edit_disallowed' => defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT,
			'memory_limit'        => (string) ini_get( 'memory_limit' ),
			// 0 means "no limit set", which is not the same as unlimited in
			// practice but is what PHP reports.
			'max_execution_time'  => (int) ini_get( 'max_execution_time' ),
			'wp_cron_disabled'    => defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON,
			'multisite'           => is_multisite(),
			'ssl'                 => is_ssl(),
			'can_update_files'    => ! $file_mods_off && 'direct' === $method && $plugin_write,
			'blockers'            => $blockers,
		);
	}

	private static function capability( $host ) {
		return array(
			'update_files' => (bool) $host['can_update_files'],
			'reason'       => $host['can_update_files'] ? null : implode( '; ', $host['blockers'] ),
		);
	}

	// ── Formatting helpers ──────────────────────────────────────────────────

	/** HTML → plain text. Descriptions arrive with markup; the panel renders text. */
	private static function plain( $html ) {
		if ( ! is_string( $html ) ) {
			return '';
		}
		$text = wp_strip_all_tags( str_replace( array( '</p>', '<br>', '<br/>', '<br />' ), "\n", $html ) );
		$text = html_entity_decode( $text, ENT_QUOTES, 'UTF-8' );
		return trim( preg_replace( '/[ \t]{2,}/', ' ', $text ) );
	}

	private static function status( $status ) {
		$status = is_string( $status ) ? strtolower( $status ) : '';
		return in_array( $status, array( 'good', 'recommended', 'critical' ), true ) ? $status : 'unknown';
	}

	/** A badge is either a string or array( 'label' => …, 'color' => … ). */
	private static function badge( $badge ) {
		if ( is_string( $badge ) ) {
			return $badge;
		}
		if ( is_array( $badge ) && isset( $badge['label'] ) ) {
			return self::plain( $badge['label'] );
		}
		return '';
	}

	/**
	 * The links out of a test's `actions` HTML — the "fix it" deep links core
	 * already provides (update-core.php, options-general.php, …). Kept, because
	 * a finding with no way to act on it is the thing to avoid; only this site's
	 * own URLs are returned.
	 *
	 * A root-relative href is resolved against THIS site before it leaves. The
	 * panel renders the value straight into an href inside the Morpheus app,
	 * where a bare `/wp-admin/…` resolves against the app's own origin and 404s
	 * — so a link the operator was told to follow would land on our error page.
	 * Core normally emits absolute action URLs, but the filter below admits a
	 * relative one, and a value that leaves here is the app's to trust.
	 */
	private static function links( $actions ) {
		if ( ! is_string( $actions ) || '' === $actions ) {
			return array();
		}
		$out = array();
		if ( preg_match_all( '/<a[^>]+href=["\']([^"\']+)["\'][^>]*>(.*?)<\/a>/is', $actions, $m, PREG_SET_ORDER ) ) {
			foreach ( $m as $match ) {
				$url = esc_url_raw( $match[1] );
				if ( '' === $url ) {
					continue;
				}
				if ( 0 === strpos( $url, '/' ) ) {
					$url = home_url( $url );
				}
				// Same-site only: an external link in a findings list is noise.
				if ( 0 !== strpos( $url, home_url() ) ) {
					continue;
				}
				$out[] = array(
					'url'   => $url,
					'label' => self::plain( $match[2] ),
				);
			}
		}
		return $out;
	}

	// ── the error log, READ rather than merely measured ─────────────────────

	/** The tail of the file we will actually read. Bounded so a runaway log cannot stall a request. */
	const LOG_TAIL_BYTES = 262144; // 256 KB, sought from the END
	/** Newest lines kept for the panel. */
	const LOG_TAIL_LINES = 400;
	/**
	 * Distinct signatures returned after grouping.
	 *
	 * ⚠️ 40 WAS TOO LOW, and it failed the way a bound always fails: silently, on a real
	 * site. Rob's log had **52** distinct problems and the panel showed 40 — so twelve
	 * were invisible to the operator AND to anyone they pasted it to, with one grey line
	 * as the only hint. Bounded output is right; a bound that hides a quarter of a real
	 * log while looking complete is not. The cap is now high enough that an ordinary site
	 * never meets it, and it is still REPORTED when it bites (`groups_total`).
	 */
	const LOG_MAX_GROUPS = 100;

	/**
	 * The WHOLE file, when the operator asks for it explicitly.
	 *
	 * The tail bounds exist so that opening a panel never pulls a log that can be
	 * gigabytes. They are not a limit on what the operator may READ — Rob, 2026-10-09:
	 * *"put a copy button in there that cappys the lot"* — so there is a second, larger
	 * bound, reached only by pressing a button that says what it does. Still a bound, and
	 * still REPORTED when it bites: an 8 MB cap on a 200 MB log must say so rather than
	 * look complete.
	 */
	const LOG_FULL_BYTES  = 8388608;  // 8 MB
	const LOG_FULL_LINES  = 20000;
	const LOG_FULL_GROUPS = 300;
	/** Raw lines kept per signature, so a group can be opened without shipping the whole log. */
	const LOG_SAMPLES = 3;

	/**
	 * What core's automatic-update run is CALLED in the panel.
	 *
	 * One label, because it is one event: every line `core_update_noise()` recognises
	 * takes this as its message, so the whole update run — six "Automatic updates…"
	 * lines, every "Upgrading plugin 'x'…", and both scrape delimiters, each of which
	 * was its own group before — collapses to a single row the operator can skip.
	 */
	const LOG_NOISE_LABEL = "WordPress's own automatic-update run (core's messages, not a site fault)";

	/**
	 * A path for the panel: relative when it is inside the site, absolute when it is
	 * not. The second case is the whole point of the relocate fix — an operator
	 * cannot find a file they are only told is "outside the web root".
	 */
	private static function display_path( $file ) {
		$file = wp_normalize_path( (string) $file );
		$root = trailingslashit( wp_normalize_path( ABSPATH ) );
		if ( '' !== $file && 0 === strpos( $file, $root ) ) {
			return substr( $file, strlen( $root ) );
		}
		return $file;
	}

	/**
	 * The PHP error log, parsed and grouped. THE OTHER HALF OF A CHECK THAT ONLY
	 * LOOKED.
	 *
	 * `Morpheus_Clean::debug_log_state()` has always opened this file — to decide
	 * whether the web server is SERVING it, by comparing its bytes with the URL's.
	 * That answers "is this file a leak" and nothing else: nothing in the plugin
	 * read the errors themselves, so the one question an owner actually has
	 * ("what is breaking?") had no answer anywhere in the product, in Morpheus or
	 * in wp-admin.
	 *
	 * READ-ONLY, and bounded three ways, because a log is the one file on a site
	 * that can be gigabytes:
	 *   * seeked from the END — at most LOG_TAIL_BYTES is ever read;
	 *   * at most LOG_TAIL_LINES lines are parsed;
	 *   * at most LOG_MAX_GROUPS signatures and LOG_SAMPLES raw lines per
	 *     signature are returned.
	 * Every bound is REPORTED when it bites (`truncated`, `lines_read`,
	 * `lines_in_tail`, `groups_total`), because a truncated list that looks
	 * complete is worse than no list — the same reason the SEO module caps a
	 * description rather than silently cutting it.
	 *
	 * ⚠️ `lines_read` AND `lines_in_tail` ARE TWO DIFFERENT FACTS, and the harness
	 * caught the first version conflating them: it reported the number of lines in
	 * the bytes it had READ (thousands) under a name the panel rendered as "showing
	 * the newest N lines" (hundreds). A number that overstates what the operator is
	 * looking at is the same defect as a silent truncation, so the two are named
	 * separately and asserted separately.
	 *
	 * What it deliberately does NOT do: invent a severity WordPress did not write,
	 * trace a stack, or claim a cause. Each entry keeps the log's own words, its
	 * severity, and the file:line the log itself names — with the site's own
	 * ABSPATH prefix removed, because the panel is showing an operator their own
	 * site, not an absolute server path they cannot act on.
	 *
	 * @param array $args `lines` — how many of the newest lines to parse (capped).
	 * @return array
	 */
	public static function log_tail( $args = array() ) {
		// `full` is an EXPLICIT ask for the whole file. It changes the bounds, not the
		// rules: the read is still bounded, still seeked from the end, and still says so
		// when the bound bites.
		$full   = ! empty( $args['full'] );
		$max_lines  = $full ? self::LOG_FULL_LINES : self::LOG_TAIL_LINES;
		$max_bytes  = $full ? self::LOG_FULL_BYTES : self::LOG_TAIL_BYTES;
		$max_groups = $full ? self::LOG_FULL_GROUPS : self::LOG_MAX_GROUPS;

		$want  = isset( $args['lines'] ) ? (int) $args['lines'] : $max_lines;
		$want  = max( 1, min( $max_lines, $want ) );
		// THE file WordPress is writing — see morpheus_debug_log_file(). This used
		// to be the literal default path, so a site that logs elsewhere showed an
		// empty panel with a footnote saying so. That was survivable while nothing
		// moved the log; it is not survivable now that Morpheus offers to move it
		// out of the web root, because the fix would blind the reader.
		$file  = morpheus_debug_log_file();

		$out = array(
			'ok'            => true,
			'path'          => self::display_path( $file ),
			'exists'        => false,
			'readable'      => false,
			'bytes'         => 0,
			'modified'      => null,
			'truncated'     => false,
			'lines_read'    => 0,
			'lines_in_tail' => 0,
			'entries'       => array(),
			'groups'        => array(),
			'groups_total'  => 0,
			'counts'        => array( 'fatal' => 0, 'warning' => 0, 'notice' => 0, 'deprecated' => 0, 'other' => 0 ),
			// Why there is nothing to show, in the plugin's own words, so the panel
			// never has to invent a reason — or show an empty list as "all clear".
			'not_read'      => null,
			// Which read this was. The panel says so, because "8000 lines" means
			// something different when the operator asked for the whole file.
			'scope'         => $full ? 'whole' : 'tail',
			// WordPress can be told to log somewhere else; when it is, this says so
			// rather than letting the panel imply it is reading that file.
			'configured'    => null,
		);

		// Which file this is, for the panel: relative when it is inside the site,
		// ABSOLUTE when it is not — because a path outside the web root is the one
		// thing an operator has to be able to find, and "wp-content/debug.log" would
		// be a lie about what was read.
		$default = trailingslashit( WP_CONTENT_DIR ) . 'debug.log';
		if ( $file !== $default ) {
			$out['configured'] = $file;
		}

		if ( ! file_exists( $file ) ) {
			$out['not_read'] = 'missing';
			return $out;
		}
		$out['exists'] = true;

		if ( ! is_readable( $file ) ) {
			$out['not_read'] = 'unreadable';
			return $out;
		}
		$out['readable'] = true;

		$size = (int) @filesize( $file );
		$out['bytes']    = $size;
		$out['modified'] = (int) @filemtime( $file ) ? gmdate( 'c', (int) @filemtime( $file ) ) : null;

		if ( 0 === $size ) {
			$out['not_read'] = 'empty';
			return $out;
		}

		$read  = min( $size, $max_bytes );
		$out['truncated'] = $read < $size;

		$fh = @fopen( $file, 'rb' );
		if ( ! $fh ) {
			$out['not_read'] = 'unreadable';
			return $out;
		}
		if ( $read < $size ) {
			@fseek( $fh, -$read, SEEK_END );
		}
		$blob = @fread( $fh, $read );
		@fclose( $fh );

		if ( ! is_string( $blob ) || '' === $blob ) {
			$out['not_read'] = 'unreadable';
			return $out;
		}

		$raw = preg_split( '/\r\n|\n|\r/', $blob );
		// When we started mid-file the first element is the back half of a line we
		// did not read; dropping it is why the tail is honest about being a tail.
		if ( $out['truncated'] && count( $raw ) > 1 ) {
			array_shift( $raw );
		}
		// A trailing newline yields one empty final element.
		if ( count( $raw ) && '' === end( $raw ) ) {
			array_pop( $raw );
		}

		$out['lines_in_tail'] = count( $raw );
		$tail                 = array_slice( $raw, -$want );
		$out['lines_read']    = count( $tail );

		$groups = array();
		$entries = array();
		foreach ( $tail as $line ) {
			$e = self::parse_log_line( $line );
			$out['counts'][ $e['level'] ] = ( isset( $out['counts'][ $e['level'] ] ) ? $out['counts'][ $e['level'] ] : 0 ) + 1;

			$key = $e['level'] . '|' . $e['file'] . '|' . self::log_signature( $e['message'] );
			if ( ! isset( $groups[ $key ] ) ) {
				$groups[ $key ] = array(
					'level'    => $e['level'],
					'file'     => $e['file'],
					'line'     => $e['line'],
					'message'  => $e['message'],
					'count'    => 0,
					'note'     => isset( $e['note'] ) ? $e['note'] : '',
					'first_at' => $e['at'],
					'last_at'  => $e['at'],
					'samples'  => array(),
				);
			}
			$groups[ $key ]['count']++;
			if ( $e['at'] !== '' ) {
				if ( '' === $groups[ $key ]['first_at'] ) {
					$groups[ $key ]['first_at'] = $e['at'];
				}
				$groups[ $key ]['last_at'] = $e['at'];
			}
			if ( count( $groups[ $key ]['samples'] ) < self::LOG_SAMPLES ) {
				$groups[ $key ]['samples'][] = $e['raw'];
			}
		}

		// THE COUNT IS THE DIAGNOSIS, and it only exists here.
		//
		// `parse_log_line()` can only say WHAT a line is; one database outage and forty of
		// them are the same line. The difference — a host restarting MySQL at a quiet hour,
		// or a fault that keeps happening — is in how many, and how far apart, and that is
		// only known once the lines are grouped. Rob asked exactly this: *"if you cant see
		// the number how do you make the classification"*. It cannot, so it does not: the
		// sentence is finished here.
		foreach ( $groups as $gkey => $g ) {
			if ( '' === (string) $g['note'] ) {
				continue;
			}
			$groups[ $gkey ]['note'] = $g['note'] . ' ' . self::downtime_scale( $g['count'], $g['first_at'], $g['last_at'] );
		}

		// Newest first: the log is append-only, so reading it backwards is what an
		// operator wants at the top of a list. `$tail` is already at most $want long.
		$out['entries'] = array_reverse( $tail );

		$out['groups_total'] = count( $groups );
		$list = array_values( $groups );
		usort( $list, function ( $a, $b ) {
			if ( $a['count'] === $b['count'] ) {
				return strcmp( (string) $b['last_at'], (string) $a['last_at'] );
			}
			return $b['count'] - $a['count'];
		} );
		$out['groups'] = array_slice( $list, 0, $max_groups );

		return $out;
	}

	/**
	 * Does this line say the SITE WAS DOWN? Returns the sentence to show, or false.
	 *
	 * Kept as a table with a reason each rather than a severity keyword, because none of
	 * these carries one: PHP writes a database outage as "PHP Warning:", and so does a
	 * deprecated function call. The panel shows the reason beside the group.
	 *
	 * PUBLIC and pure so the harness can exercise the table directly, the same reason
	 * Morpheus_Clean::served_is_the_file() is: a rule reachable only through a boot is a
	 * rule nobody can prove.
	 */
	/**
	 * How BAD is it — one, or a pattern? The half of the sentence the line cannot carry.
	 *
	 * A single connection failure is what a host restarting MySQL looks like from PHP, and
	 * it is usually nothing. The same message forty times across an afternoon is a fault,
	 * and the times are what a host needs. Neither reading is invented: both are stated as
	 * what the SHAPE of the evidence looks like, with the times quoted, and the operator
	 * decides.
	 *
	 * PUBLIC and pure, like downtime_reason(), so the harness can exercise each shape
	 * without a boot.
	 */
	public static function downtime_scale( $count, $first_at, $last_at ) {
		$count = (int) $count;
		$first = self::log_stamp( $first_at );
		$last  = self::log_stamp( $last_at );

		if ( $count <= 1 || ! $first || ! $last ) {
			return $count <= 1
				? 'Seen once. One of these is usually the database server being restarted — often by your host, at a quiet hour — and it matters only if it repeats.'
				: 'Seen ' . $count . ' times in the part of the log Morpheus read.';
		}

		$minutes = (int) round( abs( $last - $first ) / 60 );
		$when    = gmdate( 'j M Y H:i', $last ) . ' UTC';

		if ( $minutes <= 10 ) {
			return 'Seen ' . $count . ' times within ' . max( 1, $minutes ) . ' minute' . ( 1 === $minutes ? '' : 's' )
				. ', ending ' . $when . '. A burst that tight is what a database restart looks like from PHP.';
		}

		return 'Seen ' . $count . ' times between ' . gmdate( 'j M Y H:i', $first ) . ' and ' . $when
			. ' — a spread that wide is not a restart, it is a fault that keeps happening. These times are what your host needs.';
	}

	/** A log timestamp (`[08-Oct-2026 13:07:57 UTC]`, unbracketed) as a Unix time, or 0. */
	private static function log_stamp( $at ) {
		$at = is_string( $at ) ? trim( $at ) : '';
		if ( '' === $at ) {
			return 0;
		}
		foreach ( array( 'd-M-Y H:i:s T', 'd-M-Y H:i:s', 'Y-m-d H:i:s' ) as $format ) {
			$d = DateTime::createFromFormat( $format, $at );
			if ( $d instanceof DateTime ) {
				return (int) $d->getTimestamp();
			}
		}
		return 0;
	}

	/**
	 * WordPress core's OWN automatic-update chatter — one problem, not forty-six.
	 *
	 * `WP_Automatic_Updater::run()` writes its progress to the debug log whenever
	 * WP_DEBUG_LOG is on: "Automatic updates starting…", "Upgrading plugin 'x'…",
	 * "Scraping home page…", and the `###### wp_scraping_result_*` delimiters that
	 * `has_fatal_error()` wraps its post-update scrape in. None of it is a fault and
	 * all of it is expected — and on a real log it produced FORTY-SIX of the hundred
	 * "distinct problems" the panel was listing: six update messages split three ways
	 * by month (see the timestamp note in parse_log_line()) plus one group per
	 * one-off hash in the scrape delimiters.
	 *
	 * The needles are named from core's own source, not guessed —
	 * wp-admin/includes/class-wp-automatic-updater.php. `Loopback request failed:` is
	 * deliberately NOT one of them: that means core could not RUN the fatal-error
	 * check, which is worth showing rather than folding away.
	 *
	 * PUBLIC and pure so the harness can exercise the table without a boot.
	 */
	public static function core_update_noise( $message ) {
		$needles = array(
			'Automatic updates starting...',
			'Automatic updates complete.',
			'Automatic plugin updates starting...',
			'Automatic plugin updates complete.',
			'Automatic theme updates starting...',
			'Automatic theme updates complete.',
			"Upgrading plugin '",
			'Upgrading theme ',
			' has been upgraded.',
			' is inactive and will not be checked for fatal errors.',
			'has no fatal errors.',
			'Scraping home page...',
			'wp_scraping_result_start:',
			'wp_scraping_result_end:',
		);
		foreach ( $needles as $needle ) {
			if ( false !== strpos( (string) $message, $needle ) ) {
				return true;
			}
		}
		return false;
	}

	public static function downtime_reason( $line ) {
		$shapes = array(
			'mysqli_real_connect()'                     => 'PHP could not reach the database server. While this is happening WordPress answers every page with "Error establishing a database connection" — visitors saw an error, not a slow site.',
			'Error establishing a database connection'  => 'The database was unreachable when a page was requested. This is the visitor-facing face of a database outage.',
			'MySQL server has gone away'                => 'The connection to the database was dropped mid-request.',
			'Lost connection to MySQL server'           => 'The connection to the database was dropped mid-request.',
			'Allowed memory size'                       => 'A request ran out of memory and was killed before it finished. On a shop that is usually a page or an admin action that cannot complete.',
			'Maximum execution time'                    => 'A request was killed for taking too long. That is a page or an admin action that never returned.',
			'upstream'                                  => 'The host\'s own proxy could not reach the site — often a PHP worker restart or an overloaded server, and it is the host\'s to explain.',
		);
		foreach ( $shapes as $needle => $why ) {
			if ( false !== stripos( $line, $needle ) ) {
				return $why;
			}
		}
		return false;
	}

	/**
	 * One line of a PHP error log.
	 *
	 * The shape WordPress writes is
	 *   [23-Sep-2026 12:00:00 UTC] PHP Warning:  Undefined array key "x" in /path/f.php on line 12
	 * but a log accumulates whatever anything on the site wrote, so an unrecognised
	 * line is kept as `other` with its own text rather than dropped — the point of
	 * reading a log is not to filter it down to the lines we anticipated.
	 *
	 * PUBLIC and pure so the harness can exercise the LEVEL, not only the signature table:
	 * the bug this fixes was a database outage being written down as a warning, and a
	 * table nobody can call proves nothing about that.
	 */
	public static function parse_log_line( $line ) {
		$out = array( 'at' => '', 'level' => 'other', 'message' => trim( (string) $line ), 'file' => '', 'line' => 0, 'raw' => (string) $line );

		// THE SITE WAS DOWN, which is a different thing from a warning.
		//
		// A handful of PHP messages mean the site could not serve a request at all — the
		// database unreachable, memory exhausted, a request killed for running too long —
		// and they are written with the same words as the noise around them ("PHP
		// Warning:"). Left as warnings they sit inside twenty routine ones: that is how a
		// database outage on a real shop stayed invisible among 52 problems (2026-10-08,
		// `mysqli_real_connect(): (HY000/2002): No such file or directory`). Raised, and
		// given a sentence the panel can show, because "the site was down" is the one
		// thing an owner must not have to interpret.
		$downtime = self::downtime_reason( (string) $line );
		if ( false !== $downtime ) {
			$out['level'] = 'fatal';
			$out['note']  = $downtime;
		}

		if ( ! preg_match( '/^\[([^\]]+)\]\s+(?:PHP\s+)?(Fatal error|Parse error|Recoverable fatal error|Warning|Notice|Deprecated|Strict Standards)\s*:\s*(.*)$/i', (string) $line, $m ) ) {
			// ── THE TIMESTAMP IS PART OF THE GROUPING KEY IF YOU LEAVE IT IN THE TEXT ──
			//
			// Only a `PHP <severity>:` line has its stamp parsed out, above. Every OTHER
			// line keeps it inside the message, and `log_signature()` strips digits — but
			// a MONTH IS LETTERS. So one core updater line written in August, September
			// and October grouped as three separate problems (9 + 65 + 38), and the panel
			// said "3 distinct problems" about one sentence. Taking the stamp out here is
			// what makes the same line group once, whichever month wrote it.
			if ( preg_match( '/^\[(\d{1,2}-[A-Za-z]{3}-\d{4} \d{2}:\d{2}:\d{2}(?:\s+[A-Za-z]{1,5})?)\]\s*(.*)$/s', (string) $line, $t ) ) {
				$out['at']      = trim( $t[1] );
				$out['message'] = trim( $t[2] );
			}

			// Core's own automatic-update run is expected and is not a fault. Folded under
			// one label so it cannot bury the handful of lines that ARE — never over a
			// downtime classification, which is the one thing that must not be talked down.
			if ( 'fatal' !== $out['level'] && self::core_update_noise( $out['message'] ) ) {
				$out['message'] = self::LOG_NOISE_LABEL;
				$out['file']    = '';
				$out['line']    = 0;
			}

			// Keeps the level and the note: an unusual shape is still a site that went down.
			return $out;
		}

		$sev = strtolower( $m[2] );
		if ( 'fatal' === $out['level'] ) {
			// Already raised as downtime — a PHP "Warning:" must not talk it back down.
		} elseif ( false !== strpos( $sev, 'fatal' ) || false !== strpos( $sev, 'parse' ) ) {
			$out['level'] = 'fatal';
		} elseif ( false !== strpos( $sev, 'warning' ) ) {
			$out['level'] = 'warning';
		} elseif ( false !== strpos( $sev, 'notice' ) ) {
			$out['level'] = 'notice';
		} elseif ( false !== strpos( $sev, 'deprecated' ) ) {
			$out['level'] = 'deprecated';
		} else {
			$out['level'] = 'other';
		}

		$out['at']      = trim( $m[1] );
		$out['message'] = trim( $m[3] );

		// `… on line 12` for warnings/notices, `…:12` for fatals — both are the
		// log's own words, and we only ever take the file and line out of them.
		if ( preg_match( '/^(.*?) in (\S.*?) on line (\d+)$/', $out['message'], $f ) ) {
			$out['message'] = $f[1];
			$out['file']    = self::log_relative( $f[2] );
			$out['line']    = (int) $f[3];
		} elseif ( preg_match( '/^(.*?) in (\S.*?):(\d+)$/', $out['message'], $f ) ) {
			$out['message'] = $f[1];
			$out['file']    = self::log_relative( $f[2] );
			$out['line']    = (int) $f[3];
		}

		return $out;
	}

	/** A path the operator can act on: relative to the site, not the server's absolute one. */
	private static function log_relative( $path ) {
		$path = wp_normalize_path( trim( (string) $path ) );
		$root = wp_normalize_path( ABSPATH );
		if ( '' !== $root && 0 === strpos( $path, $root ) ) {
			return ltrim( substr( $path, strlen( $root ) ), '/' );
		}
		return $path;
	}

	/**
	 * The grouping key for a message: the same error written twice with different
	 * ids is one problem, and the numbers are the only part that differs.
	 *
	 * Digits become `N` — a post id, a count, a byte size and a line number all
	 * vary per occurrence while the sentence does not. Quoted values are left
	 * ALONE on purpose: `Undefined array key "price"` and `… "sku"` are two
	 * different bugs in two different places, and merging them would hide one.
	 */
	private static function log_signature( $message ) {
		return preg_replace( '/\d+/', 'N', (string) $message );
	}
}
