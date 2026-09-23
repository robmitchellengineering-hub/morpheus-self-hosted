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
		$unmapped = array_merge( Morpheus_Fixes::annotate( $tests ), Morpheus_Fixes::annotate( $own ) );

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
			'async_not_run'     => self::async_tests(),
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

		foreach ( (array) ( $registered['direct'] ?? array() ) as $id => $test ) {
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
		$robots = class_exists( 'Morpheus_SEO' ) ? Morpheus_SEO::robots_txt_state() : null;
		if ( is_array( $robots ) ) {
			$checks[] = self::robots_check( $robots );
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
				// Same-site only: an external link in a findings list is noise.
				if ( 0 !== strpos( $url, home_url() ) && 0 !== strpos( $url, '/' ) ) {
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
}
