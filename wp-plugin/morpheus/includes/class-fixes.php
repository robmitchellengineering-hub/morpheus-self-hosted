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
	 * Where the LAST attempt at each finding is kept: one option, capped.
	 *
	 * WHY THIS EXISTS
	 *
	 * A refused fix used to leave no trace. The debug.log fix correctly declined
	 * to move a file that was not being served, the panel rescanned, the same
	 * count came back, and NOTHING on screen said why — so a working refusal
	 * looked exactly like a broken button, and the owner pressed it again. The
	 * record is written here (the only place that acts on the site) and read
	 * back into the scan, so it survives a reload and cannot be produced by the
	 * panel's own memory. Not special-cased to one finding: the robots.txt
	 * quarantine and every future fix write the same record.
	 *
	 * WHAT IT IS NOT: a claim. It records what happened, never that the finding
	 * is resolved — the finding's own status still comes from the check, so a
	 * recorded attempt can never turn an unrun or failed fix into a "done".
	 */
	const ATTEMPTS_OPTION = 'morpheus_fix_attempts';

	/** How many finding ids the record keeps. Newest wins when it is full. */
	const MAX_ATTEMPTS = 20;

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
			'morpheus_debug_log_in_web_root' => array(
				'kind'    => 'auto',
				'label'   => 'Move the error log outside the web root',
				'does'    => 'Points WP_DEBUG_LOG at a file beside your site instead of inside it, and moves the log that is there now. NOTHING IS DELETED and debugging stays on — you keep the log, the web stops being able to hand it out. Refuses, and changes nothing, when it cannot prove the new location is outside the web root or cannot find the line that sets WP_DEBUG_LOG.',
				'warning' => 'wp-config.php is edited and the existing log file is renamed to a path outside the web root. Both are reversible: the original wp-config.php is backed up first and restored automatically if the change does not verify, and the log keeps every line it had.',
				'fix'     => 'relocate_debug_log',
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

			// ── CLEAN MY SITE: the safe set ─────────────────────────────────
			//
			// These three are the ONLY automatic actions in the clean scan, and
			// each one is a RENAME of a file that has no legitimate reason to
			// exist there. Everything the clean scan finds that a person has to
			// decide — a modified core file, a plugin file that does not match
			// its published package, an admin account, a cron hook — is `guided`
			// below and is never swept into a press. See class-clean.php.
			//
			// The mechanism lives here, with every other fix, because this class
			// is the only place that WRITES. Each one re-enumerates what to move
			// when it runs rather than trusting the cached scan, renames with a
			// UTC timestamp, and reports the new name as the operator's undo.
			'morpheus_uploads_php' => array(
				'kind'    => 'auto',
				'label'   => 'Quarantine the PHP files in uploads',
				'does'    => 'Renames each .php file under wp-content/uploads to a timestamped backup beside it, so it can no longer be requested or run. Nothing is deleted, and every backup name is listed so it can be renamed back. Morpheus re-reads the folder afterwards and puts a file back if the rename did not verify.',
				'warning' => 'If a plugin really does execute code from your uploads folder, that plugin will stop working until the file is renamed back. Nothing legitimate puts a .php file in a media library — but the backups are listed on screen, so this is reversible in one step.',
				'fix'     => 'quarantine_uploads_php',
			),
			'morpheus_root_config_backup' => array(
				'kind'    => 'auto',
				'label'   => 'Move the config backups out of the web root',
				'does'    => 'Moves wp-config.php.bak/.old/.orig/.save/.txt and any .env copy out of the site root, up one directory beside it, under a timestamped name. A backup file is served as plain text, so it is a full credential leak while it sits there. Nothing is deleted, and Morpheus re-requests the URL afterwards to confirm the file has stopped being served — if it has not, the file goes straight back.',
				'warning' => 'The copy stops being reachable over the web. Its new name is on screen, and renaming it back restores it exactly. On a host where Morpheus cannot prove the new location is unreachable, it refuses and leaves the file where it was rather than move it somewhere it would still be readable.',
				'fix'     => 'quarantine_root_config_backups',
			),
			'morpheus_public_debug_log' => array(
				'kind'    => 'auto',
				'label'   => 'Quarantine the public debug log',
				'does'    => 'Renames wp-content/debug.log to a timestamped backup, so the error log stops being downloadable by anyone who asks, and re-requests the address to confirm it stopped — refusing and putting the file back if it cannot show that. WordPress creates a fresh log on the next warning, so switch WP_DEBUG_LOG off or move it outside the web root to stop it coming back.',
				'warning' => 'Anything already in the log is kept in the backup — nothing is deleted — but the log stops being written at its old path until WordPress recreates it.',
				'fix'     => 'quarantine_public_debug_log',
			),

			// ── CLEAN MY SITE: report only, never applied ───────────────────
			//
			// Each of these needs a person. Re-downloading core over a live site,
			// re-installing a plugin, deleting an account and unscheduling a cron
			// hook are all decisions an automated pass does not get to make, so
			// there is deliberately no mechanism behind these entries — the steps
			// are the whole action.
			'morpheus_core_checksums' => array(
				'kind'  => 'guided',
				'label' => 'Replace the modified core files',
				'does'  => 'A core file that does not match wordpress.org is reported, never repaired from here: re-installing WordPress over a live site is your decision, and the file may be a deliberate patch.',
				'steps' => array(
					array( 'text' => 'Note every file named in the finding. If you (or a developer) patched core deliberately, stop here and keep a record of why.' ),
					array( 'text' => 'Take a full backup of the site — files and database — before touching core.' ),
					array( 'text' => 'Re-install WordPress from the Dashboard. WordPress replaces core files and leaves your content, themes and plugins alone.', 'link' => admin_url( 'update-core.php' ) ),
					array( 'text' => 'Come back and scan again; Morpheus confirms the checksums itself.' ),
				),
			),
			'morpheus_plugin_checksums' => array(
				'kind'  => 'guided',
				'label' => 'Re-install the affected plugin',
				'does'  => 'A plugin file that does not match the package wordpress.org publishes means the code on disk is not the code the author shipped. Re-installing the same version is the clean fix.',
				'steps' => array(
					array( 'text' => 'Note the plugin named in the finding and the files listed under it.' ),
					array( 'text' => 'Delete the plugin and install it again from the directory — same version, clean files.', 'link' => admin_url( 'plugin-install.php' ) ),
					array( 'text' => 'If the extra file is one you added deliberately, keep a note of it rather than deleting it on the strength of this check.' ),
				),
			),
			'morpheus_mu_plugins' => array(
				'kind'  => 'guided',
				'label' => 'Check the mu-plugins inventory',
				'does'  => 'Every file in mu-plugins is loaded on every request with no activation and no entry in the Plugins screen. Some are legitimate — hosts and agencies use them — but nothing in wp-admin lists them, so only you can say which are yours.',
				'steps' => array(
					array( 'text' => 'Open your site\'s files and look at wp-content/mu-plugins — your host\'s file manager does this if you have no FTP access.' ),
					array( 'text' => 'Read each file named in the finding. Anything you do not recognise, send to whoever built the site before removing it.' ),
					array( 'text' => 'To remove one, rename or delete it from the file manager. Morpheus will not touch these files itself.' ),
				),
			),
			'morpheus_admin_users' => array(
				'kind'  => 'guided',
				'label' => 'Review the administrator accounts',
				'does'  => 'Every account listed can reach wp-admin and change anything on the site. Morpheus never removes an account — this is a list to check.',
				'steps' => array(
					array( 'text' => 'Open the users list and confirm you recognise every administrator, and that the email address is one you control.', 'link' => admin_url( 'users.php?role=administrator' ) ),
					array( 'text' => 'For an account you do not recognise: change its password first, then remove it, then change the passwords of every other administrator.' ),
					array( 'text' => 'A new administrator account is a standard way to keep access after a cleanup, so check the registration dates in the finding.' ),
				),
			),
			'morpheus_cron_unattributed' => array(
				'kind'  => 'guided',
				'label' => 'Check the unattributed scheduled tasks',
				'does'  => 'A scheduled hook nobody can attribute is usually a plugin that has been deactivated and left its timer behind. Morpheus will not unschedule anything: removing one can stop a shop\'s stock sync or a backup.',
				'steps' => array(
					array( 'text' => 'Search the hook name in the plugins you run, or ask your host whether it is theirs.' ),
					array( 'text' => 'If it belongs to a plugin you removed, a cron plugin or WP-CLI can delete that one hook — leave the rest alone.' ),
				),
			),
			'morpheus_recent_files' => array(
				'kind'  => 'guided',
				'label' => 'Compare the recent file changes',
				'does'  => 'A plugin, theme or WordPress update produces exactly this list. The newest entry is the one to explain first — a code change you cannot account for is what to look at.',
				'steps' => array(
					array( 'text' => 'Line the timestamps up against what you installed or changed in the last week.' ),
					array( 'text' => 'For anything you cannot explain, check the file\'s contents and its modification time against your backup for that date.' ),
					array( 'text' => 'If a file you did not change is inside a plugin, the plugin checksum finding above may already name it.' ),
				),
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
					array( 'text' => 'Find its replacement, or confirm you no longer need it.', 'link' => admin_url( 'plugin-install.php' ) ),
					array( 'text' => 'Install the replacement and deactivate the old one, then come back and re-check — Morpheus confirms it itself.', 'link' => admin_url( 'plugins.php' ) ),
				),
			),

			// Found by the harness against a real WordPress, not by guessing:
			// these three surfaced as attention-worthy with no registered action.
			'wordpress_version' => array(
				'kind'  => 'guided',
				'label' => 'Make WordPress check for updates again',
				'does'  => 'WordPress could not reach wordpress.org to ask, so it does not know whether it is current — and neither do you.',
				'steps' => array(
					array( 'text' => 'Force a check now.', 'link' => admin_url( 'update-core.php?force-check=1' ) ),
					array( 'text' => 'If it still cannot reach out, paste this to your host: "Please allow this site\'s PHP to make outbound HTTPS requests to api.wordpress.org and downloads.wordpress.org."' ),
				),
			),
			'debug_enabled' => array(
				'kind'  => 'guided',
				'label' => 'Stop logging errors to a public file',
				// NO READABILITY CLAIM HERE. This sentence is the fallback for a
				// finding that arrived without one; WordPress's test says debug
				// mode is ON, which is not the same claim as "the log is readable
				// over the web". Morpheus attaches the VERIFIED answer per scan
				// (see Morpheus_Health::describe_public_debug_log()), because a
				// static claim appended to WordPress's test was wrong on a host
				// whose front controller answers every /wp-content path with 200.
				'does'  => 'WP_DEBUG_LOG is on, so WordPress writes wp-content/debug.log. Whether that file is reachable over the web is a separate question, and Morpheus answers it from the file itself rather than from the URL\'s status. Which fix you want is your call — Morpheus will not decide how much debugging you keep.',
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
					array( 'text' => 'Then set both URLs to https://.', 'link' => admin_url( 'options-general.php' ) ),
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
				'does'  => 'WordPress stores a timezone; PHP does not read it. Anything PHP formats directly — and the timestamps in your error log — can therefore disagree with the site. Morpheus can write one line into wp-config.php for you, or show it to you to add yourself.',
				'steps' => array(
					array( 'text' => 'In wp-config.php, above the /* That\'s all, stop editing! */ line, add: date_default_timezone_set( \'Australia/Sydney\' ); — using your own timezone.' ),
					array( 'text' => 'Save, then re-check.' ),
				),
				// Morpheus has a MECHANISM for this one, so it can propose it —
				// see ai_operations(). It stays `guided` on purpose: nothing is
				// applied until the operator has seen the exact line and pressed
				// APPLY, and it is never swept into FIX ALL, which takes only
				// `auto` findings.
				'ai'    => true,
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
					array( 'text' => 'Settings → General: make sure both WordPress Address and Site Address start with https://.', 'link' => admin_url( 'options-general.php' ) ),
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
					array( 'text' => 'Ask your host whether Redis is available on your plan, then install an object-cache plugin.', 'link' => admin_url( 'plugin-install.php?s=redis&tab=search&type=term' ) ),
				),
			),
			'available_updates_disk_space' => array(
				'kind'  => 'guided',
				'label' => 'Free up disk space',
				'does'  => 'Updates need room to unpack; only your host can give you more.',
				'steps' => array(
					array( 'text' => 'Delete unused plugins and themes, and old backups, then re-check.' ),
					array( 'text' => 'If the site still has no room, ask your host for more disk.', 'link' => admin_url( 'plugins.php?plugin_status=inactive' ) ),
				),
			),
			'autoloaded_options' => array(
				'kind'  => 'guided',
				'label' => 'Trim autoloaded data',
				'does'  => 'A large autoloaded set slows every page. What to remove needs judgement, so Morpheus shows you where to look rather than guessing.',
				'steps' => array(
					array( 'text' => 'Usually this is a plugin leaving data behind, or a caching plugin. Deactivate plugins you are not using, then re-check.', 'link' => admin_url( 'plugins.php' ) ),
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
				'label' => 'Check the REST API yourself, logged in',
				// NO ACCUSATION. This entry said "Something is intercepting
				// /wp-json/ — usually a security plugin or the host", and that is
				// an answer to a question Morpheus had asked wrongly: the test
				// attaches the caller's login, so a scan with no login gets 401 no
				// matter what the host does (see Morpheus_Health::session_bound_tests()).
				// It stays here for sites still running a build that reports the
				// finding; the wording now sends the operator to the one screen
				// that can actually answer it, before their host.
				'does'  => 'This is WordPress asking its own REST API for a context only a logged-in editor may see, with your login attached. A scan running without a login gets 401 whatever the host does, which is why older builds of this plugin reported a "blocked REST API" that was not blocked. Morpheus checks the public REST API itself — the "site can reach itself" check — and if that passes, nothing is intercepting /wp-json/.',
				'steps' => array(
					array( 'text' => 'Open Tools → Site Health while logged in. If this test passes there, the 401 came from the scan having no login, not from your site.', 'link' => admin_url( 'site-health.php' ) ),
					array( 'text' => 'If it fails there too, check your security plugin for a "disable REST API" setting.', 'link' => admin_url( 'plugins.php' ) ),
					array( 'text' => 'Only then ask your host — whether /wp-json/ is blocked for requests the server makes to itself.' ),
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
					array( 'text' => 'Install a caching plugin if the site is slow rather than for this check alone.', 'link' => admin_url( 'plugin-install.php?s=cache&tab=search&type=term' ) ),
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
					'link' => admin_url( 'site-health.php' ),
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
	 * What Morpheus may PROPOSE for a finding that has no rule of its own.
	 *
	 * THE WHOLE SAFETY STORY IS THIS FUNCTION'S SHAPE. An AI cannot be pointed at a
	 * live site and told to fix it: a model that can invent an action can invent a
	 * harmful one, and nothing downstream would know it was outside the design. So the
	 * vocabulary lives HERE, in the plugin, one entry per finding, each naming a single
	 * operation this build knows how to perform, verify and undo. The model's job is to
	 * choose one of these and supply its arguments — never to write code.
	 *
	 * A finding is only offered the button when it appears here, and every argument is
	 * validated against THE SITE'S OWN STATE before anything is touched (a timezone
	 * against PHP's own list, a plugin file against get_plugins(), a cron hook against
	 * the site's own cron array). An argument the model got wrong is a REFUSAL with a
	 * code, not a change.
	 *
	 * WHY THE FIRST ENTRY IS A TIMEZONE. It has to be something the plugin can verify
	 * AND put back: this writes one line through the same backup → write → read-back →
	 * restore rails as every other wp-config fix. Most of the remaining guided findings
	 * are guided because they genuinely need a person — core files, mu-plugins, admin
	 * accounts, PHP version, SSL, DNS — and no amount of model reasoning makes it safe
	 * for Morpheus to edit them. The vocabulary is meant to grow one verified operation
	 * at a time; it is not meant to be impressive.
	 */
	public static function ai_operations() {
		return array(
			'php_default_timezone' => array(
				'op'    => 'wp_config_timezone',
				'label' => 'Write the timezone into wp-config.php',
				'does'  => 'Adds date_default_timezone_set( \'…\' ); above WordPress\'s "stop editing" line, using the timezone this WordPress is already set to. WordPress stores a timezone and PHP never reads it, so log timestamps and anything PHP formats directly can disagree with the site.',
				'args'  => array(
					'timezone' => 'A PHP timezone identifier from timezone_identifiers_list(), e.g. Australia/Sydney. Use the value the site already reports.',
				),
			),
		);
	}

	/**
	 * Apply a PROPOSAL — the same finding, but with the site doing the work.
	 *
	 * Every refusal here is a named code, because a refusal the operator cannot read
	 * looks exactly like a broken button. Nothing in this path is reachable unless the
	 * finding was configured with `ai => true` in the registry AND the proposal named
	 * the one operation that finding is allowed.
	 */
	public static function apply_ai( $id, $proposal ) {
		$menu = self::ai_operations();
		if ( ! isset( $menu[ $id ] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_AI_ACTION', 'error' => 'Morpheus has no mechanism to propose for this finding, so nothing was changed. The steps on it are the way.' );
		}
		if ( empty( self::for_id( $id )['ai'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_AI_ACTION', 'error' => 'This finding is not marked as one Morpheus may act on, so nothing was changed.' );
		}

		$allowed = $menu[ $id ]['op'];
		$asked   = is_array( $proposal ) && isset( $proposal['op'] ) ? (string) $proposal['op'] : '';
		if ( $asked !== $allowed ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'AI_OP_NOT_ALLOWED', 'error' => 'The proposal asked for "' . $asked . '", which is not what Morpheus may do about this finding ("' . $allowed . '"). Nothing was changed.' );
		}

		$args = ( is_array( $proposal ) && isset( $proposal['args'] ) && is_array( $proposal['args'] ) ) ? $proposal['args'] : array();

		switch ( $allowed ) {
			case 'wp_config_timezone':
				return self::ai_wp_config_timezone( $id, $args );
		}
		return array( 'ok' => false, 'id' => $id, 'code' => 'AI_OP_UNKNOWN', 'error' => 'Morpheus does not know how to perform "' . $allowed . '". Nothing was changed.' );
	}

	/**
	 * The one operation the vocabulary has so far: put the site's timezone into
	 * wp-config.php.
	 *
	 * The timezone is NOT taken on trust. It must be a real PHP timezone identifier,
	 * and it must be the one WordPress already reports — a model that proposed a
	 * plausible-looking string, or the wrong city, gets a refusal rather than a config
	 * change nobody can explain. Then the same rails as every other wp-config edit:
	 * back the file up, write atomically, read it back, restore on any doubt.
	 */
	private static function ai_wp_config_timezone( $id, $args ) {
		$tz = isset( $args['timezone'] ) ? trim( (string) $args['timezone'] ) : '';
		if ( '' === $tz || ! in_array( $tz, timezone_identifiers_list(), true ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'BAD_TIMEZONE', 'error' => '"' . $tz . '" is not a PHP timezone identifier, so nothing was changed. They look like "Australia/Sydney".' );
		}
		$site_tz = get_option( 'timezone_string' );
		if ( is_string( $site_tz ) && '' !== $site_tz && $site_tz !== $tz ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'TZ_MISMATCH', 'error' => 'This site is set to ' . $site_tz . ' in WordPress, and the proposal said ' . $tz . '. Morpheus will not write a timezone the site itself disagrees with — change it in Settings → General first if the site is wrong. Nothing was changed.' );
		}

		$file = self::wp_config_path();
		if ( ! $file ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_WP_CONFIG', 'error' => 'Morpheus cannot find wp-config.php to edit. Nothing was changed.' );
		}
		$original = @file_get_contents( $file );
		if ( false === $original ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'UNREADABLE', 'error' => 'wp-config.php could not be read. Nothing was changed.' );
		}

		$rewritten = self::wp_config_set_timezone( $original, $tz );
		if ( isset( $rewritten['error'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => $rewritten['code'], 'error' => $rewritten['error'] );
		}

		$backup = self::backup_file( $file );
		if ( is_wp_error( $backup ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_BACKUP', 'error' => 'No backup of wp-config.php could be taken, so Morpheus did not touch it: ' . $backup->get_error_message() );
		}
		if ( ! self::write_atomic( $file, $rewritten['body'] ) ) {
			self::restore_file_backup( $backup, $file );
			return array( 'ok' => false, 'id' => $id, 'code' => 'WRITE_FAILED', 'error' => 'wp-config.php could not be written; the original was put back. Nothing was changed.' );
		}

		$back = @file_get_contents( $file );
		if ( ! is_string( $back ) || ! preg_match( '/date_default_timezone_set\s*\(\s*[\'"]' . preg_quote( $tz, '/' ) . '[\'"]\s*\)/', $back ) ) {
			self::restore_file_backup( $backup, $file );
			return array( 'ok' => true, 'id' => $id, 'did' => 'attempted', 'verified' => false, 'restored' => true, 'error' => 'The line did not read back as the timezone asked for, so wp-config.php was restored from the backup. Nothing was changed.' );
		}
		return array( 'ok' => true, 'id' => $id, 'did' => 'added date_default_timezone_set( \'' . $tz . '\' ) to wp-config.php', 'verified' => true, 'restored' => false, 'error' => null );
	}

	/**
	 * Put a `date_default_timezone_set( '…' );` in wp-config.php — replacing one that is
	 * already there, refusing when there is more than one (PHP would run the first, so
	 * editing the other silently changes nothing).
	 *
	 * PUBLIC and pure for the same reason `wp_config_set_define()` is: the harness has to
	 * be able to exercise the rule directly, and the refusals are the part that decides
	 * whether a live config gets edited at all.
	 */
	public static function wp_config_set_timezone( $body, $timezone ) {
		$pattern = '/date_default_timezone_set\s*\(\s*[\'"](.*?)[\'"]\s*\)\s*;/i';
		$count   = preg_match_all( $pattern, $body );
		if ( $count > 1 ) {
			return array( 'code' => 'AMBIGUOUS_CALL', 'error' => 'wp-config.php sets the PHP timezone more than once, and PHP would use the first. Morpheus will not choose for you, so nothing was changed.' );
		}

		$line = "date_default_timezone_set( '" . $timezone . "' );";
		if ( 1 === $count ) {
			$rewritten = preg_replace_callback( $pattern, function () use ( $line ) { return $line; }, $body, 1 );
			if ( ! is_string( $rewritten ) || $rewritten === $body ) {
				return array( 'code' => 'NO_CHANGE', 'error' => 'Morpheus could not rewrite the timezone line. Nothing was changed.' );
			}
			return array( 'body' => $rewritten );
		}

		$marker = "/* That's all, stop editing!";
		$pos    = strpos( $body, $marker );
		if ( false !== $pos ) {
			return array( 'body' => substr( $body, 0, $pos ) . $line . "\n" . substr( $body, $pos ) );
		}
		return array( 'body' => rtrim( $body, "\n" ) . "\n\n" . $line . "\n" );
	}

	/**
	 * Annotate findings with their action, and count the ones that have none.
	 *
	 * A finding that PASSES needs no action, so it is not unmapped — the count is
	 * only of findings that ask for something and have no way to get it.
	 *
	 * A finding may carry its own sentence for the action under `action_does`,
	 * written by the check that produced it. It is used in place of the
	 * registry's static sentence because some of these findings sit on top of a
	 * WordPress test whose subject the registry cannot know: `debug_enabled` is
	 * "debug mode is on", and only the scan can say whether the log it writes is
	 * actually being served. Appending a static claim there is how Morpheus told
	 * an owner his log was readable when his host was answering 200 with its own
	 * HTML page — so the scan's verified sentence wins, and the static one is
	 * only the fallback.
	 */
	public static function annotate( &$findings ) {
		$unmapped = array();
		foreach ( $findings as $i => $f ) {
			$entry = self::for_id( $f['id'] ?? '' );
			if ( $entry ) {
				$verified = isset( $f['action_does'] ) && is_string( $f['action_does'] ) ? trim( $f['action_does'] ) : '';
				$fix = array(
					'kind'    => $entry['kind'],
					'label'   => $entry['label'],
					'does'    => '' !== $verified ? $verified : $entry['does'],
					'warning' => $entry['warning'] ?? null,
					'steps'   => $entry['steps'] ?? array(),
				);
				// Whether Morpheus has a MECHANISM it could PROPOSE for this finding,
				// in the operator's words. The key is added only when there is one, so
				// every other finding's payload is exactly what it was — a key that is
				// always present and usually null is how a panel comes to render an
				// empty button.
				if ( ! empty( $entry['ai'] ) ) {
					$menu     = self::ai_operations();
					$fix['ai'] = $menu[ $f['id'] ?? '' ]['label'] ?? '';
				}
				$findings[ $i ]['fix'] = $fix;
				unset( $findings[ $i ]['action_does'] );
				continue;
			}
			$status = $f['status'] ?? '';
			if ( 'critical' === $status || 'recommended' === $status ) {
				$unmapped[] = array( 'id' => $f['id'] ?? '', 'label' => $f['label'] ?? '' );
			}
		}
		return $unmapped;
	}

	// ── What the last attempt at each finding did ───────────────────────────

	/**
	 * The recorded attempts, sanitised, keyed by finding id.
	 *
	 * An unrecognised outcome reads as a REFUSAL, never as a success: this record
	 * is shown to an operator who may act on it, and the only safe direction for
	 * an unknown value is "we cannot claim this worked".
	 */
	public static function attempts() {
		$all = get_option( self::ATTEMPTS_OPTION, array() );
		if ( ! is_array( $all ) ) {
			return array();
		}
		$out = array();
		foreach ( $all as $id => $row ) {
			if ( ! is_string( $id ) || '' === $id || ! is_array( $row ) ) {
				continue;
			}
			$out[ $id ] = array(
				'outcome' => ( 'done' === ( $row['outcome'] ?? '' ) ) ? 'done' : 'refused',
				'code'    => isset( $row['code'] ) && is_string( $row['code'] ) && '' !== $row['code'] ? $row['code'] : null,
				'message' => isset( $row['message'] ) && is_string( $row['message'] ) ? trim( $row['message'] ) : '',
				'at'      => isset( $row['at'] ) && is_string( $row['at'] ) && '' !== $row['at'] ? $row['at'] : null,
			);
		}
		return $out;
	}

	/**
	 * Put each finding's last attempt on the finding itself.
	 *
	 * Both scans call this (class-clean and class-health), so a finding carries
	 * its record wherever it is rendered — including the robots.txt finding,
	 * which is produced by the health scan and included in the clean one.
	 */
	public static function attach_attempts( &$findings ) {
		$attempts = self::attempts();
		if ( ! $attempts ) {
			return;
		}
		foreach ( $findings as $i => $f ) {
			$id = isset( $f['id'] ) ? (string) $f['id'] : '';
			if ( '' !== $id && isset( $attempts[ $id ] ) ) {
				$findings[ $i ]['last_attempt'] = $attempts[ $id ];
			}
		}
	}

	/**
	 * Record what one run of one fix did — called for EVERY mechanism, success or
	 * refusal, so the panel can say what happened without inventing it.
	 *
	 * A later run replaces the earlier record for the same id (it is the LAST
	 * attempt, not a history): a fix that starts working must stop being shown as
	 * refused.
	 */
	private static function record_attempt( $id, $result ) {
		if ( ! is_string( $id ) || '' === $id || ! is_array( $result ) ) {
			return;
		}
		// `done` has to be earned by all three: the site said it worked, it was
		// not rolled back, and the site did not report a failure. Anything else —
		// including a shape we do not recognise — is a refusal.
		$done = ! empty( $result['ok'] )
			&& empty( $result['restored'] )
			&& ( ! array_key_exists( 'verified', $result ) || false !== $result['verified'] )
			&& empty( $result['error'] );

		$message = '';
		// For a refusal the REASON is the useful sentence; for a success it is
		// what the site says it did. Both fall back, so a shape that carries
		// only one of them still gets a sentence.
		$preferred = $done ? array( 'did', 'note', 'error' ) : array( 'error', 'note', 'did' );
		foreach ( $preferred as $key ) {
			if ( isset( $result[ $key ] ) && is_string( $result[ $key ] ) && '' !== trim( $result[ $key ] ) ) {
				$message = trim( $result[ $key ] );
				break;
			}
		}

		$all = self::attempts();
		$all[ $id ] = array(
			'outcome' => $done ? 'done' : 'refused',
			'code'    => isset( $result['code'] ) && is_string( $result['code'] ) && '' !== $result['code'] ? $result['code'] : null,
			'message' => $message,
			'at'      => gmdate( 'c' ),
		);

		// Capped, newest kept: one option cannot grow without bound because a
		// site keeps trying. ISO-8601 UTC sorts lexicographically, which is why
		// the timestamp is stored in that shape.
		if ( count( $all ) > self::MAX_ATTEMPTS ) {
			uasort( $all, function ( $a, $b ) {
				return strcmp( (string) $b['at'], (string) $a['at'] );
			} );
			$all = array_slice( $all, 0, self::MAX_ATTEMPTS, true );
		}

		update_option( self::ATTEMPTS_OPTION, $all, false );
	}

	// ── Doing it ────────────────────────────────────────────────────────────

	/**
	 * Run one fix. Returns array( 'ok', 'id', 'did', 'verified', 'restored', 'error' ).
	 *
	 * Nothing here is attempted without a backup where a backup is meaningful, and
	 * every action is verified afterwards. A verification failure puts the old
	 * state back.
	 *
	 * The caller names a FINDING, never a path: every mechanism decides for itself
	 * what it may touch, from an allow-list in this file. That is what stops a
	 * leaked widget token turning this route into arbitrary file moves on a
	 * customer's site.
	 */
	public static function apply( $id, $proposal = null ) {
		$entry = self::for_id( $id );
		if ( ! $entry ) {
			return array( 'ok' => false, 'id' => $id, 'error' => 'Morpheus has no fix registered for "' . $id . '". Nothing was changed.', 'code' => 'NO_FIX' );
		}
		// A PROPOSAL means the operator pressed a button that says what will happen,
		// after seeing the exact change. It goes through its own validated path and is
		// recorded like every other attempt — including its refusals.
		if ( null !== $proposal ) {
			$proposed = self::apply_ai( $id, $proposal );
			self::record_attempt( $id, $proposed );
			return $proposed;
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
				$result = self::fix_wp_config_define( $id, $entry['args']['name'], $entry['args']['value'] );
				break;
			case 'relocate_debug_log':
				$result = self::fix_relocate_debug_log( $id );
				break;
			case 'set_option':
				$result = self::fix_set_option( $id, $entry['args']['name'], $entry['args']['value'] );
				break;
			case 'make_backup_dir':
				$result = self::fix_make_backup_dir( $id );
				break;
			case 'spawn_cron':
				$result = self::fix_spawn_cron( $id );
				break;
			case 'quarantine_robots_txt':
				$result = self::fix_quarantine_robots_txt( $id );
				break;
			case 'quarantine_uploads_php':
				$result = self::fix_quarantine_uploads_php( $id );
				break;
			case 'quarantine_root_config_backups':
				$result = self::fix_quarantine_root_config_backups( $id );
				break;
			case 'quarantine_public_debug_log':
				$result = self::fix_quarantine_public_debug_log( $id );
				break;
			default:
				$result = array( 'ok' => false, 'id' => $id, 'code' => 'NO_MECHANISM', 'error' => 'The registry names a mechanism that does not exist. Nothing was changed.' );
		}

		// EVERY mechanism records its last attempt, including the refusals. A
		// refusal that leaves no trace is indistinguishable from a broken button
		// to the person who pressed it — the panel rescans, the count is
		// unchanged, and nothing says why.
		self::record_attempt( $id, $result );
		return $result;
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

	/**
	 * Move the error log out of the web root, and point WordPress at the new path.
	 *
	 * WHY NOT fix_wp_config_define(): that one ADDS a define when it is absent. This
	 * one has to CHANGE an existing one — every site that has ever been debugged
	 * already has `define( 'WP_DEBUG_LOG', true )` — and PHP will not let a constant
	 * be defined twice, so an added line would be dead code that looks like a fix.
	 *
	 * The ORDER is the safety story, and it is why this is not a one-liner:
	 *   1. prove where the file may go, BEFORE touching anything;
	 *   2. refuse if the destination already exists, so nothing is overwritten;
	 *   3. back wp-config.php up, rewrite the one line, read it back;
	 *   4. only then move the log — and put BOTH back if either half fails.
	 * Nothing here deletes: the log keeps every line it had, and the config is
	 * restorable in one step from the backup the maintenance screen already lists.
	 */
	private static function fix_relocate_debug_log( $id ) {
		$file = morpheus_debug_log_file();
		if ( null === morpheus_debug_log_url( $file ) ) {
			return array( 'ok' => true, 'id' => $id, 'did' => 'already outside the web root', 'verified' => true, 'restored' => false, 'error' => null );
		}

		$target = self::debug_log_target();
		if ( isset( $target['error'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => $target['code'], 'error' => $target['error'] );
		}
		$dest = $target['file'];

		// Refuse BEFORE touching wp-config. A half-applied change that points the
		// constant at a file we then refuse to write is worse than no change at all:
		// WordPress would log to a path that does not exist and the old file would
		// still be reachable.
		if ( file_exists( $dest ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'TARGET_EXISTS', 'error' => 'There is already a file at ' . $dest . ', and Morpheus will not overwrite it. Move or rename that file, then check again. Nothing was changed.' );
		}

		$config = self::wp_config_path();
		if ( ! $config ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_WP_CONFIG', 'error' => 'Morpheus cannot find wp-config.php to edit. Nothing was changed.' );
		}
		$original = @file_get_contents( $config );
		if ( false === $original ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'UNREADABLE', 'error' => 'wp-config.php could not be read. Nothing was changed.' );
		}

		$rewritten = self::wp_config_set_define( $original, 'WP_DEBUG_LOG', "'" . $dest . "'" );
		if ( isset( $rewritten['error'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => $rewritten['code'], 'error' => $rewritten['error'] );
		}

		$backup = self::backup_file( $config );
		if ( is_wp_error( $backup ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_BACKUP', 'error' => 'No backup of wp-config.php could be taken, so Morpheus did not touch it: ' . $backup->get_error_message() );
		}

		if ( ! self::write_atomic( $config, $rewritten['body'] ) ) {
			self::restore_file_backup( $backup, $config );
			return array( 'ok' => false, 'id' => $id, 'code' => 'WRITE_FAILED', 'error' => 'wp-config.php could not be written; the original was put back. Nothing was changed.' );
		}

		if ( ! self::wp_config_value_is( $config, 'WP_DEBUG_LOG', $dest ) ) {
			self::restore_file_backup( $backup, $config );
			return array( 'ok' => true, 'id' => $id, 'did' => 'attempted', 'verified' => false, 'restored' => true, 'error' => 'The WP_DEBUG_LOG line did not read back as the new path, so wp-config.php was restored from the backup. Nothing was changed.' );
		}

		// Half two: the log itself. Renamed, never deleted — and if it will not move,
		// the config goes back, because a config pointing at a file that is not there
		// is a worse state than either half alone.
		$moved = true;
		if ( is_file( $file ) ) {
			$moved = @rename( $file, $dest );
			if ( $moved ) {
				$moved = ( ! file_exists( $file ) && file_exists( $dest ) );
			}
		}
		if ( ! $moved ) {
			self::restore_file_backup( $backup, $config );
			return array( 'ok' => true, 'id' => $id, 'did' => 'attempted', 'verified' => false, 'restored' => true, 'error' => 'The log file could not be moved to ' . $dest . ', so wp-config.php was restored from the backup. Nothing was changed.' );
		}

		return array(
			'ok'       => true,
			'id'       => $id,
			'did'      => is_file( $dest )
				? 'moved the error log to ' . $dest . ' and pointed WP_DEBUG_LOG at it'
				: 'pointed WP_DEBUG_LOG at ' . $dest . ' — there was no log file to move yet',
			'verified' => true,
			'restored' => false,
			'error'    => null,
		);
	}

	/**
	 * Where the log may go: beside the site, PROVEN to be outside the web root.
	 *
	 * "Beside" is `dirname(ABSPATH)` — the account directory on shared hosting, with
	 * the site in `public_html/` under it. Being outside WordPress's own tree is NOT
	 * the same as being outside the web root: a site can live at
	 * `public_html/blog/`, and then the WordPress root's parent is still served. So
	 * the destination is accepted only when the server says where its document root
	 * is AND the destination is genuinely outside it. When that cannot be proven,
	 * Morpheus refuses: putting a log somewhere it might still be readable is a fix
	 * that changes nothing while looking like one that worked.
	 */
	private static function debug_log_target() {
		$parent = dirname( rtrim( wp_normalize_path( ABSPATH ), '/' ) );
		// Only "is there somewhere to write" is decided here. The filesystem root is
		// NOT refused on principle: a WordPress installed at `/` (containers, some
		// one-click images) still deserves a log outside its own tree, and the
		// containment test below is the real gate — `/` fails it when it is the
		// document root, which is the only case where writing there would be useless.
		if ( ! is_dir( $parent ) || ! is_writable( $parent ) ) {
			return array(
				'code'  => 'NO_TARGET',
				'error' => 'Morpheus could not find a writable directory beside ' . ABSPATH . ' to put the log in, so nothing was changed — the log is still where it was.',
			);
		}

		// Present-but-empty counts as unknown, not as `/`: the WordPress Playground
		// sets DOCUMENT_ROOT to the empty string, and `realpath( '' )` is documented
		// to return false but has returned the working directory in the wild. A guard
		// whose answer depends on which PHP a host runs is not a guard.
		$docroot_raw = isset( $_SERVER['DOCUMENT_ROOT'] ) ? (string) $_SERVER['DOCUMENT_ROOT'] : '';
		$docroot     = ( '' !== $docroot_raw ) ? realpath( $docroot_raw ) : false;
		$real        = realpath( $parent );
		if ( false === $docroot || false === $real ) {
			return array(
				'code'  => 'UNPROVEN_TARGET',
				'error' => 'Morpheus could not confirm that ' . $parent . ' is outside the web root — the server did not say where its document root is. It will not move a log somewhere it cannot prove is unreachable, so nothing was changed.',
			);
		}

		$docroot = rtrim( wp_normalize_path( $docroot ), '/' );
		$real    = wp_normalize_path( $real );
		if ( $real === $docroot || 0 === strpos( $real . '/', $docroot . '/' ) ) {
			return array(
				'code'  => 'TARGET_IN_WEB_ROOT',
				'error' => $real . ' is still inside the web root (' . $docroot . '), so moving the log there would change nothing. Nothing was changed.',
			);
		}

		return array( 'file' => rtrim( $real, '/' ) . '/morpheus-debug.log' );
	}

	/**
	 * Rewrite ONE existing define() in wp-config.php, or refuse.
	 *
	 * Pure: takes the file's text and returns the new text, so the rule can be
	 * exercised without a WordPress boot. It REFUSES rather than guesses when the
	 * line is not there (it may be set from a file Morpheus cannot see, or by the
	 * host) and when it appears more than once (PHP would use the first, and
	 * rewriting the wrong one silently changes a config that was not the subject).
	 *
	 * PUBLIC and pure for the same reason `Morpheus_Clean::served_is_the_file()` is:
	 * the harness has to be able to call the rule directly. Testing it only through a
	 * boot would leave the two refusals — the ones that decide whether Morpheus edits a
	 * live config at all — reachable only on a site that happens to have two
	 * WP_DEBUG_LOG lines.
	 */
	public static function wp_config_set_define( $body, $name, $value ) {
		$pattern = '/define\s*\(\s*([\'"])' . preg_quote( $name, '/' ) . '\1\s*,\s*[^;]*?\s*\)\s*;/i';
		$count   = preg_match_all( $pattern, $body );

		if ( 0 === $count ) {
			return array(
				'code'  => 'NO_DEFINE',
				'error' => 'Morpheus could not find a define( \'' . $name . '\' ) line in wp-config.php — it may be set from another file, or by your host. It will not guess at a config line, so nothing was changed.',
			);
		}
		if ( $count > 1 ) {
			return array(
				'code'  => 'AMBIGUOUS_DEFINE',
				'error' => 'wp-config.php mentions ' . $name . ' more than once, and PHP would use whichever comes first. Morpheus will not choose for you, so nothing was changed.',
			);
		}

		$line      = "define( '" . $name . "', " . $value . ' );';
		$rewritten = preg_replace_callback( $pattern, function () use ( $line ) {
			// A callback, not a replacement string: a path is data, and in a
			// replacement string `$1` or a backslash in someone's directory name
			// would be read as a backreference.
			return $line;
		}, $body, 1 );

		if ( ! is_string( $rewritten ) || $rewritten === $body ) {
			return array( 'code' => 'NO_CHANGE', 'error' => 'Morpheus could not rewrite the ' . $name . ' line in wp-config.php. Nothing was changed.' );
		}
		return array( 'body' => $rewritten );
	}

	/** Does wp-config.php now set $name to the string $value? Read back from the FILE. */
	private static function wp_config_value_is( $file, $name, $value ) {
		$body = @file_get_contents( $file );
		if ( ! is_string( $body ) ) {
			return false;
		}
		$pattern = '/define\s*\(\s*([\'"])' . preg_quote( $name, '/' ) . '\1\s*,\s*([\'"])(.*?)\2\s*\)\s*;/i';
		if ( ! preg_match( $pattern, $body, $m ) ) {
			return false;
		}
		return trim( $m[3] ) === $value;
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

	// ── CLEAN MY SITE: quarantining the files that have no business being there ──
	//
	// WHY ALL THREE ARE THE SAME MECHANISM
	//
	// A PHP file under uploads/, a wp-config backup in the site root and a public
	// debug.log are three versions of one problem: a file that is reachable when
	// it should not be. One implementation means one undo contract, one
	// verification step and one place to get the path safety right — and the
	// operator sees the same sentence shape whichever one they press.
	//
	// WHAT MAKES IT SAFE
	//
	//   * the TARGET is chosen here, never sent by the caller: the app sends a
	//     finding id and nothing else, and each fix re-enumerates what to move
	//     from the plugin's own allow-list, at the moment it runs (the scan is
	//     cached; a file may be gone or new);
	//   * a RENAME, never a delete — and the new name is on screen;
	//   * the move is verified twice: the backup must be byte-identical to what
	//     was there and the original path must be empty, and for a file that was
	//     being SERVED the URL is requested again and must stop returning it;
	//   * anything that does not verify goes straight back, and the answer says
	//     so rather than reporting a success it did not get.

	/**
	 * Quarantine the executable PHP files under uploads/.
	 *
	 * Re-asks the question rather than trusting the scan: `uploads_php_files()`
	 * is the same enumeration the scan used, run now.
	 */
	private static function fix_quarantine_uploads_php( $id ) {
		if ( ! class_exists( 'Morpheus_Clean' ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_SCANNER', 'error' => 'This build of the Morpheus plugin has no clean scanner, so Morpheus cannot confirm which files to move. Nothing was changed.' );
		}
		$found = Morpheus_Clean::uploads_php_files();
		if ( ! $found['files'] ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_FILE', 'error' => 'There is no PHP file under ' . $found['base'] . ' any more — something removed it since the scan. Nothing was changed; re-scan the site.' );
		}

		$quarantined = array();
		$refused     = array();
		foreach ( $found['files'] as $file ) {
			// A PHP file in the media library is not meant to be *served*, it is
			// meant to be *executed*, so there is no URL to re-request. The move
			// is still verified on disk: the backup exists, byte for byte, and
			// the original path is empty.
			$r = self::quarantine_file( $file, null );
			if ( ! empty( $r['moved'] ) && empty( $r['restored'] ) ) {
				$quarantined[] = $r;
			} else {
				$refused[] = array( 'file' => self::display_path( $file ), 'why' => $r['error'] );
			}
		}
		return self::quarantine_result( $id, $quarantined, $refused, 'No PHP file under uploads/ could be moved' );
	}

	/** Move the wp-config/.env copies out of the site root. */
	private static function fix_quarantine_root_config_backups( $id ) {
		if ( ! class_exists( 'Morpheus_Clean' ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_SCANNER', 'error' => 'This build of the Morpheus plugin has no clean scanner, so Morpheus cannot confirm which files to move. Nothing was changed.' );
		}
		$found = Morpheus_Clean::root_config_backup_files();
		if ( ! $found ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_FILE', 'error' => 'There is no wp-config or .env backup in the site root any more — something removed it since the scan. Nothing was changed; re-scan the site.' );
		}

		$quarantined = array();
		$refused     = array();
		foreach ( $found as $f ) {
			// The whole point is the URL: a `.bak` is served as plain text, so
			// this one is verified by asking for it again.
			$r = self::quarantine_file( $f['path'], $f['url'] );
			if ( ! empty( $r['moved'] ) && empty( $r['restored'] ) ) {
				$quarantined[] = $r;
			} else {
				$refused[] = array( 'file' => $f['name'], 'why' => $r['error'] );
			}
		}
		return self::quarantine_result( $id, $quarantined, $refused, 'No config backup could be moved out of the web root' );
	}

	/** Quarantine a wp-content/debug.log that the URL is actually serving. */
	private static function fix_quarantine_public_debug_log( $id ) {
		if ( ! class_exists( 'Morpheus_Clean' ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_SCANNER', 'error' => 'This build of the Morpheus plugin has no clean scanner, so Morpheus cannot confirm whether the log is being served. Nothing was changed.' );
		}

		// THE SAME QUESTION THE SCAN ASKED, asked again now — not a second rule.
		// The owner's false positive came from a scan that decided "readable" one
		// way and a fix that decided it another; one function answers both, so
		// they cannot disagree. `debug_log_state()` fetches the URL and compares
		// its bytes with the bytes on disk; the scan is cached, so the file may
		// have changed since.
		$state = Morpheus_Clean::debug_log_state();
		if ( null === $state ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'UNKNOWN', 'error' => 'Morpheus could not get an answer from ' . content_url( 'debug.log' ) . ', so it could not confirm that the log is being served and did not move anything. Nothing was changed.' );
		}
		if ( empty( $state['exists'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NO_FILE', 'error' => 'There is no wp-content/debug.log any more — something removed it since the scan. Nothing was changed; re-scan the site.' );
		}
		if ( empty( $state['served'] ) ) {
			return array( 'ok' => false, 'id' => $id, 'code' => 'NOT_SERVED', 'error' => 'The debug log is not being served at ' . $state['url'] . ' — the host answers with something that is not this file. Moving it would change nothing, so Morpheus did not. Nothing was changed.' );
		}

		$file = $state['file'];
		$r    = self::quarantine_file( $file, $state['url'] );
		$quarantined = ( ! empty( $r['moved'] ) && empty( $r['restored'] ) ) ? array( $r ) : array();
		$refused     = $quarantined ? array() : array( array( 'file' => 'wp-content/debug.log', 'why' => $r['error'] ) );
		$result      = self::quarantine_result( $id, $quarantined, $refused, 'The public debug log could not be quarantined' );
		if ( $quarantined ) {
			$result['note'] = 'WordPress creates a fresh wp-content/debug.log on the next warning, so this file will come back until WP_DEBUG_LOG is switched off or pointed outside the web root. The finding above carries the two lines that do that.';
		}
		return $result;
	}

	/**
	 * Move ONE file out of harm's way, verify it, and put it back if it did not
	 * take.
	 *
	 * @param string      $file absolute path
	 * @param string|null $url  the URL it is served at, or null when it is not
	 *                          meant to be served at all
	 * @return array {moved, verified, restored, file, backup, error}
	 */
	private static function quarantine_file( $file, $url = null ) {
		if ( ! is_file( $file ) ) {
			return array( 'moved' => false, 'verified' => false, 'restored' => false, 'file' => $file, 'backup' => null, 'error' => 'the file is no longer there' );
		}
		$before = @file_get_contents( $file );
		if ( ! is_string( $before ) ) {
			return array( 'moved' => false, 'verified' => false, 'restored' => false, 'file' => $file, 'backup' => null, 'error' => 'the file could not be read, so Morpheus did not move it' );
		}
		$digest = md5( $before );

		$target = self::quarantine_target( $file );
		if ( is_wp_error( $target ) ) {
			return array( 'moved' => false, 'verified' => false, 'restored' => false, 'file' => $file, 'backup' => null, 'error' => $target->get_error_message() );
		}
		$dest = $target['path'];
		if ( file_exists( $dest ) ) {
			return array( 'moved' => false, 'verified' => false, 'restored' => false, 'file' => $file, 'backup' => $dest, 'error' => 'a backup from this same second already exists at ' . $dest . ', and Morpheus will not overwrite the only copy of the original' );
		}
		if ( ! @rename( $file, $dest ) ) {
			return array( 'moved' => false, 'verified' => false, 'restored' => false, 'file' => $file, 'backup' => $dest, 'error' => 'this host does not let PHP rename ' . self::display_path( $file ) . ' — the hosting account or the host has to move it by hand' );
		}

		/** Put the file back where it was, and say whether that worked. */
		$give_back = function ( $why ) use ( $dest, $file ) {
			$put_back = @rename( $dest, $file );
			return array(
				'moved'    => false,
				'verified' => false,
				'restored' => (bool) $put_back,
				'file'     => $file,
				'backup'   => $dest,
				'error'    => $why . ( $put_back ? ' The file was renamed straight back, so the site is exactly as it was.' : ' Morpheus could NOT put the file back — it is still at ' . $dest . '.' ),
			);
		};

		// Verification 1, on disk: the backup holds exactly what was there, and
		// the original path is empty. This is the move itself, checked.
		$intact = is_file( $dest ) && md5_file( $dest ) === $digest;
		if ( ! $intact || is_file( $file ) ) {
			return $give_back( 'the move did not verify.' );
		}

		// Verification 2, over HTTP, for a file that was being SERVED. Two
		// questions, and the second is the one a rename alone cannot answer:
		//   1. has the URL the finding named stopped handing the file out?
		//   2. is the backup itself reachable, now that it has a different name?
		// A quarantine that leaves the same bytes readable under a longer name is
		// not a quarantine, so (2) failing is a refusal — and so is (2) being
		// unanswerable when the backup sits inside the web root.
		$served = null;
		if ( is_string( $url ) && '' !== $url ) {
			morpheus_purge_caches();

			$original = self::probe_serves( $url, $digest );
			if ( 'same' === $original ) {
				return $give_back( 'the file was moved but ' . $url . ' still returns its contents, so the move did not stop it being served.' );
			}
			$served = 'different' === $original ? false : null;

			if ( ! empty( $target['url'] ) ) {
				$backup_probe = self::probe_serves( $target['url'], $digest );
				if ( 'same' === $backup_probe ) {
					return $give_back( 'the backup would be just as readable at ' . $target['url'] . ', so renaming the file would not have closed the leak.' );
				}
				if ( 'unreachable' === $backup_probe ) {
					return $give_back( 'Morpheus could not confirm that ' . $target['url'] . ' stops handing the file out, and the backup sits inside the folder the site serves — so it did not leave a readable copy behind under a new name.' );
				}
			}
		}

		return array(
			'moved'    => true,
			// A move with no URL to re-request is verified by the disk check
			// alone; `served` records what the HTTP re-check found, including
			// "could not ask", so the panel never implies more than was seen.
			'verified' => true,
			'restored' => false,
			'served'   => $served,
			'url'      => ( is_string( $url ) && '' !== $url ) ? $url : null,
			'file'     => $file,
			'backup'   => $dest,
			'outside'  => ! empty( $target['outside'] ),
			'error'    => null,
		);
	}

	/**
	 * The one answer shape every quarantine fix returns.
	 *
	 * Kept in one place so `quarantined`, `refused`, `moved` and `verified` mean
	 * the same thing whichever fix produced them — the app reads `quarantined`
	 * to name the undo, and a shape that drifts per fix would silently drop it.
	 */
	private static function quarantine_result( $id, $quarantined, $refused, $nothing_moved_error ) {
		if ( ! $quarantined ) {
			return array(
				'ok'        => false,
				'id'        => $id,
				'code'      => 'NOT_MOVED',
				'error'     => $nothing_moved_error . ': ' . ( $refused ? $refused[0]['why'] : 'the site did not say why' ) . '. Nothing was changed.',
				'refused'   => $refused,
				'restored'  => false,
			);
		}

		$rows = array();
		foreach ( $quarantined as $q ) {
			$rows[] = array(
				'file'     => self::display_path( $q['file'] ),
				'backup'   => $q['backup'],
				'verified' => true,
				'restored' => false,
				// null = the URL could not be re-requested, so the operator is not
				// told the leak was confirmed closed when it was only moved.
				'served'   => array_key_exists( 'served', $q ) ? $q['served'] : null,
				'url'      => array_key_exists( 'url', $q ) ? $q['url'] : null,
			);
		}
		$count = count( $rows );
		$note  = null;
		foreach ( $rows as $r ) {
			if ( $r['url'] && null === $r['served'] ) {
				$note = 'The file is gone from its original path and the backup is byte-identical — but this scan could not re-request the URL afterwards, so whether it has stopped being served is unconfirmed.';
				break;
			}
		}
		if ( $refused ) {
			$note = trim( (string) $note . ' ' . count( $refused ) . ' file(s) could not be moved: ' . $refused[0]['why'] . '.' );
		}

		return array(
			'ok'          => true,
			'id'          => $id,
			'code'        => 'QUARANTINED',
			'did'         => 'renamed ' . $count . ' file' . ( 1 === $count ? '' : 's' ) . ' with a timestamp — nothing was deleted',
			'quarantined' => $rows,
			'refused'     => $refused,
			'verified'    => true,
			'restored'    => false,
			'error'       => null,
			'note'        => $note ?: null,
		);
	}

	/**
	 * Where a quarantined file goes: OUT of the web root when the host allows it,
	 * otherwise into this plugin's own protected state directory.
	 *
	 * WHY OUTSIDE FIRST: a rename inside the web root does not stop a `.bak`
	 * being served — the new name is still a plain file under the document root.
	 * Moving it one level above the WordPress installation takes it out of what
	 * the server hands out, on the ordinary shared-hosting layout where the
	 * WordPress directory IS the document root.
	 *
	 * WHY THE FALLBACK IS SAFE TO TRY: `morpheus-state` already exists, already
	 * carries a Deny-from-all rule written at activation, and is on the deploy
	 * deny-list — so a deploy can never touch it. It is not guaranteed to be
	 * unreachable (a server that ignores .htaccess will still hand the file out),
	 * which is exactly why the URL is re-requested afterwards and the file goes
	 * back if it is still served.
	 *
	 * @return string|WP_Error
	 */
	private static function quarantine_target( $file ) {
		$name   = basename( $file ) . '.morpheus-bak-' . gmdate( 'YmdHis' );
		$parent = dirname( rtrim( str_replace( '\\', '/', ABSPATH ), '/' ) );

		// (1) A directory beside the installation. On the ordinary shared-hosting
		// layout the WordPress directory IS the document root, so its parent is
		// not served at all — the strongest place a backup can be, and the answer
		// for a credential copy.
		//
		// The filesystem root is excluded on purpose: it is not the site's to
		// write, it is shared on many hosts, and a credential file dropped there
		// is not obviously recoverable by the owner.
		if ( '' !== $parent && '/' !== $parent && is_dir( $parent ) && is_writable( $parent ) ) {
			return array( 'path' => rtrim( $parent, '/' ) . '/' . $name, 'url' => null, 'outside' => true );
		}

		// (2) This plugin's own state directory, which already carries a
		// Deny-from-all rule and is on the deploy deny-list. Inside the web root,
		// so it comes with a URL — and a file that was being SERVED is only
		// quarantined here if that URL can be shown not to hand the file out.
		// Without that check this would be a rename that left a .bak just as
		// readable under a longer name.
		$dir = trailingslashit( MORPHEUS_STATE_DIR ) . 'quarantine';
		if ( ! wp_mkdir_p( $dir ) || ! is_writable( $dir ) ) {
			return new WP_Error(
				'morpheus_no_quarantine_target',
				'there is nowhere Morpheus may put the file: the directory above the site is not writable and neither is ' . $dir
			);
		}
		@file_put_contents( $dir . '/.htaccess', "Require all denied\n<IfModule !mod_authz_core.c>\nDeny from all\n</IfModule>\n" );
		@file_put_contents( $dir . '/index.php', "<?php // Silence is golden.\n" );
		return array(
			'path'    => trailingslashit( $dir ) . $name,
			'url'     => trailingslashit( WP_CONTENT_URL ) . 'morpheus-state/quarantine/' . rawurlencode( $name ),
			'outside' => false,
		);
	}

	/**
	 * Ask a URL what it hands out, and classify the answer.
	 *
	 *   'same'        — the exact bytes of the file are being served
	 *   'different'   — the URL answered with something else (a 404 page, a 403)
	 *   'unreachable' — the site could not be asked at all
	 *
	 * The third is a real state, not a failure of the move: a host that blocks
	 * loopback requests can never confirm this, and pretending otherwise either
	 * way would be a guess.
	 */
	private static function probe_serves( $url, $digest ) {
		$body = self::fetch_public( add_query_arg( 'morpheus-verify', time(), $url ) );
		if ( null === $body ) {
			return 'unreachable';
		}
		return md5( $body ) === $digest ? 'same' : 'different';
	}

	/** A path as the operator sees it: relative to the site root when it is under it. */
	private static function display_path( $path ) {
		$base = trailingslashit( str_replace( '\\', '/', ABSPATH ) );
		$p    = str_replace( '\\', '/', (string) $path );
		return 0 === strpos( $p, $base ) ? substr( $p, strlen( $base ) ) : $p;
	}

	/** GET a URL's body, or null when the site could not be asked at all. */
	private static function fetch_public( $url ) {
		$res = wp_remote_get( $url, array( 'timeout' => 8, 'redirection' => 3 ) );
		if ( is_wp_error( $res ) ) {
			return null;
		}
		return wp_remote_retrieve_body( $res );
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
