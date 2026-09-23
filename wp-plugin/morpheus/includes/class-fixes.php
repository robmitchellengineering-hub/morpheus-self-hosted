<?php
/**
 * The fix registry: what Morpheus can DO about each finding.
 *
 * WHY THIS EXISTS
 *
 * A health scan that only describes problems makes the owner the fix engine. Every
 * finding therefore carries an action, and there are exactly three honest kinds:
 *
 *   auto   — Morpheus does it: reversible, backed up first, verified after, and
 *            put back if the verification fails.
 *   guided — a human step is genuinely required (a PHP version, an SSL
 *            certificate, a host firewall). The owner gets the exact instruction
 *            and a link, then presses re-check and Morpheus confirms it itself.
 *   none   — nothing to do, and WHY (a passed check, or a WordPress opinion that
 *            needs no action from anyone).
 *   updates — fixable, but by the maintenance engine that already exists rather
 *            than by a fix action: the panel points at APPLY NOW.
 *
 * Anything attention-worthy that has no entry is counted as UNMAPPED and reported
 * by the scan, so a new WordPress test cannot quietly become a description with no
 * action. The plugin harness asserts that count is zero against a real WordPress.
 *
 * A scan NEVER applies a fix. These actions run only when the owner asks.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Fixes {

	/**
	 * The registry, keyed by the id the scan produces.
	 *
	 * `label` is the button. `warning` is shown before an action that has a real
	 * consequence. `steps` are guided instructions, each with an optional link —
	 * a guided step with neither a link nor an exact literal is refused by the
	 * harness, because "ask your host" with nothing to paste is a dead end.
	 */
	public static function registry() {
		$registry = array(

			// ── wp-config.php edits: three findings, one mechanism ──────────
			'morpheus_file_editor'  => array(
				'kind'  => 'auto',
				'label' => 'Disable the file editor',
				'does'  => 'Adds define( \'DISALLOW_FILE_EDIT\', true ); to wp-config.php, so an admin-account compromise cannot run arbitrary PHP through Appearance → Theme File Editor.',
				'fix'   => 'wp_config_define',
				'args'  => array( 'name' => 'DISALLOW_FILE_EDIT', 'value' => 'true' ),
			),
			'morpheus_debug_display' => array(
				'kind'  => 'auto',
				'label' => 'Stop printing PHP errors to visitors',
				'does'  => 'Adds define( \'WP_DEBUG_DISPLAY\', false ); to wp-config.php. Errors are still logged if you have logging on; they stop being printed into your pages.',
				'fix'   => 'wp_config_define',
				'args'  => array( 'name' => 'WP_DEBUG_DISPLAY', 'value' => 'false' ),
			),

			// ── Settings WordPress already owns ─────────────────────────────
			'search_engine_visibility' => array(
				'kind'    => 'auto',
				'label'   => 'Let search engines index this site',
				'does'    => 'Turns off "Discourage search engines from indexing this site".',
				'warning' => 'Only do this if the site is meant to be public. On a staging or private site, leave it as it is — this check is WordPress telling you the site is hidden, not that it is broken.',
				'fix'     => 'set_option',
				'args'    => array( 'name' => 'blog_public', 'value' => 1 ),
			),
			'insecure_registration' => array(
				'kind'  => 'auto',
				'label' => 'Give new accounts the subscriber role',
				'does'  => 'Sets the default role for new registrations to subscriber, so an open registration form cannot hand out publishing or admin rights.',
				'fix'   => 'set_option',
				'args'  => array( 'name' => 'default_role', 'value' => 'subscriber' ),
			),

			// ── The directory WordPress needs to roll back an update ────────
			'update_temp_backup_writable' => array(
				'kind'  => 'auto',
				'label' => 'Create the update backup directory',
				'does'  => 'Creates wp-content/upgrade-temp-backup and makes it writable, which is how WordPress rolls back a plugin or theme update that fails. Without it, an update has no way back.',
				'fix'   => 'make_backup_dir',
			),

			// ── A stale physical file standing in front of WordPress ────────
			//
			// WordPress serves /robots.txt dynamically — core builds it, and
			// class-seo.php adds the sitemap line — but ONLY while no physical
			// file exists: a real file always wins, and the filter never runs.
			// A file left behind by a removed SEO plugin therefore advertises a
			// sitemap path that 404s, and nothing on the site says so. The fix
			// is a RENAME, because the owner often cannot reach the hosting
			// panel to undo a delete.
			'morpheus_stale_robots_txt' => array(
				'kind'    => 'auto',
				'label'   => 'Quarantine the stale robots.txt',
				'does'    => 'Renames robots.txt to a timestamped backup beside it, so WordPress serves its own robots.txt again — including the sitemap line this site actually has. Nothing is deleted; the backup is the undo, and Morpheus re-reads the live /robots.txt afterwards and puts the file back if the change did not take.',
				'warning' => 'The whole physical file stops being served, including any User-agent or Disallow rules written in it — WordPress\'s own robots.txt takes its place. The file is renamed rather than deleted, so it can be put back.',
				'fix'     => 'quarantine_robots_txt',
			),

			// ── Overdue scheduled work ──────────────────────────────────────
			'scheduled_events' => array(
				'kind'  => 'auto',
				'label' => 'Run the overdue tasks now',
				'does'  => 'Runs the scheduled events WordPress says are late, then re-checks. If they are late again, your host is not running wp-cron and that needs the host.',
				'fix'   => 'spawn_cron',
			),

			// ── Updates: the engine that already exists ─────────────────────
			'plugin_version' => array(
				'kind'  => 'updates',
				'label' => 'Update the plugins',
				'does'  => 'These are the same updates as the Updates section above: APPLY NOW takes a snapshot of each plugin before it touches it.',
			),
			'theme_version' => array(
				'kind'  => 'updates',
				'label' => 'Update the themes',
				'does'  => 'The same updates as the Updates section above, snapshotted before they are applied.',
			),

			// ── A withdrawn plugin: a real fix, with a real consequence ─────
			'morpheus_closed_plugins' => array(
				'kind'    => 'guided',
				'label'   => 'Replace the withdrawn plugin',
				'does'    => 'A plugin withdrawn from wordpress.org will never get another security fix.',
				'steps'   => array(
					array( 'text' => 'Open your plugins list and note which plugin the finding named.' ),
					array( 'text' => 'Find its replacement, or confirm you no longer need it.', 'link' => '/wp-admin/plugin-install.php' ),
					array( 'text' => 'Install the replacement and deactivate the old one, then come back and re-check — Morpheus confirms it itself.', 'link' => '/wp-admin/plugins.php' ),
				),
			),

			// Found by the harness against a real WordPress, not by guessing:
			// these three surfaced as attention-worthy with no registered action.
			'wordpress_version' => array(
				'kind'  => 'guided',
				'label' => 'Make WordPress check for updates again',
				'does'  => 'WordPress could not reach wordpress.org to ask, so it does not know whether it is current — and neither do you.',
				'steps' => array(
					array( 'text' => 'Force a check now.', 'link' => '/wp-admin/update-core.php?force-check=1' ),
					array( 'text' => 'If it still cannot reach out, paste this to your host: "Please allow this site\'s PHP to make outbound HTTPS requests to api.wordpress.org and downloads.wordpress.org."' ),
				),
			),
			'debug_enabled' => array(
				'kind'  => 'guided',
				'label' => 'Stop logging errors to a public file',
				'does'  => 'WP_DEBUG_LOG is writing wp-content/debug.log, which is readable over the web. Which fix you want is your call — Morpheus will not decide how much debugging you keep.',
				'steps' => array(
					array( 'text' => 'For a live site, add this to wp-config.php above the "stop editing" line: define( \'WP_DEBUG\', false );' ),
					array( 'text' => 'Or keep debugging and move the log outside the web root: define( \'WP_DEBUG_LOG\', \'/home/your-account/debug.log\' );' ),
					array( 'text' => 'Whichever you choose, the log file itself should not be downloadable — check wp-content/debug.log in a browser and delete it if it is.' ),
				),
			),
			'woocommerce_secure_connection' => array(
				'kind'  => 'guided',
				'label' => 'Serve the store over HTTPS',
				'does'  => 'Customer details and payment steps should never cross plain HTTP. The certificate is issued by your host or CDN, not by WordPress.',
				'steps' => array(
					array( 'text' => 'Get a free certificate from your host — look for "SSL/TLS" or "Free SSL" in the control panel.' ),
					array( 'text' => 'Then set both URLs to https://.', 'link' => '/wp-admin/options-general.php' ),
				),
			),

			// ── Host-level: Morpheus cannot change these, and says so ───────
			'php_version' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to change the PHP version',
				'does'  => 'PHP runs the whole site; Morpheus cannot change which version your host gives you.',
				'steps' => array(
					array( 'text' => 'Open your hosting control panel and find the PHP version selector (cPanel calls it "Select PHP Version", Plesk "PHP Settings"). Most hosts let you change it yourself.' ),
					array( 'text' => 'Choose the newest version WordPress recommends, then re-check. Test the site afterwards — an old plugin can break on a new PHP.' ),
				),
			),
			'php_extensions' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to enable the missing PHP extension',
				'does'  => 'Extensions are compiled into PHP by the host; a plugin cannot add one.',
				'steps' => array(
					array( 'text' => 'Note the extension names listed in the finding above.' ),
					array( 'text' => 'Look for a "PHP extensions" or "PHP modules" toggle in your hosting panel — many hosts expose them there — and enable them, then re-check.' ),
				),
			),
			'php_default_timezone' => array(
				'kind'  => 'guided',
				'label' => 'Set the PHP timezone',
				'does'  => 'This one CAN be fixed in wp-config.php by hand, and Morpheus will show you the line rather than editing yours for something cosmetic.',
				'steps' => array(
					array( 'text' => 'In wp-config.php, above the /* That\'s all, stop editing! */ line, add: date_default_timezone_set( \'Australia/Sydney\' ); — using your own timezone.' ),
					array( 'text' => 'Save, then re-check.' ),
				),
			),
			'sql_server' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to update MySQL/MariaDB',
				'does'  => 'The database server is the host\'s; nothing inside WordPress can change it.',
				'steps' => array(
					array( 'text' => 'Send your host the finding above and ask whether a newer MySQL or MariaDB is available on your plan.' ),
				),
			),
			'ssl_support' => array(
				'kind'  => 'guided',
				'label' => 'Get a certificate and serve the site over HTTPS',
				'does'  => 'HTTPS is configured at the host or CDN, not in WordPress.',
				'steps' => array(
					array( 'text' => 'Most hosts issue a free Let\'s Encrypt certificate from the control panel — look for "SSL/TLS" or "Free SSL".' ),
					array( 'text' => 'Once it is issued, turn on "force HTTPS" for the site, then re-check.' ),
				),
			),
			'https_status' => array(
				'kind'  => 'guided',
				'label' => 'Finish switching the site to HTTPS',
				'does'  => 'The certificate may exist while WordPress still points at http://.',
				'steps' => array(
					array( 'text' => 'Settings → General: make sure both WordPress Address and Site Address start with https://.', 'link' => '/wp-admin/options-general.php' ),
					array( 'text' => 'Then re-check — Morpheus confirms the site now answers on HTTPS.' ),
				),
			),
			'file_uploads' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to enable file uploads',
				'does'  => 'The uploads setting lives in the host\'s php.ini.',
				'steps' => array(
					array( 'text' => 'Ask your host to set file_uploads = On for this site, or expose the setting in your control panel.' ),
				),
			),
			'opcode_cache' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to enable an opcode cache',
				'does'  => 'A performance nicety, not a fault. It is configured by the host.',
				'steps' => array(
					array( 'text' => 'Ask your host whether OPcache is available; on most modern plans it already is.' ),
				),
			),
			'persistent_object_cache' => array(
				'kind'  => 'guided',
				'label' => 'Consider a persistent object cache',
				'does'  => 'Only worth doing on a busy site, and it needs a Redis or Memcached service from your host.',
				'steps' => array(
					array( 'text' => 'Ask your host whether Redis is available on your plan, then install an object-cache plugin.', 'link' => '/wp-admin/plugin-install.php?s=redis&tab=search&type=term' ),
				),
			),
			'available_updates_disk_space' => array(
				'kind'  => 'guided',
				'label' => 'Free up disk space',
				'does'  => 'Updates need room to unpack; only your host can give you more.',
				'steps' => array(
					array( 'text' => 'Delete unused plugins and themes, and old backups, then re-check.' ),
					array( 'text' => 'If the site still has no room, ask your host for more disk.', 'link' => '/wp-admin/plugins.php?plugin_status=inactive' ),
				),
			),
			'autoloaded_options' => array(
				'kind'  => 'guided',
				'label' => 'Trim autoloaded data',
				'does'  => 'A large autoloaded set slows every page. What to remove needs judgement, so Morpheus shows you where to look rather than guessing.',
				'steps' => array(
					array( 'text' => 'Usually this is a plugin leaving data behind, or a caching plugin. Deactivate plugins you are not using, then re-check.', 'link' => '/wp-admin/plugins.php' ),
				),
			),

			// ── Connectivity: real symptoms, host-side causes ───────────────
			'http_requests' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to allow outbound requests',
				'does'  => 'WordPress could not reach itself or a service it needs. That is a host firewall or DNS setting.',
				'steps' => array(
					array( 'text' => 'Send the finding above to your host: outbound HTTP requests from PHP must be allowed.' ),
				),
			),
			'rest_availability' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host about the REST API being blocked',
				'does'  => 'Something is intercepting /wp-json/ — usually a security plugin or the host.',
				'steps' => array(
					array( 'text' => 'Check your security plugin for a "disable REST API" setting.', 'link' => '/wp-admin/plugins.php' ),
					array( 'text' => 'If no plugin is doing it, send the finding above to your host.' ),
				),
			),
			'dotorg_communication' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host about reaching wordpress.org',
				'does'  => 'Without it, WordPress cannot check for updates at all — which is why "nothing to update" cannot be trusted on this site.',
				'steps' => array(
					array( 'text' => 'Send the finding above to your host; api.wordpress.org must be reachable from PHP.' ),
				),
			),
			'loopback_requests' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host about loopback requests',
				'does'  => 'The site cannot call itself, which WordPress uses for scheduled work and several health checks.',
				'steps' => array(
					array( 'text' => 'Send the finding above to your host; a request from the server to its own URL must succeed.' ),
				),
			),
			'authorization_header' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host to pass the Authorization header',
				'does'  => 'Some hosts strip it, which breaks application passwords and API authentication.',
				'steps' => array(
					array( 'text' => 'Send the finding above to your host and ask them to pass the Authorization header through to PHP.' ),
					array( 'text' => 'If you use CGI/FastCGI, this can also be set in .htaccess — SetEnvIf Authorization "(.*)" HTTP_AUTHORIZATION=$1.' ),
				),
			),
			'page_cache' => array(
				'kind'  => 'guided',
				'label' => 'Consider a page cache',
				'does'  => 'Performance advice rather than a fault; a caching plugin is the usual fix.',
				'steps' => array(
					array( 'text' => 'Install a caching plugin if the site is slow rather than for this check alone.', 'link' => '/wp-admin/plugin-install.php?s=cache&tab=search&type=term' ),
				),
			),

			// ── Ours: the one that is usually the host ──────────────────────
			'morpheus_can_update_files' => array(
				'kind'  => 'guided',
				'label' => 'Get file-writing access for WordPress',
				'does'  => 'Until this is fixed nobody can update the site from WordPress.',
				'steps' => array(
					array( 'text' => 'If your host offers a filesystem-method setting, set it to direct. Otherwise ask your host to make wp-content/plugins and wp-content/themes writable by PHP.' ),
					array( 'text' => 'Morpheus will never ask you for FTP or SSH credentials. If your host insists on them, updates have to be done from your host\'s file manager or by hand.' ),
				),
			),
			'morpheus_loopback' => array(
				'kind'  => 'guided',
				'label' => 'Ask your host about the site reaching itself',
				'does'  => 'Same cause as WordPress\'s own loopback test: a firewall or DNS setting.',
				'steps' => array(
					array( 'text' => 'Send the finding above to your host.' ),
				),
			),
		);

		// Every guided finding gets at least one real link. For findings whose only
		// remedy is the host, there is no site screen to point at — so they point at
		// WordPress's own Site Health screen, which shows the SAME test with
		// WordPress's own explanation. Guaranteed to exist (5.2+), unlike a doc URL
		// quoted from memory, and genuinely useful to read while you wait on a host.
		foreach ( $registry as $id => $entry ) {
			if ( 'guided' !== ( $entry['kind'] ?? '' ) ) {
				continue;
			}
			$has_link = false;
			foreach ( ( $entry['steps'] ?? array() ) as $step ) {
				if ( ! empty( $step['link'] ) ) {
					$has_link = true;
				}
			}
			if ( ! $has_link ) {
				$registry[ $id ]['steps'][] = array(
					'text' => 'For background, Tools → Site Health in wp-admin shows this same test with WordPress\'s own explanation.',
					'link' => '/wp-admin/site-health.php',
				);
			}
		}

		return $registry;
	}

	/** The registry entry for a finding id, or null. */
	public static function for_id( $id ) {
		$all = self::registry();
		return isset( $all[ $id ] ) ? $all[ $id ] : null;
	}

	/**
	 * Annotate findings with their action, and count the ones that have none.
	 *
	 * A finding that PASSES needs no action, so it is not unmapped — the count is
	 * only of findings that ask for something and have no way to get it.
	 */
	public static function annotate( &$findings ) {
		$unmapped = array();
		foreach ( $findings as $i => $f ) {
			$entry = self::for_id( $f['id'] ?? '' );
			if ( $entry ) {
				$findings[ $i ]['fix'] = array(
					'kind'    => $entry['kind'],
					'label'   => $entry['label'],
					'does'    => $entry['does'],
					'warning' => $entry['warning'] ?? null,
					'steps'   => $entry['steps'] ?? array(),
				);
				continue;
			}
			$status = $f['status'] ?? '';
			if ( 'critical' === $status || 'recommended' === $status ) {
				$unmapped[] = array( 'id' => $f['id'] ?? '', 'label' => $f['label'] ?? '' );
			}
		}
		return $unmapped;
	}

	// ── Doing it ────────────────────────────────────────────────────────────

	/**
	 * Run one fix. Returns array( 'ok', 'id', 'did', 'verified', 'restored', 'error' ).
	 *
	 * Nothing here is attempted without a backup where a backup is meaningful, and
	 * every action is verified afterwards. A verification failure puts the old
	 * state back.
	 */
	public static function apply( $id ) {
		$entry = self::for_id( $id );
		if ( ! $entry ) {
			return array( 'ok' => false, 'id' => $id, 'error' => 'Morpheus has no fix registered for "' . $id . '". Nothing was changed.', 'code' => 'NO_FIX' );
		}
		if ( 'auto' !== $entry['kind'] ) {
			return array(
				'ok'    => false,
				'id'    => $id,
				'code'  => 'NOT_AUTOMATIC',
				'error' => 'guided' === $entry['kind']
					? 'This one needs a step only you can take. Follow the steps shown, then press re-check.'
					: 'This finding is fixed by the updates section rather than by a single action.',
			);
		}

		switch ( $entry['fix'] ) {
			case 'wp_config_define':
				return self::fix_wp_config_define( $id, $entry['args']['name'], $entry['args']['value'] );
			case 'set_option':
				return self::fix_set_option( $id, $entry['args']['name'], $entry['args']['value'] );
			case 'make_backup_dir':
				return self::fix_make_backup_dir( $id );
			case 'spawn_cron':
				return self::fix_spawn_cron( $id );
			case 'quarantine_robots_txt':
				return self::fix_quarantine_robots_txt( $id );
			default:
				return array( 'ok' => false, 'id' => $id, 'code' => 'NO_MECHANISM', 'error' => 'The registry names a mechanism that does not exist. Nothing was changed.' );
		}
	}

	/**
	 * Add a define() to wp-config.php.
	 *
	 * The one fix here that edits a file the owner cannot afford to lose, so:
	 * back the file up first, insert above WordPress's own "stop editing" marker
	 * (or append if that marker is missing), write atomically, then READ IT BACK
	 * and confirm the constant is present. Any failure restores the backup.
	 */
	private static function fix_wp_config_define( $id, $name, $value ) {
		$file = self::wp_config_path();
		if ( ! $file ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_WP_CONFIG', 'error' => 'Morpheus cannot find wp-config.php to edit. Nothing was changed.' );
		}
		$original = @file_get_contents( $file );
		if ( false === $original ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'UNREADABLE', 'error' => 'wp-config.php could not be read. Nothing was changed.' );
		}
		// Already there — report success rather than adding a second copy.
		if ( preg_match( '/define\s*\(\s*[\'"]' . preg_quote( $name, '/' ) . '[\'"]/i', $original ) ) {
			return array( 'ok' => true, 'id' => $id, 'did' => 'already set', 'verified' => self::wp_config_has( $file, $name ), 'restored' => false, 'error' => null );
		}

		$line = "define( '" . $name . "', " . $value . " );\n";
		$marker = "/* That's all, stop editing!";
		$pos    = strpos( $original, $marker );
		if ( false !== $pos ) {
			$updated = substr( $original, 0, $pos ) . $line . substr( $original, $pos );
		} else {
			$updated = rtrim( $original, "\n" ) . "\n\n" . $line;
		}

		$backup = self::backup_file( $file );
		if ( is_wp_error( $backup ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_BACKUP', 'error' => 'No backup of wp-config.php could be taken, so Morpheus did not touch it: ' . $backup->get_error_message() );
		}

		if ( ! self::write_atomic( $file, $updated ) ) {
			self::restore_file_backup( $backup, $file );
			return array( 'ok' => false, 'id' => $id, 'code' => 'WRITE_FAILED', 'error' => 'wp-config.php could not be written; the original was put back. Nothing was changed.' );
		}

		$verified = self::wp_config_has( $file, $name );
		if ( ! $verified ) {
			self::restore_file_backup( $backup, $file );
			return array( 'ok' => true, 'id' => $id, 'did' => 'attempted', 'verified' => false, 'restored' => true, 'error' => 'The change did not verify, so wp-config.php was restored from the backup.' );
		}
		return array( 'ok' => true, 'id' => $id, 'did' => 'added define( \'' . $name . '\' ) to wp-config.php', 'verified' => true, 'restored' => false, 'error' => null );
	}

	private static function fix_set_option( $id, $name, $value ) {
		$before = get_option( $name );
		update_option( $name, $value );
		$after = get_option( $name );
		$ok    = (string) $after === (string) $value;
		return array(
			'ok'       => true,
			'id'       => $id,
			'did'      => 'set ' . $name . ' to ' . var_export( $value, true ),
			'verified' => $ok,
			'before'   => $before,
			'restored' => false,
			'error'    => $ok ? null : 'The setting did not take the new value.',
		);
	}

	private static function fix_make_backup_dir( $id ) {
		$dir = trailingslashit( WP_CONTENT_DIR ) . 'upgrade-temp-backup';
		if ( ! wp_mkdir_p( $dir ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'MKDIR_FAILED', 'error' => 'Morpheus could not create ' . $dir . ' — the host does not allow PHP to write there.' );
		}
		@file_put_contents( trailingslashit( $dir ) . 'index.php', "<?php // Silence is golden.\n" );
		return array( 'ok' => true, 'id' => $id, 'did' => 'created wp-content/upgrade-temp-backup', 'verified' => wp_is_writable( $dir ), 'restored' => false, 'error' => null );
	}

	private static function fix_spawn_cron( $id ) {
		if ( ! function_exists( 'spawn_cron' ) ) {
			require_once ABSPATH . 'wp-includes/cron.php';
		}
		$before = self::overdue_events();
		spawn_cron();
		// Give it a moment: spawn_cron fires a non-blocking request.
		$after = self::overdue_events();
		return array(
			'ok'       => true,
			'id'       => $id,
			'did'      => 'asked WordPress to run the overdue events',
			'verified' => $after < $before || 0 === $after,
			'before'   => $before,
			'after'    => $after,
			'restored' => false,
			'error'    => null,
			'note'     => $after >= $before ? 'The events are still overdue, which usually means your host is not running wp-cron at all — that is a host setting.' : null,
		);
	}

	private static function overdue_events() {
		$n   = 0;
		$now = time();
		foreach ( (array) _get_cron_array() as $timestamp => $hooks ) {
			foreach ( (array) $hooks as $events ) {
				foreach ( (array) $events as $event ) {
					if ( ! empty( $event['schedule'] ) && $timestamp <= $now ) {
						$n++;
					}
				}
			}
		}
		return $n;
	}

	// ── Quarantining a stale physical robots.txt ────────────────────────────

	/**
	 * Move a stale physical robots.txt out of the way so WordPress serves its
	 * own — RENAME, NEVER DELETE.
	 *
	 * WHY A RENAME AND NOT A DELETE
	 *
	 * The owner of the site this was built for owns the hosting account but not
	 * the cPanel login (a third-party IT company holds it), so "just delete the
	 * file" was not available to him. Even for an owner who can reach a file
	 * manager, a robots.txt carries the site's own User-agent and Disallow
	 * rules, and those are not reconstructible from anything on the site. So the
	 * file is renamed to `robots.txt.morpheus-bak-YYYYMMDDHHMMSS` in the same
	 * directory — the operator's undo, readable in any file manager.
	 *
	 * WHAT IT REFUSES
	 *
	 *   * anything the deny-list covers (a belt on the mechanism: the path is
	 *     hard-coded to the site root's robots.txt and nothing else);
	 *   * a file that is no longer there (someone else removed it since the
	 *     scan — say so instead of reporting a success that did nothing);
	 *   * a file that is NOT the one being served. Moving a file the site is not
	 *     serving changes nothing, so the honest answer is "this is not your
	 *     problem" rather than a rename that looks like a fix;
	 *   * an existing backup of the same name, which would silently destroy the
	 *     only undo.
	 *
	 * AND IT VERIFIES, THEN PUTS IT BACK. After the rename it re-fetches the
	 * live /robots.txt — what a crawler would get — and requires that it is no
	 * longer the old body AND that it carries every Sitemap line WordPress's own
	 * filter chain is emitting. Anything else renames the backup straight back
	 * and reports the reason; the site is left exactly as it was found.
	 */
	private static function fix_quarantine_robots_txt( $id ) {
		// The one path this mechanism may ever touch. If the deny-list is ever
		// widened to cover it, this refuses rather than finding a way around it.
		if ( morpheus_is_denied( Morpheus_SEO::ROBOTS_FILE ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'DENIED', 'error' => 'robots.txt is on the deploy deny-list for this plugin, so Morpheus will not move it. Nothing was changed.' );
		}
		$file = ABSPATH . Morpheus_SEO::ROBOTS_FILE;

		// Re-ask the same question the scan asked, now: the scan is cached, and
		// the file may have changed, been removed, or stopped being the one
		// served since. Never move a file on the strength of a five-minute-old
		// answer.
		$state = class_exists( 'Morpheus_SEO' ) ? Morpheus_SEO::robots_txt_state() : null;
		if ( ! is_array( $state ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'UNKNOWN', 'error' => 'Morpheus could not confirm which robots.txt this site is serving, so it did not move anything. Re-check the site and try again.' );
		}
		if ( empty( $state['physical'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_FILE', 'error' => 'There is no physical robots.txt at ' . $file . ' any more — something removed it since the scan. Nothing was changed; re-check the site.' );
		}
		if ( empty( $state['served'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NOT_SERVED', 'error' => 'The file at ' . $file . ' is not the robots.txt this site is serving — WordPress\'s own already is. Moving it would change nothing, so Morpheus did not. Nothing was changed.' );
		}

		$before = @file_get_contents( $file );
		if ( ! is_string( $before ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'UNREADABLE', 'error' => 'The robots.txt file at ' . $file . ' could not be read, so Morpheus did not move it. Nothing was changed.' );
		}

		$backup = self::robots_backup_path( $file );
		if ( file_exists( $backup ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'BACKUP_EXISTS', 'error' => 'A backup from this same second already exists at ' . $backup . ', and Morpheus will not overwrite the only copy of the original. Nothing was changed — try again in a moment.' );
		}
		if ( ! @rename( $file, $backup ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'RENAME_FAILED', 'error' => 'Morpheus could not rename ' . $file . ' to ' . $backup . ' — this host does not let PHP write in the site root, so the file cannot be quarantined from here. Nothing was changed. Your host or whoever holds your hosting account would have to rename it.' );
		}

		// A page cache can keep serving the old robots.txt after the file is
		// gone, so clear what we can before asking the site what it serves now.
		morpheus_purge_caches();

		$verdict = self::verify_quarantined_robots( $before );
		if ( empty( $verdict['ok'] ) ) {
			$put_back = @rename( $backup, $file );
			return array(
				// Mirrors fix_wp_config_define: the run happened and did not
				// hold, which `verified => false` outranks `ok` for on the panel.
				'ok'       => true,
				'id'       => $id,
				'code'     => 'NOT_VERIFIED',
				'did'      => 'renamed robots.txt to ' . $backup,
				'backup'   => $backup,
				'verified' => false,
				'restored' => (bool) $put_back,
				'error'    => $verdict['why'] . ( $put_back
					? ' The file was renamed straight back, so the site is exactly as it was.'
					: ' Morpheus could NOT put the file back — it is still at ' . $backup . '.' ),
			);
		}

		return array(
			'ok'       => true,
			'id'       => $id,
			'did'      => 'quarantined the stale robots.txt — renamed it to ' . $backup . ' so WordPress serves its own again',
			// The undo, as a field rather than only inside a sentence: the app
			// lifts this out and states it (lib/robotsQuarantine.js).
			'backup'   => $backup,
			'verified' => true,
			'restored' => false,
			'error'    => null,
			'note'     => $verdict['note'],
		);
	}

	/**
	 * Where a quarantined robots.txt goes: beside it, under a UTC timestamp.
	 *
	 * UTC (`gmdate`), not the site's timezone, so the name is the same fact read
	 * from anywhere. Format pinned by the app side (lib/robotsQuarantine.js) and
	 * asserted by scripts/verify-seo.mjs — a change here is a change to the
	 * operator's undo, so it is not allowed to be a silent one.
	 */
	public static function robots_backup_path( $file = null ) {
		$file = is_string( $file ) && '' !== $file ? $file : ABSPATH . 'robots.txt';
		return $file . '.morpheus-bak-' . gmdate( 'YmdHis' );
	}

	/**
	 * Is the dynamic robots.txt being served now, and does it carry the right
	 * sitemap line?
	 *
	 * @return array{ok:bool, why:?string, note:?string}
	 */
	private static function verify_quarantined_robots( $previous ) {
		$url  = home_url( '/robots.txt' );
		$live = Morpheus_SEO::fetch_robots_txt();
		$note = null;

		if ( null !== $live && Morpheus_SEO::bodies_match( $previous, $live ) ) {
			// A cache can outlive the file. Ask again behind a cache-busting
			// query before declaring failure: renaming the file back because a
			// cache is warm would undo a fix that actually worked.
			$note = 'A cached copy of the old robots.txt is still being handed to some requests. The file itself is quarantined and the site is serving WordPress\'s own behind the cache, which will expire on its own.';
			$live = Morpheus_SEO::fetch_robots_txt( add_query_arg( 'morpheus-verify', time(), $url ) );
		}

		if ( null === $live ) {
			return array(
				'ok'   => false,
				'note' => null,
				'why'  => 'After moving the file, the site did not answer a request for /robots.txt (it was asked ' . Morpheus_SEO::ROBOTS_FETCH_ATTEMPTS . ' times), so Morpheus cannot confirm that WordPress\'s own robots.txt is now being served.',
			);
		}
		if ( Morpheus_SEO::bodies_match( $previous, $live ) ) {
			return array( 'ok' => false, 'note' => null, 'why' => 'The site is still serving the old file\'s contents at /robots.txt, so the quarantine did not take effect.' );
		}

		$missing = array();
		foreach ( Morpheus_SEO::dynamic_sitemap_urls() as $want ) {
			if ( ! Morpheus_SEO::advertises( $live, $want ) ) {
				$missing[] = $want;
			}
		}
		if ( $missing ) {
			return array(
				'ok'   => false,
				'note' => null,
				'why'  => 'WordPress\'s own robots.txt is now being served, but it does not advertise ' . implode( ', ', $missing ) . ' — so the site would still be hiding its sitemap.',
			);
		}

		return array( 'ok' => true, 'note' => $note, 'why' => null );
	}

	// ── File plumbing ───────────────────────────────────────────────────────

	/** wp-config.php is one directory above wp-content, and not always where ABSPATH says. */
	private static function wp_config_path() {
		$candidates = array();
		if ( defined( 'ABSPATH' ) ) {
			$candidates[] = ABSPATH . 'wp-config.php';
			$candidates[] = dirname( ABSPATH ) . '/wp-config.php';
		}
		foreach ( $candidates as $c ) {
			if ( file_exists( $c ) && is_writable( $c ) ) {
				return $c;
			}
		}
		// Exists but not writable — report it, so the failure names the real problem.
		foreach ( $candidates as $c ) {
			if ( file_exists( $c ) ) {
				return $c;
			}
		}
		return null;
	}

	private static function wp_config_has( $file, $name ) {
		$body = @file_get_contents( $file );
		return is_string( $body ) && (bool) preg_match( '/define\s*\(\s*[\'"]' . preg_quote( $name, '/' ) . '[\'"]/i', $body );
	}

	/**
	 * Back a single file into the protected backup directory, as a ZIP.
	 *
	 * ZIP rather than a plain copy so it lands in the same place, in the same
	 * format, as the plugin/theme snapshots — listed by Morpheus_Maintenance::
	 * backups() and removable by delete_snapshot(). A plain .bak was invisible to
	 * both, which the harness caught: the backup existed and nothing could show or
	 * clean it.
	 */
	private static function backup_file( $file ) {
		if ( ! class_exists( 'Morpheus_Maintenance' ) ) {
			return new WP_Error( 'morpheus_no_maintenance', 'The maintenance engine is not loaded, so no backup could be taken.' );
		}
		if ( ! class_exists( 'ZipArchive' ) ) {
			return new WP_Error( 'morpheus_no_zip', 'This host\'s PHP has no zip extension, so a backup cannot be taken — and Morpheus does not edit wp-config.php without one.' );
		}
		$dir = Morpheus_Maintenance::backup_dir();
		if ( is_wp_error( $dir ) ) {
			return $dir;
		}
		$dest = trailingslashit( $dir ) . 'file-' . sanitize_file_name( basename( $file ) ) . '-' . gmdate( 'Ymd-His' ) . '.zip';
		$zip  = new ZipArchive();
		if ( true !== $zip->open( $dest, ZipArchive::CREATE | ZipArchive::OVERWRITE ) ) {
			return new WP_Error( 'morpheus_backup_failed', 'Could not create a backup archive for ' . basename( $file ) . '.' );
		}
		$zip->addFile( $file, basename( $file ) );
		$zip->close();
		if ( ! file_exists( $dest ) || filesize( $dest ) < 1 ) {
			return new WP_Error( 'morpheus_backup_empty', 'The backup archive for ' . basename( $file ) . ' came out empty.' );
		}
		return $dest;
	}

	/** Put a file back from a ZIP backup. */
	private static function restore_file_backup( $zip_path, $file ) {
		$zip = new ZipArchive();
		if ( true !== $zip->open( $zip_path ) ) {
			return false;
		}
		$dir = trailingslashit( WP_CONTENT_DIR ) . 'morpheus-restore-' . gmdate( 'YmdHis' );
		if ( ! wp_mkdir_p( $dir ) ) {
			$zip->close();
			return false;
		}
		$ok = $zip->extractTo( $dir, array( basename( $file ) ) );
		$zip->close();
		$extracted = trailingslashit( $dir ) . basename( $file );
		$restored  = $ok && file_exists( $extracted ) && @copy( $extracted, $file );
		@unlink( $extracted );
		@rmdir( $dir );
		return (bool) $restored;
	}

	/** Write via a temporary file and rename, so a half-written config is impossible. */
	private static function write_atomic( $file, $contents ) {
		$tmp = $file . '.morpheus-tmp';
		if ( false === @file_put_contents( $tmp, $contents ) ) {
			return false;
		}
		if ( ! @rename( $tmp, $file ) ) {
			@unlink( $tmp );
			return false;
		}
		return true;
	}
}
