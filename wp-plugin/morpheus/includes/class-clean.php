<?php
/**
 * CLEAN MY SITE — what is on this server that nobody asked for.
 *
 * WHY THIS IS NOT PART OF THE HEALTH SCAN
 *
 * The health scan asks WordPress whether the site is well; it is fast enough to
 * run when a panel opens, and it is cached for five minutes so it can be. This
 * asks a different and much heavier question — a checksum pass over every core
 * file, an inventory of uploads/, mu-plugins, the site root, admins and cron,
 * and (bounded) a download of wordpress.org plugin packages to compare against.
 * Running that on panel open would be a performance bug, so:
 *
 *   * it is its own signed request (`action: clean` on the same /health route,
 *     with its own switch), so the app decides when to spend it;
 *   * it has its OWN cache, so a re-open re-reads the last answer rather than
 *     re-hashing the site;
 *   * and it reports what it did not reach — see BOUNDED, below.
 *
 * THE FOUR RULES, WHICH ARE THE DESIGN
 *
 *   1. NEVER DELETE — QUARANTINE. This class only LOOKS. Every removal lives in
 *      Morpheus_Fixes, and every one of them renames with a UTC timestamp and
 *      reports the new name as the operator's undo.
 *   2. NOTHING HERE WRITES. scan() writes only its own cache transient. It does
 *      not repair, quarantine, re-download or update anything.
 *   3. ANYTHING RISKY IS `guided`. A modified core file, a plugin file that does
 *      not match its published package, an admin account, a cron hook we cannot
 *      attribute: reported with an exact instruction and an entry in
 *      Morpheus_Fixes::registry(), never applied by an automated pass. The
 *      registry's kind is the decision, and this class must not second-guess it.
 *   4. BOUNDED, AND HONEST ABOUT WHAT IT SKIPPED. Every expensive loop carries a
 *      hard cap: a count and a wall-clock budget. Hitting either is recorded in
 *      `skipped` with how far it got, and `limits` carries the numbers that were
 *      measured. "We found nothing" and "we stopped looking early" must never
 *      read the same — see scan()'s docblock for the measurement.
 *
 * A FALSE POSITIVE MUST NOT BE ABLE TO BREAK A LIVE SHOP. That is why the three
 * automatic fixes are all renames of files that have no business existing (a PHP
 * file under uploads/, a wp-config backup in the site root, a publicly readable
 * debug.log), why each one verifies after the fact and puts the file back if the
 * change does not hold, and why everything else is a report.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Clean {

	/** How long a clean scan is reused. Longer than the health scan: it costs more. */
	const CACHE_TTL = 900;

	/** The cache key, named so a harness can clear it honestly. */
	const CACHE_KEY = 'morpheus_clean_scan';

	/** A file changed within this window is "recent" and worth naming. */
	const RECENT_DAYS = 7;

	/** How many core files one pass will hash. WordPress 6.7 publishes 3,224. */
	const MAX_HASH_FILES = 4000;

	/** Wall-clock budget for the core checksum pass, in seconds. */
	const HASH_TIME_BUDGET = 8.0;

	/** Hard cap on directory entries walked under uploads/. */
	const MAX_UPLOADS_FILES = 6000;

	/** Wall-clock budget for the uploads walk, in seconds. */
	const UPLOADS_TIME_BUDGET = 5.0;

	/** Wall-clock budget for the recent-files walk, in seconds. */
	const RECENT_TIME_BUDGET = 6.0;

	/** How many recently-modified files are listed before the list is truncated. */
	const MAX_RECENT_FILES = 40;

	/** How many wordpress.org plugin packages one pass will download and compare. */
	const PACKAGE_PLUGINS_CAP = 3;

	/** Total bytes of plugin packages one pass will download. */
	const PACKAGE_BYTES_CAP = 4194304; // 4 MB

	/** Wall-clock budget for the plugin package comparison, in seconds. */
	const PACKAGE_TIME_BUDGET = 10.0;

	/** How long a wordpress.org plugin-info answer is reused. */
	const PLUGIN_INFO_TTL = 43200; // 12 hours

	/** How many admin-capable accounts are listed before the list is truncated. */
	const MAX_ADMINS = 50;

	/**
	 * The names in the site root that are a credential leak, checked exactly.
	 *
	 * An ALLOW-LIST, not a deny-list, and deliberately narrow: this mechanism
	 * moves files out of the web root, so a pattern that is one character too
	 * wide is a bug that eats something real. `wp-config.php` itself is NOT here
	 * and must never be — it is the live configuration.
	 *
	 * The live site this was built for answers 403 for /wp-config.php.bak where
	 * an absent file answers 404, which is how the owner found out it was there.
	 * We detect it on the filesystem, which is stronger than that probe.
	 */
	public static function root_backup_names() {
		return array(
			'wp-config.php.bak', 'wp-config.php.old', 'wp-config.php.orig',
			'wp-config.php.save', 'wp-config.php.txt', 'wp-config.php.swp',
			'wp-config.php.copy', 'wp-config.php.backup', 'wp-config.php~',
			'wp-config.bak', 'wp-config.old', 'wp-config.txt', 'wp-config.save',
			'.env', '.env.bak', '.env.old', '.env.save', '.env.txt',
			'.env.local', '.env.production', '.env.staging', '.env.backup',
		);
	}

	/**
	 * Run the clean scan, or return the cached one.
	 *
	 * MEASURED, NOT CLAIMED
	 *
	 * The payload carries `duration_ms` (what this pass actually cost) and
	 * `limits` (the caps it ran under and how far it got). Those numbers are the
	 * evidence for "this is bounded": if a pass on a big site exceeds the
	 * envelopes the caller can hold open, the answer is to tighten a constant
	 * here and say so, not to hold a silent request open.
	 *
	 * @param bool $force bypass the cache. The app forces the first scan of a
	 *                    session; a panel re-open reads the cache.
	 */
	public static function scan( $force = false ) {
		if ( ! $force ) {
			$cached = get_transient( self::CACHE_KEY );
			if ( is_array( $cached ) ) {
				$cached['cached'] = true;
				return $cached;
			}
		}

		$started = microtime( true );
		$skipped = array();
		$limits  = array();
		$findings = array();

		// WordPress's own helpers, loaded the way the admin screen loads them —
		// get_core_checksums() reaches get_core_updates() and the plugin/theme
		// upgrade helpers, and without these includes the FIRST check is a fatal
		// undefined function with no output at all (the trap class-health.php
		// documents, hit again the hard way).
		self::admin_includes();

		// Worst-first by consequence, so a capped pass that stops early has
		// already answered the questions that matter most.
		//
		// An explicit switch rather than a variable method call: every check has a
		// different signature, and a typo in a dynamic call is a silent no-check.
		$checks = array( 'uploads_php', 'root_config_backups', 'public_debug_log', 'core_checksums', 'plugin_checksums', 'mu_plugins', 'admin_users', 'cron_events', 'recent_files' );
		foreach ( $checks as $check ) {
			switch ( $check ) {
				case 'uploads_php':
					$found = self::uploads_php( $skipped, $limits );
					break;
				case 'root_config_backups':
					$found = self::root_config_backups( $skipped, $limits );
					break;
				case 'public_debug_log':
					$found = self::public_debug_log( $skipped, $limits );
					break;
				case 'core_checksums':
					$found = self::core_checksums( $skipped, $limits );
					break;
				case 'plugin_checksums':
					$found = self::plugin_checksums( $skipped, $limits );
					break;
				case 'mu_plugins':
					$found = self::mu_plugins( $skipped, $limits );
					break;
				case 'admin_users':
					$found = self::admin_users( $skipped, $limits );
					break;
				case 'cron_events':
					$found = self::cron_events( $skipped, $limits );
					break;
				case 'recent_files':
					$found = self::recent_files( $skipped, $limits );
					break;
				default:
					$found = null;
			}
			// A check returns ONE finding (or null). Casting it to an array here
			// would iterate its VALUES — which meant every check but the robots one
			// silently produced nothing, and the harness that runs against a real
			// WordPress is what caught it.
			if ( is_array( $found ) && ! empty( $found['id'] ) ) {
				$findings[] = $found;
			}
		}

		// The stale physical robots.txt is already built and already has a fix
		// (class-fixes.php's quarantine_robots_txt). CLEAN MY SITE includes it
		// rather than competing with it: the state is read through the same
		// Morpheus_SEO::robots_txt_state() the health scan uses, and the finding
		// is produced by the same function, so the two screens cannot disagree.
		$robots = Morpheus_Health::robots_finding();
		if ( is_array( $robots ) ) {
			$findings[] = $robots;
		}

		$limits['seconds'] = round( microtime( true ) - $started, 2 );

		// Every finding carries its action, and anything attention-worthy with no
		// registered action is REPORTED rather than left as prose — a new check
		// here cannot quietly become a description with no way to act on it.
		$unmapped = Morpheus_Fixes::annotate( $findings );

		// What the LAST attempt at each of these did, if there was one. A refusal
		// that leaves the finding looking untouched reads to the operator as a
		// broken button — the panel rescans, the count is the same, and nothing
		// on screen says why. The record is read from the site (one option), not
		// from the panel's memory, so it survives a reload and belongs to the
		// site rather than to whoever pressed it. A record is never a claim: the
		// finding's own status is unchanged by it.
		Morpheus_Fixes::attach_attempts( $findings );

		$result = array(
			'scan_version'   => 1,
			'plugin_version' => MORPHEUS_VERSION,
			'wp_version'     => get_bloginfo( 'version' ),
			'php_version'    => PHP_VERSION,
			'generated_at'   => gmdate( 'c' ),
			'duration_ms'    => (int) round( ( microtime( true ) - $started ) * 1000 ),
			'findings'       => $findings,
			'unmapped'       => $unmapped,
			'limits'         => $limits,
			'skipped'        => $skipped,
		);
		$result['cached'] = false;
		set_transient( self::CACHE_KEY, $result, self::CACHE_TTL );
		return $result;
	}

	/** Discard the cached scan — used by a forced scan's caller and by tests. */
	public static function forget() {
		delete_transient( self::CACHE_KEY );
	}

	// ── Shared plumbing ─────────────────────────────────────────────────────

	/**
	 * The admin includes the WordPress helpers under us need.
	 *
	 * Not optional, and not obvious: `get_core_checksums()` lives in
	 * wp-admin/includes/update.php, `get_plugins()` in plugin.php, and
	 * `get_filesystem_method()` in file.php. Missing any one of them is a fatal
	 * undefined function on a signed REST request.
	 */
	private static function admin_includes() {
		foreach ( array( 'admin.php', 'update.php', 'plugin.php', 'file.php', 'misc.php' ) as $file ) {
			$path = ABSPATH . 'wp-admin/includes/' . $file;
			if ( file_exists( $path ) ) {
				require_once $path;
			}
		}
	}

	/** A path relative to ABSPATH, for display. Absolute when it is not under it. */
	private static function rel( $path ) {
		$base = trailingslashit( self::slash( ABSPATH ) );
		$p    = self::slash( $path );
		return 0 === strpos( $p, $base ) ? substr( $p, strlen( $base ) ) : $p;
	}

	/**
	 * A finding, in exactly the shape WordPress's own health tests produce.
	 *
	 * One shape for both sources is what lets the panel render them in one list;
	 * the `source` field is what stops our verdict being read as WordPress's.
	 */
	private static function finding( $id, $label, $status, $description, $details = array() ) {
		$f = array(
			'id'          => $id,
			'label'       => $label,
			'status'      => $status,
			'badge'       => '',
			'description' => $description,
			'links'       => array(),
			'source'      => 'morpheus',
		);
		if ( $details ) {
			$f['details'] = array_values( $details );
		}
		return $f;
	}

	/** One row of a finding's evidence. Nothing here is an opinion. */
	private static function row( $file, $size = null, $mtime = null, $note = null ) {
		$row = array( 'file' => (string) $file );
		if ( null !== $size ) {
			$row['size'] = (int) $size;
		}
		if ( null !== $mtime ) {
			$row['mtime'] = (int) $mtime;
			$row['mtime_iso'] = gmdate( 'c', (int) $mtime );
		}
		if ( null !== $note ) {
			$row['note'] = (string) $note;
		}
		return $row;
	}

	/**
	 * Record that a check did not finish, and how far it got.
	 *
	 * A skip is not a pass. Every caller of this puts a sentence in the operator's
	 * words beside a number, because "checked 2,500 files" without "of 3,224" is
	 * the reassurance this whole class is written to avoid.
	 */
	private static function skip( &$skipped, $check, $reason, $reached = null, $of = null ) {
		$entry = array( 'check' => $check, 'reason' => $reason );
		if ( null !== $reached ) {
			$entry['reached'] = (int) $reached;
		}
		if ( null !== $of ) {
			$entry['of'] = (int) $of;
		}
		$skipped[] = $entry;
	}

	/** Every file under $dir, capped by count and by wall clock. */
	private static function walk( $dir, $cap, $budget, &$skipped, $check ) {
		$out    = array();
		$seen   = 0;
		$start  = microtime( true );
		$capped = false;
		if ( ! is_dir( $dir ) ) {
			return $out;
		}
		try {
			$it = new RecursiveIteratorIterator(
				new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
				RecursiveIteratorIterator::SELF_FIRST
			);
			foreach ( $it as $info ) {
				if ( $info->isDir() ) {
					continue;
				}
				$seen++;
				if ( $seen > $cap || ( microtime( true ) - $start ) > $budget ) {
					$capped = true;
					break;
				}
				$out[] = array(
					'path'  => self::slash( $info->getPathname() ),
					'size'  => (int) $info->getSize(),
					'mtime' => (int) $info->getMTime(),
				);
			}
		} catch ( Exception $e ) {
			self::skip( $skipped, $check, 'the directory could not be read (' . $e->getMessage() . ')' );
			return $out;
		}
		if ( $capped ) {
			self::skip(
				$skipped,
				$check,
				'there are more files than this pass will look at, so it stopped early — the list below is NOT the whole directory',
				$seen - 1,
				$cap
			);
		}
		return $out;
	}

	// ── 1. PHP under uploads/ ───────────────────────────────────────────────

	/**
	 * DETECTION RULE: a regular file under the uploads directory whose name ends
	 * in an extension the web server executes as PHP.
	 *
	 * WHY IT IS NOT OVER-EAGER: the media library holds images, documents, video
	 * and their resized copies. WordPress itself has never written a .php file
	 * there, and a plugin that needs code in uploads/ is either doing something
	 * unusual or has been turned into a loader. The extension list is the narrow
	 * one the server actually executes — `.php`, `.phtml`, `.php3/4/5/7`,
	 * `.phps`, `.pht` — so a `.php.txt` or a `.php.bak` (which the server serves
	 * as text) is NOT flagged, because they cannot execute.
	 *
	 * This is the one check whose fix is `auto`: renaming a file that cannot
	 * legitimately be there, with the undo named on screen.
	 */
	/**
	 * The executable-PHP files under uploads/, right now.
	 *
	 * PUBLIC because the fix re-asks this question when it runs instead of
	 * trusting the cached scan — the folder may have changed, and moving a file
	 * on the strength of a fifteen-minute-old answer is how the wrong thing gets
	 * renamed. One enumeration rule, two callers.
	 *
	 * @return array {files: string[], base: string, scanned: int, cap: int, capped: bool}
	 */
	public static function uploads_php_files() {
		$uploads = wp_upload_dir();
		$base    = isset( $uploads['basedir'] ) ? $uploads['basedir'] : ( WP_CONTENT_DIR . '/uploads' );
		$skipped = array();
		$files   = self::walk( $base, self::MAX_UPLOADS_FILES, self::UPLOADS_TIME_BUDGET, $skipped, 'uploads_php' );
		$capped  = false;
		foreach ( $skipped as $s ) {
			if ( 'uploads_php' === ( $s['check'] ?? '' ) ) {
				$capped = true;
			}
		}
		$hits = array();
		foreach ( $files as $f ) {
			// The narrow list of extensions a web server actually EXECUTES. A
			// `.php.txt` or `.php.bak` is served as text and cannot run, so it is
			// not flagged: a check that fires on files which cannot do anything
			// is how a real finding gets ignored.
			if ( preg_match( '/\.(php|phtml|phps|pht|php[3-7])$/i', $f['path'] ) ) {
				$hits[] = $f['path'];
			}
		}
		return array( 'files' => $hits, 'base' => $base, 'scanned' => count( $files ), 'cap' => self::MAX_UPLOADS_FILES, 'capped' => $capped );
	}

	private static function uploads_php( &$skipped, &$limits ) {
		$found = self::uploads_php_files();
		$base  = $found['base'];
		$limits['uploads_scanned'] = $found['scanned'];
		$limits['uploads_cap']     = $found['cap'];
		if ( $found['capped'] ) {
			self::skip( $skipped, 'uploads_php', 'there are more files under uploads/ than this pass will look at, so it stopped early — the list below is NOT the whole folder', $found['scanned'], $found['cap'] );
		}

		$hits = array();
		foreach ( $found['files'] as $path ) {
			$hits[] = array( 'path' => $path, 'size' => (int) @filesize( $path ), 'mtime' => (int) @filemtime( $path ) );
		}

		if ( ! $hits ) {
			return self::finding(
				'morpheus_uploads_php',
				'No PHP file is sitting in the uploads folder',
				'good',
				'Nothing in ' . self::rel( $base ) . ' is a file the web server would run as code. That is what a media library should look like.'
			);
		}

		$rows = array();
		foreach ( $hits as $h ) {
			$rows[] = self::row( self::rel( $h['path'] ), $h['size'], $h['mtime'] );
		}
		return self::finding(
			'morpheus_uploads_php',
			'No PHP file is sitting in the uploads folder',
			'critical',
			count( $hits ) . ' file' . ( 1 === count( $hits ) ? '' : 's' ) . ' under ' . self::rel( $base )
				. ' can be run as PHP by the web server. Nothing legitimate puts executable code in a media library — this is one of the places a compromise is parked, because the Plugins screen never looks here.'
				. ' Morpheus renames ' . ( 1 === count( $hits ) ? 'it' : 'them' ) . ' with a timestamp so nothing is deleted and the undo is named on screen.',
			$rows
		);
	}

	// ── 2. Credential backups in the site root ──────────────────────────────

	/**
	 * The credential-copy files sitting in the site root, right now.
	 *
	 * PUBLIC for the same reason as uploads_php_files(): the fix re-enumerates
	 * when it runs. The list is literals from root_backup_names(), so no real
	 * file can match it by accident and there is no path to inject.
	 *
	 * @return array of {name, path, size, mtime, url}
	 */
	public static function root_config_backup_files() {
		$found = array();
		foreach ( self::root_backup_names() as $name ) {
			$path = ABSPATH . $name;
			if ( is_file( $path ) ) {
				$found[] = array(
					'name'  => $name,
					'path'  => $path,
					'size'  => (int) @filesize( $path ),
					'mtime' => (int) @filemtime( $path ),
					'url'   => home_url( '/' . $name ),
				);
			}
		}
		return $found;
	}

	/**
	 * DETECTION RULE: one of a short, EXACT list of names in the site root —
	 * `wp-config.php.bak|old|orig|save|txt|swp|copy|backup|~` and `.env` with the
	 * usual suffixes.
	 *
	 * WHY IT IS NOT OVER-EAGER: the list is literals, not a pattern, so no real
	 * file can match it by accident, and `wp-config.php` itself is deliberately
	 * absent. A naming pattern would have to guess; a literal list cannot.
	 *
	 * WHY IT MATTERS: wp-config.php holds the database credentials, the salts and
	 * every API key on the site. A `.bak` beside it is served as plain text by
	 * almost every web server — the backup extension is not `.php`, so nothing
	 * executes it. That is a full credential leak to anyone who guesses the name,
	 * and it is a single HTTP request away.
	 */
	private static function root_config_backups( &$skipped, &$limits ) {
		$found = self::root_config_backup_files();
		$limits['root_backups_checked'] = count( self::root_backup_names() );

		if ( ! $found ) {
			return self::finding(
				'morpheus_root_config_backup',
				'No copy of wp-config.php or .env is sitting in the site root',
				'good',
				'None of the usual backup names for wp-config.php or .env is present in the site root. If one ever appears — and they do, after a host migration or a panicked edit — this check will name it and Morpheus can move it out of the web root.'
			);
		}

		$rows = array();
		foreach ( $found as $f ) {
			$rows[] = self::row( $f['name'], $f['size'], $f['mtime'], $f['url'] );
		}
		$names = implode( ', ', array_column( $found, 'name' ) );
		return self::finding(
			'morpheus_root_config_backup',
			'No copy of wp-config.php or .env is sitting in the site root',
			'critical',
			'Found ' . $names . ' in the site root. wp-config.php holds the database password, the authentication salts and every API key on the site; .env holds whatever your deployment put there. A copy with a backup extension is served as plain text, because nothing executes a .bak — anyone who requests the name gets the contents.'
				. ' Morpheus moves ' . ( 1 === count( $found ) ? 'it' : 'them' ) . ' out of the web root with a timestamp rather than deleting, then re-requests the URL to confirm the file has stopped being served; if it is still served, the file is put back and this says so.',
			$rows
		);
	}

	// ── 3. A publicly readable debug.log ────────────────────────────────────

	/** How much of the log is read to compare with what the URL serves. */
	const DEBUG_LOG_MAX_BYTES = 2097152; // 2 MB

	/**
	 * Is wp-content/debug.log the file the web server is actually SERVING?
	 *
	 * THE RULE, AND WHY AN HTTP STATUS CANNOT ANSWER IT
	 *
	 * "Readable over the web" was once decided from the response — a 200 and a
	 * body that looked like a PHP log. That is not the same question, and it is
	 * wrong on a host whose front controller answers EVERY path under
	 * wp-content with 200 and its own HTML page (`try_files … /index.php`, a
	 * custom 404 that returns 200, a WAF interstitial). Seen live: the owner's
	 * host answered 200 with a 12 KB text/html page for a filename that
	 * certainly does not exist, and the scan reported a credential-shaped leak
	 * that was not there. A WordPress error page rendered while debugging also
	 * contains the words "PHP Warning", so even a body-shape test is fooled.
	 *
	 * The only honest test is the one Morpheus_SEO::robots_txt_state() already
	 * uses for a physical robots.txt: fetch the site's own URL and compare those
	 * bytes with the bytes on disk (morpheus_bodies_match(), the same
	 * comparison, so the two checks cannot disagree). A file that is not what
	 * the URL serves is debris, not a leak.
	 *
	 * Serves both the scan and the fix, on purpose: the owner once pressed a fix
	 * whose scan had said critical and which then answered NOT_SERVED, because
	 * the two asked the question differently. One function, one answer.
	 *
	 * @return array|null Null when the site did not answer, so nothing is decided.
	 *                    Otherwise: file, url, exists, empty, served, size, mtime.
	 */
	public static function debug_log_state() {
		// THE file WordPress is writing, not the default one — see
		// morpheus_debug_log_file(). Following the constant matters twice over: a
		// log repointed out of the web root must not be reported as a leak at a URL
		// nothing serves any more, and a log pointed at some OTHER path inside the
		// root is a leak this check used to be blind to.
		$file = morpheus_debug_log_file();
		$url  = morpheus_debug_log_url( $file );
		$base = array(
			'file'   => $file,
			'url'    => $url,
			'exists' => false,
			'empty'  => false,
			'served' => false,
			'size'   => 0,
			'mtime'  => null,
		);

		if ( ! is_file( $file ) ) {
			return $base;
		}
		$on_disk = @file_get_contents( $file, false, null, 0, self::DEBUG_LOG_MAX_BYTES );
		if ( ! is_string( $on_disk ) ) {
			return null; // There, but we cannot read it — so we cannot judge it.
		}

		$base['exists'] = true;
		$base['empty']  = ( '' === trim( $on_disk ) );
		$base['size']   = (int) @filesize( $file );
		$base['mtime']  = (int) @filemtime( $file );

		if ( null === $url ) {
			// Outside the web root: no URL can reach it, which is exactly why it was
			// moved there. Nothing to fetch, and nothing to guess about.
			return $base;
		}

		$served = self::fetch( add_query_arg( 'morpheus-verify', time(), $url ), 8 );
		if ( null === $served ) {
			// The site did not answer for its own log. Whether that URL serves
			// the file is then unknowable from in here, and guessing is how a
			// finding gets invented for a file nobody is serving.
			return null;
		}
		$base['served'] = self::served_is_the_file( $on_disk, $served );
		return $base;
	}

	/**
	 * Is the URL handing out the bytes on disk?
	 *
	 * PUBLIC and pure so the harness can exercise the rule directly rather than
	 * only through a boot: a fallback page is not the file, the file itself is,
	 * and an empty file has nothing to leak however it is served.
	 */
	public static function served_is_the_file( $on_disk, $served ) {
		if ( ! is_string( $on_disk ) || ! is_string( $served ) || '' === trim( $on_disk ) ) {
			return false;
		}
		// The file's own bytes at the start of the response: a host that pads a
		// trailing newline, or a proxy that appends a footer, is still handing
		// the log out — and morpheus_bodies_match() normalises the line endings
		// and trailing whitespace that such middleboxes rewrite.
		$head = substr( $served, 0, strlen( $on_disk ) );
		return morpheus_bodies_match( $on_disk, $head );
	}

	/**
	 * DETECTION RULE: `wp-content/debug.log` exists on disk AND the URL
	 * `wp-content/debug.log` returns THAT FILE'S OWN BYTES.
	 *
	 * WHY BOTH HALVES: the file existing is normal while someone is debugging;
	 * it is the PUBLIC READABILITY that leaks full file paths, plugin versions,
	 * database error text and sometimes credentials. Asking over HTTP is part of
	 * the honest test — a filesystem check cannot know what the web server does
	 * with the path — but the answer that matters is whether the bytes coming
	 * back are the file, not what status or shape they arrived with. See
	 * debug_log_state() for the host that fooled the old rule.
	 *
	 * WHY THE FIX IS `auto`: renaming a log file cannot break a running site —
	 * PHP holds the old file handle until the request ends, and WordPress
	 * recreates it on the next warning. The finding says so, and says the config
	 * change that stops it coming back is the real fix.
	 */
	private static function public_debug_log( &$skipped, &$limits ) {
		$file = trailingslashit( WP_CONTENT_DIR ) . 'debug.log';
		$logging = defined( 'WP_DEBUG_LOG' ) && WP_DEBUG_LOG;

		if ( ! file_exists( $file ) ) {
			return self::finding(
				'morpheus_public_debug_log',
				'The debug log is not readable over the web',
				'good',
				'There is no wp-content/debug.log on this site'
					. ( $logging ? ', even though WP_DEBUG_LOG is on' : '' )
					. ', so nothing is being leaked by one.'
			);
		}

		$state = self::debug_log_state();
		$limits['debug_log_url'] = content_url( 'debug.log' );

		if ( null === $state ) {
			self::skip( $skipped, 'public_debug_log', 'the site did not answer a request for ' . $limits['debug_log_url'] . ' (it may be offline to itself, or the request timed out), so whether the log is publicly readable could not be established' );
			return self::finding(
				'morpheus_public_debug_log',
				'The debug log is not readable over the web',
				'unknown',
				'A wp-content/debug.log exists (' . size_format( (int) @filesize( $file ) ) . '), but this scan could not get an answer from ' . $limits['debug_log_url'] . ', so it cannot say whether the file is readable over the web. That is an unanswered question, not a pass.'
			);
		}

		if ( ! empty( $state['empty'] ) ) {
			return self::finding(
				'morpheus_public_debug_log',
				'The debug log is not readable over the web',
				'good',
				'A wp-content/debug.log exists on disk but is empty, so there is nothing in it to leak over the web.'
			);
		}

		if ( empty( $state['served'] ) ) {
			// The owner's host is exactly this: a file on disk, and a URL that
			// answers with something else entirely. A finding here would send
			// Morpheus to move a file nobody is being served.
			return self::finding(
				'morpheus_public_debug_log',
				'The debug log is not readable over the web',
				'good',
				'A wp-content/debug.log exists on disk (' . size_format( $state['size'] ) . '), and it is not being served over the web: ' . $state['url'] . ' answered with something that is not this file (a host that routes every path through its front controller answers 200 with its own page). Nothing in the log is readable from outside, so there is nothing here to clean.'
			);
		}

		$size = (int) $state['size'];
		$url  = (string) $state['url'];
		return self::finding(
			'morpheus_public_debug_log',
			'The debug log is not readable over the web',
			'critical',
			$url . ' returns ' . size_format( $size ) . ' of PHP error log to anyone who asks, with no login — the bytes it answers with are this file\'s own bytes. Those lines carry full server file paths, plugin and theme versions, database error text and sometimes credentials — everything someone needs to pick a target. Morpheus renames the file with a timestamp rather than deleting it, then re-requests the URL to confirm it has stopped answering; WordPress will create a fresh log on the next warning, so switch WP_DEBUG_LOG off or move it outside the web root to stop that.',
			array( self::row( 'wp-content/debug.log', $size, (int) $state['mtime'], $url ) )
		);
	}

	// ── 4. Core checksums ───────────────────────────────────────────────────

	/**
	 * DETECTION RULE: MD5 every file in WordPress's own published checksum list
	 * for the exact version and locale this site runs, and report the ones that
	 * do not match. That list comes from wordpress.org through WordPress's own
	 * `get_core_checksums()`, so there is one definition of "unmodified core".
	 *
	 * WHY IT IS `guided` AND NEVER `auto`: "fixing" a modified core file means
	 * re-downloading WordPress over a live site. That is a deployment decision,
	 * not a repair — the modified file might be a deliberate hotfix, and the
	 * re-download might land a different version. The operator gets the exact
	 * list and the exact instruction; the pass only reports.
	 *
	 * WHY IT IS NOT OVER-EAGER: the comparison is against the site's OWN version
	 * and locale, and files that are simply absent are reported separately from
	 * files whose contents differ, because those are different stories — a host
	 * that strips readme.html is not a compromise.
	 *
	 * BOUNDED: MAX_HASH_FILES and HASH_TIME_BUDGET. Hitting either is a `skipped`
	 * entry naming how many files were reached, and the finding says so.
	 */
	private static function core_checksums( &$skipped, &$limits ) {
		if ( ! function_exists( 'get_core_checksums' ) ) {
			self::skip( $skipped, 'core_checksums', 'this WordPress has no get_core_checksums() helper, so the published core file list could not be read' );
			return null;
		}

		$version   = get_bloginfo( 'version' );
		$locale    = get_locale();
		$checksums = get_core_checksums( $version, $locale );

		if ( ! is_array( $checksums ) || ! $checksums ) {
			self::skip( $skipped, 'core_checksums', 'wordpress.org did not return a checksum list for WordPress ' . $version . ' (' . $locale . '), so core files could not be verified — this is usually an outbound-request or DNS problem, or a development version with no published checksums' );
			return self::finding(
				'morpheus_core_checksums',
				'Every WordPress core file matches the published version',
				'unknown',
				'This scan could not verify WordPress ' . $version . ': the published checksum list could not be fetched. That is an unanswered question, not a pass — a site that cannot reach wordpress.org cannot be checked this way at all.'
			);
		}

		$base     = trailingslashit( ABSPATH );
		$start    = microtime( true );
		$hashed   = 0;
		$modified = array();
		$missing  = array();
		$capped   = false;

		foreach ( $checksums as $rel => $md5 ) {
			if ( $hashed >= self::MAX_HASH_FILES || ( microtime( true ) - $start ) > self::HASH_TIME_BUDGET ) {
				$capped = true;
				break;
			}
			$path = $base . $rel;
			if ( ! is_file( $path ) ) {
				$missing[] = $rel;
				continue;
			}
			$hashed++;
			if ( md5_file( $path ) !== $md5 ) {
				$modified[] = array( 'file' => $rel, 'mtime' => (int) @filemtime( $path ), 'size' => (int) @filesize( $path ) );
			}
		}

		$limits['hash_files']     = $hashed;
		$limits['hash_files_cap'] = self::MAX_HASH_FILES;

		if ( $capped ) {
			self::skip(
				$skipped,
				'core_checksums',
				'the core checksum pass hit its cap and stopped early, so the files it did not reach were not verified',
				$hashed,
				count( $checksums )
			);
		}

		$total = count( $checksums );
		$cap_note = $capped
			? ' The pass stopped early at its cap, so this is NOT the whole of core — see what was skipped.'
			: '';

		if ( $modified ) {
			$rows = array();
			foreach ( $modified as $m ) {
				$rows[] = self::row( $m['file'], $m['size'], $m['mtime'] );
			}
			foreach ( $missing as $m ) {
				$rows[] = self::row( $m, null, null, 'not present on disk' );
			}
			return self::finding(
				'morpheus_core_checksums',
				'Every WordPress core file matches the published version',
				'critical',
				count( $modified ) . ' core file' . ( 1 === count( $modified ) ? '' : 's' ) . ' out of ' . $total
					. ' in WordPress ' . $version . ' do' . ( 1 === count( $modified ) ? 'es' : '' ) . ' not match the published checksum. A changed file in wp-admin/ or wp-includes/ is the classic way code survives a cleanup, because it is already loaded on every request and no plugin list mentions it. This is reported, never repaired from here: re-installing WordPress over a live site is your decision, and the file might be a deliberate patch.'
					. $cap_note,
				$rows
			);
		}

		if ( $missing ) {
			return self::finding(
				'morpheus_core_checksums',
				'Every WordPress core file matches the published version',
				'recommended',
				'Every core file that is present matches WordPress ' . $version . ', but ' . count( $missing )
					. ' file' . ( 1 === count( $missing ) ? '' : 's' ) . ' in the published list ' . ( 1 === count( $missing ) ? 'is' : 'are' ) . ' not on disk. That is often a host or a hardening plugin removing something deliberately (readme.html is the usual one) — but a missing file that you did not remove is worth a look.'
					. $cap_note,
				array_map( function ( $m ) { return self::row( $m, null, null, 'not present on disk' ); }, $missing )
			);
		}

		return self::finding(
			'morpheus_core_checksums',
			'Every WordPress core file matches the published version',
			'good',
			'All ' . $hashed . ' core files in the published list for WordPress ' . $version . ' (' . $locale . ') match their checksums.' . $cap_note
		);
	}

	// ── 5. Plugin checksums ─────────────────────────────────────────────────

	/**
	 * DETECTION RULE: for an active plugin that wordpress.org hosts, download the
	 * PUBLISHED package for the installed version and compare the MD5 of every
	 * file inside it with the file on disk. Report files that differ, and — the
	 * part a checksum list alone would miss — files on disk that the package does
	 * not contain at all, which is where an added loader lives.
	 *
	 * WHY THE API CANNOT SIMPLY ANSWER: wordpress.org publishes a checksum list
	 * for CORE only. There is no plugin checksums endpoint (checked against the
	 * live API: `plugin_information` returns no `checksums` field, and there is no
	 * `.md5` beside the package). So the package itself is the only authority,
	 * which is why this check is BOUNDED — packages run from a few KB to tens of
	 * MB, and downloading one per plugin on every scan would be rude to the site
	 * and to wordpress.org.
	 *
	 * WHAT IT SKIPS, AND SAYS SO: a plugin not hosted on wordpress.org, one whose
	 * installed version differs from the published one (a comparison would flag
	 * every file), a package larger than the per-package allowance, a scan that
	 * has already spent its byte or time budget, and any host without the zip
	 * extension. Each is a `skipped` entry with the reason.
	 */
	private static function plugin_checksums( &$skipped, &$limits ) {
		if ( ! class_exists( 'ZipArchive' ) ) {
			self::skip( $skipped, 'plugin_checksums', 'this host\'s PHP has no zip extension, so a published plugin package cannot be opened to compare against' );
			return null;
		}

		$active  = (array) get_option( 'active_plugins', array() );
		$all     = function_exists( 'get_plugins' ) ? get_plugins() : array();
		$limits['package_plugins_cap'] = self::PACKAGE_PLUGINS_CAP;
		$limits['package_bytes_cap']   = self::PACKAGE_BYTES_CAP;
		$limits['package_plugins']     = 0;
		$limits['package_bytes']       = 0;

		$modified = array();
		$extra    = array();
		$compared = 0;
		$start    = microtime( true );
		$enumerated = 0;

		foreach ( $active as $file ) {
			$slug = self::plugin_slug( $file );
			// Morpheus is not hosted on wordpress.org, so there is no published
			// package to compare against. It is active on every site that can run
			// this scan, so it must not turn the check into a permanent unknown.
			if ( 'morpheus' === $slug ) {
				self::skip( $skipped, 'plugin_checksums', 'Morpheus itself is not hosted on wordpress.org, so there is no published package to compare its own files against' );
				continue;
			}
			if ( '' === $slug ) {
				self::skip( $skipped, 'plugin_checksums', 'the single-file plugin ' . $file . ' has no directory on wordpress.org to compare against' );
				continue;
			}
			$enumerated++;
			if ( $compared >= self::PACKAGE_PLUGINS_CAP ) {
				self::skip( $skipped, 'plugin_checksums', 'this pass verifies at most ' . self::PACKAGE_PLUGINS_CAP . ' plugin packages, so ' . $slug . ' and any after it were not compared', $compared, $enumerated );
				break;
			}
			if ( ( microtime( true ) - $start ) > self::PACKAGE_TIME_BUDGET ) {
				self::skip( $skipped, 'plugin_checksums', 'the plugin package comparison ran out of its time budget before reaching ' . $slug, $compared, $enumerated );
				break;
			}

			$installed_version = isset( $all[ $file ]['Version'] ) ? (string) $all[ $file ]['Version'] : '';
			$info = self::plugin_info( $slug );
			if ( null === $info ) {
				self::skip( $skipped, 'plugin_checksums', 'wordpress.org could not be asked about ' . $slug . ' (no answer, or no such plugin), so its files were not verified' );
				continue;
			}
			if ( '' === $installed_version || $info['version'] !== $installed_version ) {
				self::skip( $skipped, 'plugin_checksums', $slug . ' runs version ' . ( '' === $installed_version ? 'unknown' : $installed_version ) . ' but wordpress.org publishes ' . $info['version'] . ' — comparing them would flag every file, so this pass did not' );
				continue;
			}
			if ( '' === $info['package'] ) {
				self::skip( $skipped, 'plugin_checksums', 'wordpress.org publishes no package URL for ' . $slug . ', so there is nothing to compare against' );
				continue;
			}

			$head = self::head_length( $info['package'] );
			if ( null !== $head && $head > self::PACKAGE_BYTES_CAP ) {
				self::skip( $skipped, 'plugin_checksums', $slug . '\'s package is ' . size_format( $head ) . ', above the ' . size_format( self::PACKAGE_BYTES_CAP ) . ' this pass will download' );
				continue;
			}

			$body = self::fetch( $info['package'], 20, self::PACKAGE_BYTES_CAP );
			if ( ! is_string( $body ) || '' === $body ) {
				self::skip( $skipped, 'plugin_checksums', 'the published package for ' . $slug . ' ' . $installed_version . ' could not be downloaded, so its files were not verified' );
				continue;
			}
			$limits['package_bytes'] += strlen( $body );

			$cmp = self::compare_package( $body, WP_PLUGIN_DIR . '/' . $slug );
			if ( is_wp_error( $cmp ) ) {
				self::skip( $skipped, 'plugin_checksums', $slug . ': ' . $cmp->get_error_message() );
				continue;
			}
			$compared++;
			$limits['package_plugins'] = $compared;
			foreach ( $cmp['modified'] as $m ) {
				$modified[] = array( 'plugin' => $slug, 'file' => $m );
			}
			foreach ( $cmp['extra'] as $e ) {
				$extra[] = array( 'plugin' => $slug, 'file' => $e );
			}
			if ( $cmp['files'] < 1 ) {
				self::skip( $skipped, 'plugin_checksums', $slug . ': the published package contained no comparable files, so nothing was actually verified' );
			} else {
				$limits['package_files_' . $slug] = $cmp['files'];
			}
		}

		if ( ! $compared ) {
			// Nothing was compared. Whether that is "clean" or "unknown" depends on
			// whether we even tried: with no wordpress.org-hosted active plugin,
			// there is genuinely nothing to check.
			if ( 0 === $enumerated ) {
				return self::finding(
					'morpheus_plugin_checksums',
					'Every plugin file matches the version wordpress.org publishes',
					'good',
					'No active plugin is installed in its own directory, so there is nothing wordpress.org could be asked about.'
				);
			}
			// Files were named but none were verified — an unanswered question, and
			// saying "good" here is exactly the false reassurance to avoid.
			self::skip( $skipped, 'plugin_checksums', 'not one active plugin package could be compared, so no plugin file on this site has been verified' );
			return self::finding(
				'morpheus_plugin_checksums',
				'Every plugin file matches the version wordpress.org publishes',
				'unknown',
				'No plugin file could be verified against its published package — see what was skipped for the reason for each one. That is an unanswered question, not a pass.'
			);
		}

		$rows = array();
		foreach ( $modified as $m ) {
			$rows[] = self::row( 'wp-content/plugins/' . $m['plugin'] . '/' . $m['file'], null, null, 'does not match the published package' );
		}
		foreach ( $extra as $e ) {
			$rows[] = self::row( 'wp-content/plugins/' . $e['plugin'] . '/' . $e['file'], null, null, 'not in the published package' );
		}

		if ( $rows ) {
			return self::finding(
				'morpheus_plugin_checksums',
				'Every plugin file matches the version wordpress.org publishes',
				'critical',
				count( $modified ) . ' plugin file' . ( 1 === count( $modified ) ? '' : 's' ) . ' do' . ( 1 === count( $modified ) ? 'es' : '' )
					. ' not match the package wordpress.org publishes for the installed version, and ' . count( $extra )
					. ' file' . ( 1 === count( $extra ) ? '' : 's' ) . ' on disk ' . ( 1 === count( $extra ) ? 'is' : 'are' ) . ' not in that package at all. A code file added to a plugin cannot be seen from the Plugins screen and is loaded with the plugin. Reported, never repaired here: re-installing a plugin over a live site is your decision.',
				$rows
			);
		}

		return self::finding(
			'morpheus_plugin_checksums',
			'Every plugin file matches the version wordpress.org publishes',
			'good',
			$compared . ' plugin package' . ( 1 === $compared ? '' : 's' ) . ' downloaded and compared file by file; every file matches.'
		);
	}

	/** A plugin file's slug = its top directory. '' for a single-file plugin. */
	private static function plugin_slug( $file ) {
		$parts = explode( '/', (string) $file );
		return count( $parts ) > 1 ? sanitize_key( $parts[0] ) : '';
	}

	/** wordpress.org's own plugin information, cached for half a day. */
	private static function plugin_info( $slug ) {
		$key    = 'morpheus_clean_plugin_' . md5( $slug );
		$cached = get_transient( $key );
		if ( is_array( $cached ) ) {
			return $cached;
		}
		$url = 'https://api.wordpress.org/plugins/info/1.2/?action=plugin_information&request[slug]=' . rawurlencode( $slug );
		$res = wp_remote_get( $url, array( 'timeout' => 10 ) );
		if ( is_wp_error( $res ) || 200 !== (int) wp_remote_retrieve_response_code( $res ) ) {
			return null;
		}
		$data = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( ! is_array( $data ) || ! empty( $data['error'] ) || empty( $data['version'] ) ) {
			return null;
		}
		$info = array(
			'version' => (string) $data['version'],
			'package' => isset( $data['download_link'] ) ? (string) $data['download_link'] : '',
		);
		set_transient( $key, $info, self::PLUGIN_INFO_TTL );
		return $info;
	}

	/** Content-Length for a URL, or null when the answer does not say. */
	private static function head_length( $url ) {
		$res = wp_remote_head( $url, array( 'timeout' => 10, 'redirection' => 3 ) );
		if ( is_wp_error( $res ) ) {
			return null;
		}
		$len = wp_remote_retrieve_header( $res, 'content-length' );
		return is_numeric( $len ) ? (int) $len : null;
	}

	/**
	 * Open a package in memory and compare it with an installed plugin directory.
	 *
	 * The comparison is deliberately two-sided: files whose bytes differ AND
	 * files present on disk that the package does not contain. A checksum list
	 * alone would only catch the first, and an added loader is the second.
	 */
	private static function compare_package( $body, $dir ) {
		if ( ! is_dir( $dir ) ) {
			return new WP_Error( 'morpheus_clean_no_plugin_dir', 'the installed plugin directory ' . $dir . ' does not exist' );
		}
		$tmp = trailingslashit( get_temp_dir() ) . 'morpheus-clean-' . wp_generate_password( 8, false, false ) . '.zip';
		if ( false === @file_put_contents( $tmp, $body ) ) {
			return new WP_Error( 'morpheus_clean_tmp', 'the downloaded package could not be written to a temporary file' );
		}
		$zip = new ZipArchive();
		if ( true !== $zip->open( $tmp ) ) {
			@unlink( $tmp );
			return new WP_Error( 'morpheus_clean_unzip', 'the downloaded package is not a readable zip archive' );
		}

		$in_package = array();
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$name = $zip->getNameIndex( $i );
			if ( false === $name ) {
				continue;
			}
			$name = self::slash( $name );
			if ( '/' === substr( $name, -1 ) ) {
				continue; // a directory entry
			}
			// Packages are rooted at the plugin slug; drop that one segment.
			$rel = preg_replace( '#^[^/]+/#', '', $name );
			if ( '' === $rel || null === $rel || 0 === strpos( $rel, '..' ) ) {
				continue;
			}
			$in_package[ $rel ] = true;
			$disk = trailingslashit( $dir ) . $rel;
			if ( ! is_file( $disk ) ) {
				continue;
			}
			$body_zip = $zip->getFromIndex( $i );
			if ( false === $body_zip ) {
				continue;
			}
			$in_package[ $rel ] = ( md5( $body_zip ) === md5_file( $disk ) ) ? 'same' : 'different';
		}
		$zip->close();
		@unlink( $tmp );

		// What is on disk that the package never contained. Our own plugin's
		// state files, editor backups and .git are the legitimate shapes, so
		// they are excluded by name rather than reported.
		$extra = array();
		try {
			$it = new RecursiveIteratorIterator(
				new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
				RecursiveIteratorIterator::SELF_FIRST
			);
			foreach ( $it as $info ) {
				if ( $info->isDir() ) {
					continue;
				}
				$rel = ltrim( substr( self::slash( $info->getPathname() ), strlen( trailingslashit( self::slash( $dir ) ) ) ), '/' );
				if ( isset( $in_package[ $rel ] ) ) {
					continue;
				}
				if ( preg_match( '#(^|/)(\.git|\.svn|node_modules|\.DS_Store)(/|$)#i', $rel ) ) {
					continue;
				}
				$extra[] = $rel;
			}
		} catch ( Exception $e ) {
			return new WP_Error( 'morpheus_clean_walk', 'the installed plugin directory could not be listed (' . $e->getMessage() . ')' );
		}
		sort( $extra );

		$modified = array();
		$files    = 0;
		foreach ( $in_package as $rel => $state ) {
			if ( 'same' === $state || 'different' === $state ) {
				$files++;
			}
			if ( 'different' === $state ) {
				$modified[] = $rel;
			}
		}
		sort( $modified );

		return array( 'files' => $files, 'modified' => $modified, 'extra' => $extra );
	}

	// ── 6. mu-plugins ───────────────────────────────────────────────────────

	/**
	 * DETECTION RULE: every file under the must-use plugins directory, with its
	 * size and modification time.
	 *
	 * WHY IT MATTERS: mu-plugins are loaded on every request with no activation
	 * and no entry in the Plugins screen. Nothing in wp-admin lists them. They are
	 * a legitimate mechanism — hosts and agencies use them — which is exactly why
	 * this reports the inventory rather than an accusation: the operator is the
	 * only one who can say whether the file is theirs.
	 *
	 * WHY THE STATUS IS USUALLY `good`: a site with a host-supplied mu-plugin is
	 * not faulty, and a check that shouts on every well-run site gets ignored.
	 * `recommended` is reserved for a file modified inside RECENT_DAYS — the shape
	 * of something newly planted — and the inventory is in the payload either way.
	 */
	private static function mu_plugins( &$skipped, &$limits ) {
		$dir = defined( 'WPMU_PLUGIN_DIR' ) ? WPMU_PLUGIN_DIR : WP_CONTENT_DIR . '/mu-plugins';
		if ( ! is_dir( $dir ) ) {
			return self::finding(
				'morpheus_mu_plugins',
				'Nothing is loaded from mu-plugins that you did not put there',
				'good',
				'There is no mu-plugins directory on this site, so no file is being auto-loaded behind the Plugins screen.'
			);
		}

		$skips_before = count( $skipped );
		$files = self::walk( $dir, 2000, 4.0, $skipped, 'mu_plugins' );
		$limits['mu_plugin_files'] = count( $files );

		if ( ! $files ) {
			return self::finding(
				'morpheus_mu_plugins',
				'Nothing is loaded from mu-plugins that you did not put there',
				'good',
				'The mu-plugins directory exists and is empty, so nothing is being auto-loaded.'
			);
		}

		$cutoff  = time() - ( self::RECENT_DAYS * DAY_IN_SECONDS );
		$recent  = array();
		$rows    = array();
		foreach ( $files as $f ) {
			$is_php = (bool) preg_match( '/\.php$/i', $f['path'] );
			$rows[] = self::row(
				self::rel( $f['path'] ),
				$f['size'],
				$f['mtime'],
				$is_php ? 'loaded automatically' : 'not loaded automatically'
			);
			if ( $is_php && $f['mtime'] >= $cutoff ) {
				$recent[] = $f;
			}
		}
		usort( $rows, function ( $a, $b ) { return ( $b['mtime'] ?? 0 ) <=> ( $a['mtime'] ?? 0 ); } );

		$status = $recent ? 'recommended' : 'good';
		$desc = $recent
			? count( $recent ) . ' file' . ( 1 === count( $recent ) ? '' : 's' ) . ' in ' . self::rel( $dir )
				. ' changed in the last ' . self::RECENT_DAYS . ' days, and every .php file here is loaded on every request with no activation and no entry in the Plugins screen. A host or an agency putting a mu-plugin there is normal; something appearing there that you did not expect is one of the easiest places to leave code. Confirm each file is yours.'
			: count( $files ) . ' file' . ( 1 === count( $files ) ? '' : 's' ) . ' in ' . self::rel( $dir )
				. ' are auto-loaded on every request, invisible in the Plugins screen. None has changed in the last ' . self::RECENT_DAYS . ' days. Listed here so you can confirm each one is yours — Morpheus will not touch them.';
		if ( count( $skipped ) > $skips_before ) {
			$desc .= ' This list may be incomplete — see what was skipped.';
		}

		return self::finding(
			'morpheus_mu_plugins',
			'Nothing is loaded from mu-plugins that you did not put there',
			$status,
			$desc,
			$rows
		);
	}

	// ── 7. Admin users and who can edit files ───────────────────────────────

	/**
	 * DETECTION RULE: every account that can reach the admin area
	 * (`manage_options`), with its role, registration date and whether it holds
	 * the file/plugin-install capabilities.
	 *
	 * WHY IT IS NOT OVER-EAGER: a site owner having an administrator account is
	 * not a fault, so the inventory is reported and the status stays `good`
	 * unless one of two things is true — an account was created inside
	 * RECENT_DAYS, or an account holds admin capabilities through a role that is
	 * not WordPress's own `administrator`. Those two are the shapes a planted
	 * account leaves, and neither is a guess about intent: they are facts about
	 * the account.
	 *
	 * WHY IT IS `guided`: removing a user is the owner's decision. Morpheus never
	 * deletes an account, and this pass never offers to.
	 */
	private static function admin_users( &$skipped, &$limits ) {
		if ( ! function_exists( 'get_users' ) ) {
			self::skip( $skipped, 'admin_users', 'this WordPress could not list its users, so the admin inventory is missing' );
			return null;
		}
		$users = get_users( array( 'number' => 1000 ) );
		$limits['users_scanned'] = is_array( $users ) ? count( $users ) : 0;

		$admins = array();
		foreach ( (array) $users as $u ) {
			if ( ! ( $u instanceof WP_User ) ) {
				continue;
			}
			if ( ! $u->has_cap( 'manage_options' ) ) {
				continue;
			}
			$admins[] = $u;
		}

		if ( count( $admins ) > self::MAX_ADMINS ) {
			self::skip( $skipped, 'admin_users', 'this site has more admin-capable accounts than this pass lists', self::MAX_ADMINS, count( $admins ) );
			$admins = array_slice( $admins, 0, self::MAX_ADMINS );
		}

		$cutoff = time() - ( self::RECENT_DAYS * DAY_IN_SECONDS );
		$file_mods_off = defined( 'DISALLOW_FILE_MODS' ) && DISALLOW_FILE_MODS;
		$file_edit_off = defined( 'DISALLOW_FILE_EDIT' ) && DISALLOW_FILE_EDIT;

		$recent = array();
		$odd_role = array();
		$rows = array();
		foreach ( $admins as $u ) {
			$registered = strtotime( (string) $u->user_registered . ' UTC' );
			$roles      = (array) $u->roles;
			$note = array();
			$note[] = 'roles: ' . ( $roles ? implode( ', ', $roles ) : 'none' );
			if ( ! $file_mods_off && $u->has_cap( 'install_plugins' ) ) {
				$note[] = 'can install plugins';
			}
			if ( ! $file_edit_off && ( $u->has_cap( 'edit_files' ) || $u->has_cap( 'edit_plugins' ) || $u->has_cap( 'edit_themes' ) ) ) {
				$note[] = 'can edit theme/plugin files';
			}
			if ( $registered && $registered >= $cutoff ) {
				$note[] = 'registered in the last ' . self::RECENT_DAYS . ' days';
				$recent[] = $u->user_login;
			}
			if ( $roles && ! in_array( 'administrator', $roles, true ) ) {
				$note[] = 'admin capabilities through a non-standard role';
				$odd_role[] = $u->user_login;
			}
			$rows[] = self::row(
				$u->user_login . ' <' . $u->user_email . '>',
				null,
				$registered ?: null,
				implode( '; ', $note )
			);
		}

		$status = ( $recent || $odd_role ) ? 'recommended' : 'good';
		$desc = count( $admins ) . ' account' . ( 1 === count( $admins ) ? '' : 's' ) . ' can reach the admin area on this site'
			. ( $file_mods_off ? ' (DISALLOW_FILE_MODS is set, so none of them can install or edit files from wp-admin)' : '' ) . '.';
		if ( $recent ) {
			$desc .= ' ' . count( $recent ) . ' of them (' . implode( ', ', $recent ) . ') registered within the last ' . self::RECENT_DAYS . ' days — a new administrator account is a standard way to keep access after a cleanup, so confirm you created it.';
		}
		if ( $odd_role ) {
			$desc .= ' ' . implode( ', ', $odd_role ) . ' holds admin capabilities through a role that is not WordPress\'s own administrator — unusual, and worth understanding.';
		}
		$desc .= ' Morpheus never removes an account; this is a list to check.';

		return self::finding(
			'morpheus_admin_users',
			'Every account that can reach wp-admin is one you recognise',
			$status,
			$desc,
			$rows
		);
	}

	// ── 8. Cron events we cannot attribute ──────────────────────────────────

	/**
	 * DETECTION RULE: a scheduled hook in WordPress's cron array that is neither
	 * one of core's own hooks, nor currently registered by anything loaded
	 * (has_action), nor named after an installed plugin's directory or text
	 * domain.
	 *
	 * WHY THE TWO ATTRIBUTION TESTS: `has_action()` alone is not enough — plenty
	 * of plugins register their cron callbacks only on admin requests, so a
	 * signed REST scan would call them unattributed. Matching the hook against
	 * the installed plugins' slugs and text domains is cheap and catches the
	 * ordinary naming convention (`woocommerce_cleanup_sessions`). What is left
	 * is worth a person's attention.
	 *
	 * WHY `guided` AND NEVER AUTO: unscheduling a hook on a live site can stop a
	 * shop's stock sync or a backup. The operator gets the hook name, when it
	 * next runs, and what it is; deciding is theirs.
	 */
	private static function cron_events( &$skipped, &$limits ) {
		if ( ! function_exists( '_get_cron_array' ) ) {
			self::skip( $skipped, 'cron_events', 'this WordPress could not report its scheduled events' );
			return null;
		}
		$cron = _get_cron_array();
		if ( ! is_array( $cron ) ) {
			$cron = array();
		}

		$core = array(
			'wp_version_check', 'wp_update_plugins', 'wp_update_themes', 'wp_scheduled_delete',
			'wp_scheduled_auto_draft_delete', 'delete_expired_transients', 'wp_privacy_delete_old_export_files',
			'recovery_mode_clean_expired_keys', 'wp_site_health_scheduled_check', 'wp_https_detection',
			'wp_update_user_counts', 'wp_maybe_auto_update', 'wp_after_insert_post',
			'wp_delete_temp_updater_backups', 'wp_update_comment_type_batch',
		);

		$tokens = self::plugin_tokens();
		$hooks  = array();
		foreach ( $cron as $timestamp => $by_hook ) {
			foreach ( (array) $by_hook as $hook => $events ) {
				$hooks[ $hook ] = isset( $hooks[ $hook ] ) ? min( $hooks[ $hook ], $timestamp ) : $timestamp;
			}
		}
		$limits['cron_hooks'] = count( $hooks );

		$unattributed = array();
		foreach ( $hooks as $hook => $next ) {
			if ( in_array( $hook, $core, true ) ) {
				continue;
			}
			if ( has_action( $hook ) ) {
				continue;
			}
			$attributed = false;
			foreach ( $tokens as $token ) {
				if ( '' !== $token && false !== strpos( $hook, $token ) ) {
					$attributed = true;
					break;
				}
			}
			if ( $attributed ) {
				continue;
			}
			$unattributed[] = array( 'hook' => $hook, 'next' => (int) $next );
		}

		if ( ! $unattributed ) {
			return self::finding(
				'morpheus_cron_unattributed',
				'Every scheduled task belongs to something installed on this site',
				'good',
				count( $hooks ) . ' scheduled hooks were checked; each is either WordPress\'s own or belongs to a plugin this site runs.'
			);
		}

		usort( $unattributed, function ( $a, $b ) { return $a['next'] <=> $b['next']; } );
		$rows = array();
		foreach ( $unattributed as $u ) {
			$rows[] = self::row( $u['hook'], null, null, 'next run ' . gmdate( 'c', $u['next'] ) );
		}
		return self::finding(
			'morpheus_cron_unattributed',
			'Every scheduled task belongs to something installed on this site',
			'recommended',
			count( $unattributed ) . ' scheduled hook' . ( 1 === count( $unattributed ) ? '' : 's' )
				. ' could not be attributed to WordPress or to any plugin this site runs. Somewhere there is a callback that re-registers them, or something scheduled work here and is no longer active. A leftover hook is usually harmless and occasionally a timer an attacker left behind. Morpheus will not unschedule anything — removing one can stop a shop\'s stock sync or a backup — so this is a list to check with whoever maintains the site.',
			$rows
		);
	}

	/**
	 * Tokens a cron hook would plausibly contain if it belonged to an installed
	 * plugin: directory slugs plus "text domains" taken from the plugin headers.
	 */
	private static function plugin_tokens() {
		$tokens = array();
		foreach ( (array) get_option( 'active_plugins', array() ) as $file ) {
			$slug = self::plugin_slug( $file );
			if ( '' !== $slug ) {
				$tokens[] = $slug;
				$tokens[] = str_replace( '-', '_', $slug );
			}
		}
		if ( function_exists( 'get_plugins' ) ) {
			foreach ( (array) get_plugins() as $file => $data ) {
				if ( ! empty( $data['TextDomain'] ) ) {
					$tokens[] = str_replace( '-', '_', sanitize_key( $data['TextDomain'] ) );
				}
			}
		}
		return array_values( array_unique( array_filter( $tokens ) ) );
	}

	// ── 9. Files modified recently ──────────────────────────────────────────

	/**
	 * DETECTION RULE: files under wp-admin/, wp-includes/, the top level of the
	 * site, the plugins directory and the ACTIVE theme whose modification time is
	 * inside RECENT_DAYS, newest first.
	 *
	 * WHY IT IS USEFUL: an update and an intrusion look identical in a file
	 * listing — both change code — but the ORDER is what tells the story, and
	 * nothing in wp-admin shows it. This is the check that answers "what changed
	 * on my site this week".
	 *
	 * WHY IT IS NOT OVER-EAGER: it is `guided` and it never says a changed file is
	 * bad; the heading says a plugin, theme or core update produces exactly this
	 * pattern, and the rows carry the timestamps so the operator can line them up
	 * against what they installed. Morpheus's own plugin directory is excluded —
	 * it changed when this plugin was installed, and reporting ourselves on every
	 * scan is noise.
	 *
	 * BOUNDED: by a per-root cap and RECENT_TIME_BUDGET, and truncation at
	 * MAX_RECENT_FILES is stated rather than silent.
	 */
	private static function recent_files( &$skipped, &$limits ) {
		$cutoff = time() - ( self::RECENT_DAYS * DAY_IN_SECONDS );
		$start  = microtime( true );
		$roots  = array(
			'core'    => array( ABSPATH . 'wp-admin', ABSPATH . 'wp-includes' ),
			'plugins' => array( defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins' ),
			'theme'   => array( get_theme_root() ),
		);
		// trailingslashit on BOTH sides: without the trailing slash this prefix also
		// matched any plugin whose directory merely STARTS with "morpheus"
		// (morpheus-extra, morpheus-fixture-…), silently excluding real plugins
		// from the check. The harness's own fixture plugin is what caught it.
		$ours = trailingslashit( trailingslashit( self::slash( defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins' ) ) . 'morpheus' );

		$hits    = array();
		$scanned = 0;
		foreach ( $roots as $kind => $dirs ) {
			foreach ( $dirs as $dir ) {
				foreach ( self::walk( $dir, self::MAX_UPLOADS_FILES, self::RECENT_TIME_BUDGET, $skipped, 'recent_files' ) as $f ) {
					$scanned++;
					if ( ( microtime( true ) - $start ) > self::RECENT_TIME_BUDGET ) {
						self::skip( $skipped, 'recent_files', 'the recent-files walk ran out of its time budget part-way through ' . $kind, $scanned, null );
						break 3;
					}
					if ( 0 === strpos( self::slash( $f['path'] ), $ours ) ) {
						continue;
					}
					if ( $f['mtime'] >= $cutoff ) {
						$f['kind'] = $kind;
						$hits[] = $f;
					}
				}
			}
		}

		$limits['recent_scanned'] = $scanned;
		$limits['recent_days']    = self::RECENT_DAYS;

		if ( ! $hits ) {
			return self::finding(
				'morpheus_recent_files',
				'Nothing has changed on this site in the last ' . self::RECENT_DAYS . ' days',
				'good',
				'Fine if the site has been left alone; worth knowing if you expected an update to have landed. ' . $scanned . ' files were checked.'
			);
		}

		usort( $hits, function ( $a, $b ) { return $b['mtime'] <=> $a['mtime']; } );
		$total    = count( $hits );
		$shown    = array_slice( $hits, 0, self::MAX_RECENT_FILES );
		$truncated = $total > count( $shown );
		if ( $truncated ) {
			self::skip( $skipped, 'recent_files', 'more files changed recently than this pass lists, so the newest ' . self::MAX_RECENT_FILES . ' are shown', count( $shown ), $total );
		}

		$rows = array();
		foreach ( $shown as $h ) {
			$rows[] = self::row( self::rel( $h['path'] ), $h['size'], $h['mtime'], $h['kind'] );
		}
		return self::finding(
			'morpheus_recent_files',
			'Nothing has changed on this site in the last ' . self::RECENT_DAYS . ' days',
			'recommended',
			$total . ' file' . ( 1 === $total ? '' : 's' ) . ' under core, your plugins or your active theme ' . ( 1 === $total ? 'has' : 'have' ) . ' changed in the last ' . self::RECENT_DAYS . ' days'
				. ( $truncated ? ' (the newest ' . count( $shown ) . ' are listed)' : '' )
				. '. A plugin, theme or WordPress update produces exactly this pattern, so line the timestamps below up against what you installed before assuming anything — the newest entry is the one to explain first. This is a list, not a verdict, and Morpheus will not touch a file on the strength of its date.',
			$rows
		);
	}

	// ── Small helpers ───────────────────────────────────────────────────────

	/** Forward slashes, without depending on a core helper being loaded. */
	private static function slash( $path ) {
		return function_exists( 'wp_normalize_path' ) ? wp_normalize_path( (string) $path ) : str_replace( '\\', '/', (string) $path );
	}

	// ── HTTP ────────────────────────────────────────────────────────────────

	/**
	 * GET a URL and return the body, or null on any failure.
	 *
	 * Null is "could not ask", never "no". A check that could not reach the site
	 * says so (`unknown` / `skipped`) rather than reporting a clean result, which
	 * is the whole reason this returns null instead of ''.
	 */
	private static function fetch( $url, $timeout = 10, $max_bytes = 0 ) {
		$args = array( 'timeout' => $timeout, 'redirection' => 3 );
		$res  = wp_remote_get( $url, $args );
		if ( is_wp_error( $res ) ) {
			return null;
		}
		$code = (int) wp_remote_retrieve_response_code( $res );
		if ( $code < 200 || $code >= 400 ) {
			// A 403/404 is a real answer for "is this readable": the body is not
			// the file's contents. Return it so the caller's shape test decides.
			return wp_remote_retrieve_body( $res );
		}
		$body = wp_remote_retrieve_body( $res );
		if ( $max_bytes > 0 && strlen( $body ) > $max_bytes ) {
			return null;
		}
		return $body;
	}
}

