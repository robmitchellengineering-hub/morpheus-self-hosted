<?php
/**
 * Maintenance executor — every update reversible, or refused.
 *
 * THE CONTRACT THIS CLASS KEEPS
 *
 * A server that has already decided WHAT may be updated calls this. What it is
 * really asking is not "update these plugins" but "update these plugins if you
 * can undo it". So each target is snapshotted BEFORE it is touched, the result
 * is verified against the version WordPress itself offered, and a target that
 * fails either step is restored from that snapshot. A target that cannot be
 * snapshotted is never updated at all — no backup, no update. That sentence is
 * the whole point of the class; everything else here exists to make it true.
 *
 * WHY IT REFUSES RATHER THAN IMPROVISES
 *
 *   - no ZipArchive          the backup cannot be taken, so nothing is touched
 *   - unwritable backup dir  same
 *   - more than MAX_TARGETS  one bad release should not be able to cascade
 *   - host cannot write      WordPress's own filesystem method is not "direct"
 *   - a major core bump      plan() puts it in `refused` and never in `targets`
 *   - an id that escapes     $id arrives over the network; it is resolved with
 *                            realpath() and must stay inside its root
 *
 * CORE IS DIFFERENT, DELIBERATELY
 *
 * WordPress core keeps its own temporary backup (wp-content/upgrade-temp-backup)
 * and Core_Upgrader rolls back from it. Morpheus does not zip wp-admin and
 * wp-includes itself. Instead it requires that WordPress's OWN Site Health test
 * for that directory reports "good", and refuses the core update if it does
 * not. That verdict is read out of Morpheus_Health's scan rather than
 * reimplemented, so there is one answer to the question, not two.
 *
 * A MAJOR CORE UPDATE IS A PERSON'S DECISION
 *
 * plan() lists a core offer whose MAJOR version differs from the installed one
 * under `refused`, with a reason. Nothing in this class can apply one.
 *
 * A FAILED RESTORE IS LOUD, AND STOPS THE RUN
 *
 * If a snapshot cannot be restored the site may be in a state nobody chose, so
 * the per-target error says so in those words and the remaining targets are
 * marked "not attempted". Writing more files after that would be the one thing
 * worse than the failed restore itself.
 *
 * SNAPSHOTS ARE NOT LISTABLE OR DOWNLOADABLE
 *
 * They live in wp-content/uploads/morpheus-backups (uploads is where WordPress
 * can be relied on to have a writable directory), with an index.php and an
 * .htaccess denying everything. On nginx the .htaccess is inert — hence both,
 * and hence nothing here ever returns a URL for a snapshot.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Maintenance {

	const BACKUP_DIRNAME   = 'morpheus-backups';
	const MAX_BACKUP_BYTES = 26214400; // 25 MB per target — refuse rather than half-zip
	const MAX_TARGETS      = 25;

	// ── Planning (READ-ONLY) ────────────────────────────────────────────────

	/**
	 * What could be updated, and what Morpheus will not touch.
	 *
	 * Read-only by contract: it writes no file and creates no directory. The one
	 * write anywhere near it is Morpheus_Health's own short-lived scan cache,
	 * and that is the health scan's business, not this method's. Callers that
	 * need the backup directory's path must not get it from here — plan() is
	 * safe to call on a site nobody has decided to change yet.
	 */
	/**
	 * This plugin, as WordPress identifies it.
	 *
	 * Morpheus must never update itself: the request doing the updating is served
	 * by the code it would replace, so a failure mid-swap could leave the plugin
	 * half-written and the site without the panel that would fix it. WordPress's
	 * own updater already offers this plugin its updates from wp-admin, where a
	 * failure can be reported — so there is nothing to gain and a real way to lose.
	 */
	private static function self_basename() {
		if ( ! function_exists( 'plugin_basename' ) ) {
			require_once ABSPATH . 'wp-admin/includes/plugin.php';
		}
		return plugin_basename( MORPHEUS_DIR . 'morpheus.php' );
	}

	public static function plan() {
		self::admin_includes();

		$host     = self::host();
		$blockers = self::host_blockers( $host );
		if ( ! class_exists( 'ZipArchive' ) ) {
			$blockers[] = "This host's PHP has no zip extension (ZipArchive). Morpheus takes a backup before it changes anything, and without the zip extension it cannot, so it will not update this site. Ask your host to enable the PHP zip extension.";
		}

		$targets = array();
		$refused = array();

		// Plugins and themes: WordPress's own update list is the only source of
		// what is on offer. This class never invents an offer, and never trusts
		// a caller's version numbers (see offer(), used again at update time).
		foreach ( (array) get_plugin_updates() as $file => $p ) {
			$new = isset( $p->update->new_version ) ? (string) $p->update->new_version : '';
			if ( '' === $new ) {
				continue;
			}
			if ( (string) $file === self::self_basename() ) {
				// Reported, never applied — see self_basename(). The offer is real
				// and the owner should take it, from wp-admin rather than here.
				$refused[] = array(
					'kind'        => 'plugin',
					'id'          => (string) $file,
					'name'        => ( isset( $p->Name ) && '' !== (string) $p->Name ) ? (string) $p->Name : 'Morpheus',
					'version'     => isset( $p->Version ) ? (string) $p->Version : '',
					'new_version' => $new,
					'reason'      => 'Morpheus does not update itself. This request is served by the very code the update would replace, so a failure part-way through could leave the plugin half-written — and with it the panel you would use to fix it. Update it from Dashboard → Updates, where WordPress can report a failure and the admin screens stay available.',
				);
				continue;
			}
			$targets[] = array(
				'kind'        => 'plugin',
				'id'          => (string) $file,
				'name'        => ( isset( $p->Name ) && '' !== (string) $p->Name ) ? (string) $p->Name : (string) $file,
				'version'     => isset( $p->Version ) ? (string) $p->Version : '',
				'new_version' => $new,
			);
		}

		if ( function_exists( 'get_theme_updates' ) ) {
			foreach ( (array) get_theme_updates() as $stylesheet => $t ) {
				$new = ( is_object( $t ) && isset( $t->update['new_version'] ) ) ? (string) $t->update['new_version'] : '';
				if ( '' === $new ) {
					continue;
				}
				$name    = ( is_object( $t ) && method_exists( $t, 'get' ) ) ? (string) $t->get( 'Name' ) : '';
				$version = ( is_object( $t ) && method_exists( $t, 'get' ) ) ? (string) $t->get( 'Version' ) : '';
				$targets[] = array(
					'kind'        => 'theme',
					'id'          => (string) $stylesheet,
					'name'        => '' !== $name ? $name : (string) $stylesheet,
					'version'     => $version,
					'new_version' => $new,
				);
			}
		}

		foreach ( (array) get_core_updates() as $c ) {
			if ( ! is_object( $c ) ) {
				continue;
			}
			$installed = isset( $c->current ) ? (string) $c->current : '';
			$offered   = isset( $c->version ) ? (string) $c->version : '';
			$response  = isset( $c->response ) ? (string) $c->response : '';
			// 'latest' means "you are current" — not an update.
			if ( '' === $offered || '' === $response || 'latest' === $response ) {
				continue;
			}

			$from_major = self::major( $installed );
			$to_major   = self::major( $offered );
			if ( $from_major > 0 && $from_major === $to_major ) {
				$targets[] = array(
					'kind'        => 'core_minor',
					'id'          => 'core',
					'name'        => 'WordPress',
					'version'     => $installed,
					'new_version' => $offered,
				);
				continue;
			}

			// A different major version is a decision for a person, always.
			$refused[] = array(
				'kind'        => 'core_major',
				'id'          => 'core',
				'version'     => $installed,
				'new_version' => $offered,
				'reason'      => $from_major < 1 || $to_major < 1
					? 'WordPress is offering core ' . $offered . ' over ' . $installed . ', and Morpheus cannot tell whether that is a major jump from those version numbers. A person should look at it.'
					: 'WordPress ' . $offered . ' is a major release, and this site runs ' . $installed . '. A major release can change or remove things your theme and plugins depend on, so Morpheus will not apply it unattended. Take a full site backup, then run it from Dashboard → Updates.',
			);
		}

		return array(
			'ok'        => true,
			// The host's own verdict, narrowed by the one capability apply()
			// needs on top of it: without ZipArchive there is no backup, and
			// apply() will refuse — so reporting true here would offer an update
			// that is guaranteed to be refused.
			'can_apply' => (bool) ( ! empty( $host['can_update_files'] ) && class_exists( 'ZipArchive' ) ),
			'blockers'  => $blockers,
			'targets'   => $targets,
			'refused'   => $refused,
		);
	}

	// ── Applying ────────────────────────────────────────────────────────────

	/**
	 * Apply the targets, one at a time, each behind its own snapshot.
	 *
	 * Per-target failures are data, not exceptions: `ok` is true when the call
	 * itself ran, and the caller reads `results` for what happened to each
	 * target. The call as a whole is only `ok => false` when it refused before
	 * touching anything.
	 *
	 * @param array $targets array of array( 'kind' => plugin|theme|core_minor, 'id' => '…' )
	 * @param array $opts    array( 'dry_run' => bool )
	 * @return array
	 */
	public static function apply( $targets, $opts = array() ) {
		self::admin_includes();
		$dry = ! empty( $opts['dry_run'] );

		// ── Refusals, all of them before anything is written ────────────────
		if ( ! class_exists( 'ZipArchive' ) ) {
			return self::refuse( 'NO_ZIP', "This host's PHP has no zip extension, so Morpheus cannot take a backup before updating, and it will not update without one. Ask your host to enable the PHP zip extension." );
		}

		$dir      = self::backup_path();
		// A dry run must not create the directory, so when it does not exist yet
		// the question is whether its parent could hold it.
		$writable = is_dir( $dir ) ? wp_is_writable( $dir ) : wp_is_writable( dirname( $dir ) );
		if ( ! $writable ) {
			return self::refuse( 'NO_BACKUP_DIR', 'Morpheus cannot write its backup directory at ' . $dir . ', so it cannot take a backup before updating — and it will not update without one. Nothing was changed. Make that path writable by PHP, or ask your host to.' );
		}

		$targets = is_array( $targets ) ? array_values( $targets ) : array();
		if ( count( $targets ) > self::MAX_TARGETS ) {
			return self::refuse( 'TOO_MANY', 'This request asks for ' . count( $targets ) . ' updates at once. Morpheus applies at most ' . self::MAX_TARGETS . ' at a time, so that one bad release cannot take the whole site down with it. Nothing was changed.' );
		}

		$host = self::host();
		if ( empty( $host['can_update_files'] ) ) {
			$why = self::host_blockers( $host );
			return self::refuse( 'CANNOT_WRITE', 'This site cannot have its files updated by Morpheus: ' . ( $why ? implode( '; ', $why ) : 'WordPress reports that this site cannot write its own plugin and theme files' ) . '. Nothing was changed. On many hosts this is normal — WordPress asks for FTP or SSH credentials instead, and Morpheus will not ask you for those.' );
		}

		foreach ( $targets as $t ) {
			$kind = ( is_array( $t ) && isset( $t['kind'] ) ) ? (string) $t['kind'] : '';
			$id   = ( is_array( $t ) && isset( $t['id'] ) ) ? (string) $t['id'] : '';
			if ( 'plugin' === $kind && $id === self::self_basename() ) {
				return self::refuse( 'SELF_UPDATE', 'Morpheus will not update itself: this request is served by the code the update would replace. Update Morpheus from Dashboard → Updates. Nothing was changed.' );
			}
			if ( ! in_array( $kind, array( 'plugin', 'theme', 'core_minor' ), true ) || '' === $id ) {
				return self::refuse( 'BAD_TARGET', 'Morpheus can only update a plugin, a theme, or a minor WordPress core release. This request asked for "' . ( '' !== $kind ? $kind : '(no kind)' ) . '", which it will not touch.' );
			}
		}

		if ( ! $dry ) {
			$ready = self::ensure_backup_dir();
			if ( is_wp_error( $ready ) ) {
				return self::refuse( 'NO_BACKUP_DIR', $ready->get_error_message() . ' Nothing was changed.' );
			}
		}

		// ── One target at a time. Never a bulk call across kinds. ───────────
		$results = array();
		$stopped = false;
		foreach ( $targets as $t ) {
			if ( $stopped ) {
				$results[] = self::skipped( $t, 'Not attempted: an earlier target in this request could not be restored, so Morpheus stopped rather than write more files onto a site whose state nobody chose.' );
				continue;
			}
			$row = $dry ? self::describe( $t ) : self::apply_one( $t );
			$results[] = $row;
			if ( empty( $row['restored'] ) && self::restore_failed( $row ) ) {
				$stopped = true;
			}
		}

		$updated = 0;
		$failed  = 0;
		$restored = 0;
		foreach ( $results as $row ) {
			if ( ! empty( $row['updated'] ) && ! empty( $row['verified'] ) ) {
				$updated++;
			} else {
				$failed++;
			}
			if ( ! empty( $row['restored'] ) ) {
				$restored++;
			}
		}

		return array(
			'ok'         => true,
			'dry_run'    => (bool) $dry,
			'results'    => $results,
			'updated'    => $updated,
			'failed'     => $failed,
			'restored'   => $restored,
			'backup_dir' => wp_normalize_path( $dir ),
			'stopped'    => $stopped,
		);
	}

	/** The whole-call refusal shape. One refusal, one reason a person can read. */
	private static function refuse( $code, $message ) {
		return array(
			'ok'    => false,
			'error' => $message,
			'code'  => $code,
		);
	}

	/** A target the run never reached, in the same shape as a real result. */
	private static function skipped( $t, $message ) {
		$kind = ( is_array( $t ) && isset( $t['kind'] ) ) ? (string) $t['kind'] : '';
		$id   = ( is_array( $t ) && isset( $t['id'] ) ) ? (string) $t['id'] : '';
		return array(
			'kind'     => $kind,
			'id'       => $id,
			'name'     => $id,
			'from'     => null,
			'to'       => null,
			'updated'  => false,
			'verified' => false,
			'restored' => false,
			'error'    => $message,
		);
	}

	/** Did a restore get attempted and fail? The worst outcome, never silent. */
	private static function restore_failed( $row ) {
		if ( empty( $row['error'] ) || ! is_string( $row['error'] ) ) {
			return false;
		}
		return false !== strpos( $row['error'], 'COULD NOT BE RESTORED' );
	}

	/**
	 * What WOULD happen, writing nothing: the offer re-read from WordPress, the
	 * size of the snapshot that would be taken, and the core temp-backup check.
	 */
	private static function describe( $t ) {
		$kind = (string) $t['kind'];
		$id   = (string) $t['id'];
		$row  = array(
			'kind'     => $kind,
			'id'       => $id,
			'name'     => $id,
			'from'     => null,
			'to'       => null,
			'updated'  => false,
			'verified' => false,
			'restored' => false,
			'error'    => null,
			'detail'   => 'Dry run: nothing was backed up and nothing was written.',
		);

		$offer = self::offer( $kind, $id );
		if ( is_wp_error( $offer ) ) {
			$row['error'] = 'Nothing would be updated: ' . $offer->get_error_message();
			return $row;
		}
		$row['name'] = $offer['name'];
		$row['from'] = $offer['version'];
		$row['to']   = $offer['new_version'];

		if ( 'core_minor' === $kind ) {
			$check = self::temp_backup_status();
			if ( 'good' !== $check['status'] ) {
				$row['error'] = 'Nothing would be updated: ' . self::temp_backup_refusal( $check );
			} else {
				$row['detail'] = 'Dry run: WordPress\'s own temporary backup (' . $check['label'] . ') reports "good"; nothing was written.';
			}
			return $row;
		}

		$resolved = self::resolve_target( $kind, $id, true );
		if ( is_wp_error( $resolved ) ) {
			$row['error'] = 'Nothing would be updated: ' . $resolved->get_error_message();
			return $row;
		}
		$bytes = self::measure( $resolved['target'] );
		if ( $bytes > self::MAX_BACKUP_BYTES ) {
			$row['error'] = 'Nothing would be updated: ' . self::too_big_message( $resolved['target'], $bytes );
			return $row;
		}
		$row['would_backup_bytes'] = $bytes;
		$row['detail']             = 'Dry run: Morpheus would snapshot ' . self::human_size( $bytes ) . ' to ' . self::BACKUP_DIRNAME . ' before updating; nothing was written.';
		return $row;
	}

	/** One target, snapshot first, update second, verify third, restore on doubt. */
	private static function apply_one( $t ) {
		$kind = (string) $t['kind'];
		$id   = (string) $t['id'];
		$row  = array(
			'kind'     => $kind,
			'id'       => $id,
			'name'     => $id,
			'from'     => null,
			'to'       => null,
			'updated'  => false,
			'verified' => false,
			'restored' => false,
			'error'    => null,
		);

		// The offer is read fresh from WordPress at update time: a caller cannot
		// push a version (or a package) in through the request body.
		$offer = self::offer( $kind, $id );
		if ( is_wp_error( $offer ) ) {
			$row['error'] = $offer->get_error_message();
			return $row;
		}
		$row['name'] = $offer['name'];
		$row['from'] = $offer['version'];
		$row['to']   = $offer['new_version'];

		$snapshot = null;
		if ( 'core_minor' === $kind ) {
			// Core has no Morpheus snapshot; WordPress's own temporary backup is
			// the undo. Require WordPress's Site Health verdict on it first.
			$check = self::temp_backup_status();
			if ( 'good' !== $check['status'] ) {
				$row['error'] = self::temp_backup_refusal( $check );
				return $row;
			}
		} else {
			$snapshot = self::snapshot( $kind, $id );
			if ( is_wp_error( $snapshot ) ) {
				$row['error'] = 'No backup could be taken, so this update was NOT applied: ' . $snapshot->get_error_message();
				return $row;
			}
		}

		$active_before = ( 'plugin' === $kind ) ? self::plugin_is_active( $id ) : null;

		$run  = self::run_update( $kind, $id, $offer );
		$err  = null;
		$okay = true;
		if ( is_wp_error( $run ) ) {
			$okay = false;
			$err  = 'WordPress reported the update failed: ' . $run->get_error_message();
		}

		// Verification is the verdict — not the upgrader's own return value.
		$now      = self::installed_version( $kind, $id );
		$verified = ( $okay && '' !== $offer['new_version'] && $now === $offer['new_version'] );
		$row['installed'] = $now;
		if ( ! $verified && null === $err ) {
			$err = 'The update ran but the installed version is still ' . ( '' === $now ? 'unknown' : $now ) . ', not ' . $offer['new_version'] . '.';
		}

		if ( 'plugin' === $kind ) {
			$main = self::plugin_main_file( $id );
			if ( ! file_exists( $main ) ) {
				$verified = false;
				$err      = 'The plugin\'s main file ' . $main . ' does not exist after the update.';
			} elseif ( null !== $active_before && self::plugin_is_active( $id ) !== $active_before ) {
				$verified = false;
				$err      = 'The plugin\'s active state changed during the update (it was ' . ( $active_before ? 'active' : 'inactive' ) . ' before).';
			}
		}

		$row['verified'] = (bool) $verified;
		$row['updated']  = (bool) $verified;

		if ( ! $verified ) {
			if ( null === $snapshot ) {
				// Core: WordPress rolls back from its own temporary backup. Say
				// honestly that Morpheus restored nothing.
				$row['error'] = $err . ' Morpheus has no separate core snapshot, so it restored nothing; WordPress keeps its own temporary backup of core updates in wp-content/upgrade-temp-backup. Check Dashboard → Updates before doing anything else.';
				return $row;
			}
			$restore = self::restore( $kind, $id, $snapshot['file'] );
			if ( is_wp_error( $restore ) ) {
				$row['restored'] = false;
				$row['error']    = 'UPDATE FAILED AND THE BACKUP COULD NOT BE RESTORED — the site may be in a state nobody chose. Update error: ' . $err . ' Restore error: ' . $restore->get_error_message() . ' The backup is still on disk as ' . $snapshot['file'] . '.';
			} else {
				$row['restored'] = true;
				$row['error']    = $err . ' The previous files were restored from ' . $snapshot['file'] . ', so the site is running what it was before.';
			}
		} else {
			$row['error'] = null;
		}

		return $row;
	}

	/**
	 * Run the one upgrader, exactly as wp-admin runs it. Returns true, or a
	 * WP_Error describing what WordPress said. The caller still verifies the
	 * installed version afterwards — this return value is a message, not proof.
	 */
	private static function run_update( $kind, $id, $offer ) {
		$needed = array(
			'wp-admin/includes/file.php',
			'wp-admin/includes/misc.php',
			'wp-admin/includes/plugin.php',
			'wp-admin/includes/class-wp-upgrader.php',
			'wp-admin/includes/class-wp-upgrader-skin.php',
		);
		if ( 'theme' === $kind ) {
			$needed[] = 'wp-admin/includes/class-theme-upgrader.php';
		} elseif ( 'plugin' === $kind ) {
			$needed[] = 'wp-admin/includes/class-plugin-upgrader.php';
		} else {
			$needed[] = 'wp-admin/includes/class-core-upgrader.php';
		}
		foreach ( $needed as $file ) {
			$path = ABSPATH . $file;
			if ( file_exists( $path ) ) {
				require_once $path;
			}
		}

		if ( ! function_exists( 'WP_Filesystem' ) || ! WP_Filesystem() ) {
			return new WP_Error( 'morpheus_no_filesystem', 'WordPress could not initialise its filesystem access, so no files were written.' );
		}

		if ( 'plugin' === $kind ) {
			$upgrader = new Plugin_Upgrader( new Automatic_Upgrader_Skin() );
			return self::upgrade_result( $upgrader->bulk_upgrade( array( $id ) ), $id, 'plugin' );
		}
		if ( 'theme' === $kind ) {
			$upgrader = new Theme_Upgrader( new Automatic_Upgrader_Skin() );
			return self::upgrade_result( $upgrader->bulk_upgrade( array( $id ) ), $id, 'theme' );
		}

		$upgrader = new Core_Upgrader( new Automatic_Upgrader_Skin() );
		$result   = $upgrader->upgrade( $offer['update'] );
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( false === $result ) {
			return new WP_Error( 'morpheus_upgrade_failed', 'WordPress refused the core update and reported no result.' );
		}
		return true;
	}

	/**
	 * bulk_upgrade() returns array( $item => result ), where result is the run
	 * array on success, false on a soft failure, or a WP_Error. All three shapes
	 * are handled; anything unrecognised is reported rather than assumed fine.
	 */
	private static function upgrade_result( $result, $id, $what ) {
		if ( is_wp_error( $result ) ) {
			return $result;
		}
		if ( ! is_array( $result ) ) {
			return new WP_Error( 'morpheus_upgrade_unknown', 'WordPress\'s ' . $what . ' upgrader returned nothing to read for ' . $id . '.' );
		}
		$entry = isset( $result[ $id ] ) ? $result[ $id ] : null;
		if ( null === $entry ) {
			return new WP_Error( 'morpheus_upgrade_unknown', 'WordPress\'s ' . $what . ' upgrader did not report on ' . $id . '.' );
		}
		if ( is_wp_error( $entry ) ) {
			return $entry;
		}
		if ( false === $entry ) {
			return new WP_Error( 'morpheus_upgrade_failed', 'WordPress reported that the ' . $what . ' update of ' . $id . ' failed.' );
		}
		// Some paths wrap the run result one level down.
		if ( is_array( $entry ) && array_key_exists( 'result', $entry ) ) {
			if ( is_wp_error( $entry['result'] ) ) {
				return $entry['result'];
			}
			if ( false === $entry['result'] ) {
				return new WP_Error( 'morpheus_upgrade_failed', 'WordPress reported that the ' . $what . ' update of ' . $id . ' failed.' );
			}
		}
		return true;
	}

	/**
	 * The update WordPress is offering for this exact target, read fresh. A
	 * target with no offer is an error, not an update — this is what stops a
	 * caller talking Morpheus into a downgrade or an arbitrary package.
	 */
	private static function offer( $kind, $id ) {
		self::admin_includes();

		if ( 'plugin' === $kind ) {
			$updates = get_plugin_updates();
			if ( ! is_array( $updates ) || ! isset( $updates[ $id ] ) ) {
				return new WP_Error( 'morpheus_no_update', 'WordPress is not offering an update for the plugin "' . $id . '". It may already be current; nothing was changed.' );
			}
			$p = $updates[ $id ];
			return array(
				'name'        => ( isset( $p->Name ) && '' !== (string) $p->Name ) ? (string) $p->Name : $id,
				'version'     => isset( $p->Version ) ? (string) $p->Version : '',
				'new_version' => isset( $p->update->new_version ) ? (string) $p->update->new_version : '',
				'update'      => $p->update,
			);
		}

		if ( 'theme' === $kind ) {
			$updates = get_theme_updates();
			if ( ! is_array( $updates ) || ! isset( $updates[ $id ] ) ) {
				return new WP_Error( 'morpheus_no_update', 'WordPress is not offering an update for the theme "' . $id . '". It may already be current; nothing was changed.' );
			}
			$t = $updates[ $id ];
			return array(
				'name'        => ( is_object( $t ) && method_exists( $t, 'get' ) && '' !== (string) $t->get( 'Name' ) ) ? (string) $t->get( 'Name' ) : $id,
				'version'     => ( is_object( $t ) && method_exists( $t, 'get' ) ) ? (string) $t->get( 'Version' ) : '',
				'new_version' => isset( $t->update['new_version'] ) ? (string) $t->update['new_version'] : '',
				'update'      => (object) (array) $t->update,
			);
		}

		// core_minor
		$list = get_core_updates();
		if ( ! is_array( $list ) ) {
			return new WP_Error( 'morpheus_no_update', 'WordPress has not checked for a core update yet, so Morpheus has nothing to apply. Try again after Dashboard → Updates has run once.' );
		}
		$installed = self::installed_version( 'core', 'core' );
		$best      = null;
		$major_hit = null;
		foreach ( $list as $c ) {
			if ( ! is_object( $c ) ) {
				continue;
			}
			$offered  = isset( $c->version ) ? (string) $c->version : '';
			$response = isset( $c->response ) ? (string) $c->response : '';
			if ( '' === $offered || '' === $response || 'latest' === $response ) {
				continue;
			}
			$from = isset( $c->current ) ? (string) $c->current : $installed;
			if ( self::major( $offered ) !== self::major( $from ) ) {
				$major_hit = $offered;
				continue;
			}
			$best = $c;
		}
		if ( null === $best ) {
			if ( null !== $major_hit ) {
				return new WP_Error( 'morpheus_major_core', 'The only core update WordPress is offering is ' . $major_hit . ', a major release. Morpheus does not apply major core updates — a person should take a full backup and run it from Dashboard → Updates.' );
			}
			return new WP_Error( 'morpheus_no_update', 'WordPress is not offering a minor core update. Nothing was changed.' );
		}
		return array(
			'name'        => 'WordPress',
			'version'     => isset( $best->current ) ? (string) $best->current : $installed,
			'new_version' => (string) $best->version,
			'update'      => $best,
		);
	}

	// ── Snapshots ───────────────────────────────────────────────────────────

	/**
	 * Zip one target so the update that follows can be undone.
	 *
	 * @param string $kind plugin|theme (core_minor has no Morpheus snapshot)
	 * @param string $id   plugin file ("akismet/akismet.php") or stylesheet
	 * @return array|WP_Error array( 'file', 'path', 'bytes', … )
	 */
	public static function snapshot( $kind, $id ) {
		if ( 'core_minor' === $kind || 'core' === $kind ) {
			return new WP_Error(
				'morpheus_core_backup',
				'Morpheus does not zip WordPress core itself. Core keeps its own temporary backup in wp-content/upgrade-temp-backup and Core_Upgrader rolls back from it; apply() checks WordPress\'s own Site Health verdict on that directory before it updates core.'
			);
		}
		if ( ! class_exists( 'ZipArchive' ) ) {
			return new WP_Error( 'morpheus_no_zip', 'This host\'s PHP has no zip extension (ZipArchive), so Morpheus cannot take a backup. It will not update anything without one.' );
		}

		$target = self::resolve_target( $kind, $id, true );
		if ( is_wp_error( $target ) ) {
			return $target;
		}

		// Measure BEFORE zipping: a half-written archive is worse than a refusal,
		// and a huge tree can be refused without reading all of it.
		$bytes = self::measure( $target['target'] );
		if ( $bytes > self::MAX_BACKUP_BYTES ) {
			return new WP_Error( 'morpheus_backup_too_big', self::too_big_message( $target['target'], $bytes ) );
		}

		$ready = self::ensure_backup_dir();
		if ( is_wp_error( $ready ) ) {
			return $ready;
		}
		$dir  = self::backup_dir();
		$name = self::snapshot_name( $kind, $target['slug'], $target['version'] );
		$path = trailingslashit( $dir ) . $name;

		// One snapshot per target per second at most — but never overwrite an
		// existing archive, which is someone's only way back.
		$suffix = 2;
		while ( file_exists( $path ) ) {
			$name = self::snapshot_name( $kind, $target['slug'], $target['version'], $suffix );
			$path = trailingslashit( $dir ) . $name;
			$suffix++;
		}

		$zip  = new ZipArchive();
		$open = $zip->open( $path, ZipArchive::CREATE | ZipArchive::OVERWRITE );
		if ( true !== $open ) {
			return new WP_Error( 'morpheus_zip_open', 'Morpheus could not create the backup archive at ' . $path . ' (ZipArchive error ' . $open . '), so nothing was updated.' );
		}

		$added = self::zip_add_target( $zip, $target['target'], $target['root'] );
		if ( is_wp_error( $added ) ) {
			$zip->close();
			@unlink( $path );
			return $added;
		}
		if ( ! $zip->close() ) {
			@unlink( $path );
			return new WP_Error( 'morpheus_zip_close', 'Morpheus could not finish writing the backup archive at ' . $path . ', so nothing was updated.' );
		}
		if ( ! file_exists( $path ) || 0 === (int) filesize( $path ) ) {
			@unlink( $path );
			return new WP_Error( 'morpheus_zip_empty', 'The backup archive for "' . $id . '" came out empty, so nothing was updated.' );
		}

		return array(
			'file'    => basename( $path ),
			'path'    => wp_normalize_path( $path ),
			'bytes'   => (int) filesize( $path ),
			'kind'    => $kind,
			'id'      => $id,
			'target'  => $target['target'],
			'created' => gmdate( 'c' ),
		);
	}

	/**
	 * Put a snapshot back over its target. Every path is checked against the
	 * backup directory and the target root before a single byte is written.
	 *
	 * @return true|WP_Error
	 */
	public static function restore( $kind, $id, $file ) {
		if ( ! class_exists( 'ZipArchive' ) ) {
			return new WP_Error( 'morpheus_no_zip', 'This host\'s PHP has no zip extension, so Morpheus cannot read the backup it took.' );
		}
		if ( 'core_minor' === $kind || 'core' === $kind ) {
			return new WP_Error( 'morpheus_core_restore', 'WordPress core has no Morpheus snapshot to restore: core updates are rolled back by WordPress itself from wp-content/upgrade-temp-backup.' );
		}

		$zip_path = self::resolve_backup_file( $file );
		if ( is_wp_error( $zip_path ) ) {
			return $zip_path;
		}
		$target = self::resolve_target( $kind, $id, false );
		if ( is_wp_error( $target ) ) {
			return $target;
		}

		$zip  = new ZipArchive();
		$open = $zip->open( $zip_path );
		if ( true !== $open ) {
			return new WP_Error( 'morpheus_zip_read', 'Morpheus could not open the backup ' . basename( $zip_path ) . ' (ZipArchive error ' . $open . ').' );
		}

		// Every entry must be a plain relative path. The archive was written by
		// us, but it sits in a writable directory, so it is checked like an
		// untrusted input before anything is extracted.
		$expect = $target['file_only'] ? basename( $target['target'] ) : null;
		for ( $i = 0; $i < $zip->numFiles; $i++ ) {
			$entry = $zip->getNameIndex( $i );
			if ( false === $entry || self::entry_escapes( $entry, $expect ) ) {
				$zip->close();
				return new WP_Error( 'morpheus_zip_unsafe', 'The backup ' . basename( $zip_path ) . ' contains an entry Morpheus will not extract (' . ( is_string( $entry ) ? $entry : 'unreadable entry' ) . '), so nothing was restored.' );
			}
		}

		if ( $target['file_only'] ) {
			// A single-file plugin: the "target" is one file inside WP_PLUGIN_DIR.
			// Clear that file, never the directory around it.
			if ( file_exists( $target['target'] ) && ! @unlink( $target['target'] ) ) {
				$zip->close();
				return new WP_Error( 'morpheus_restore_clear', 'Morpheus could not remove the damaged file ' . $target['target'] . ' before restoring it.' );
			}
			$into = dirname( $target['target'] );
		} else {
			if ( ! is_dir( $target['target'] ) && ! wp_mkdir_p( $target['target'] ) ) {
				$zip->close();
				return new WP_Error( 'morpheus_restore_dir', 'Morpheus could not recreate the directory ' . $target['target'] . ' to restore into.' );
			}
			if ( ! self::clear_dir( $target['target'] ) ) {
				$zip->close();
				return new WP_Error( 'morpheus_restore_clear', 'Morpheus could not clear the damaged contents of ' . $target['target'] . ', so it stopped rather than write over them.' );
			}
			$into = $target['target'];
		}

		$ok = $zip->extractTo( $into );
		$zip->close();
		if ( ! $ok ) {
			return new WP_Error( 'morpheus_restore_extract', 'Morpheus could not extract the backup ' . basename( $zip_path ) . ' over ' . $target['target'] . '. The backup is still on disk; the target directory may be incomplete.' );
		}

		if ( $target['file_only'] && ! file_exists( $target['target'] ) ) {
			return new WP_Error( 'morpheus_restore_missing', 'The backup extracted, but ' . $target['target'] . ' is still missing.' );
		}
		if ( ! $target['file_only'] && ! self::has_files( $target['target'] ) ) {
			return new WP_Error( 'morpheus_restore_missing', 'The backup extracted, but ' . $target['target'] . ' is still empty.' );
		}

		return true;
	}

	/**
	 * The snapshots on disk, newest first. Read-only: it never creates the
	 * directory, and never returns a URL, because these are never served.
	 */
	public static function backups() {
		$dir = self::backup_path();
		if ( ! is_dir( $dir ) ) {
			return array();
		}
		$out   = array();
		$files = glob( trailingslashit( $dir ) . '*.zip' );
		foreach ( (array) $files as $file ) {
			if ( ! is_file( $file ) ) {
				continue;
			}
			$mtime = (int) filemtime( $file );
			$out[] = array(
				'name'    => basename( $file ),
				'size'    => (int) filesize( $file ),
				'mtime'   => $mtime,
				'created' => gmdate( 'c', $mtime ),
			);
		}
		usort( $out, array( __CLASS__, 'newest_first' ) );
		return $out;
	}

	/** Delete one snapshot. Same-site path check: basename only, .zip only, inside the backup dir. */
	public static function delete_snapshot( $file ) {
		$path = self::resolve_backup_file( $file );
		if ( is_wp_error( $path ) ) {
			return $path;
		}
		if ( ! @unlink( $path ) ) {
			return new WP_Error( 'morpheus_backup_delete', 'Morpheus could not delete the backup ' . basename( $path ) . '. Delete it over SFTP, or check the directory\'s permissions.' );
		}
		return true;
	}

	private static function newest_first( $a, $b ) {
		if ( $a['mtime'] === $b['mtime'] ) {
			return strcmp( (string) $b['name'], (string) $a['name'] );
		}
		return ( $b['mtime'] > $a['mtime'] ) ? 1 : -1;
	}

	// ── Paths ───────────────────────────────────────────────────────────────

	/**
	 * The backup directory, created and protected. Returns the path even when
	 * creation failed — callers that need it to have worked must check with
	 * ensure_backup_dir() or test wp_is_writable() on the result.
	 */
	public static function backup_dir() {
		$dir = self::backup_path();
		if ( ! is_dir( $dir ) ) {
			wp_mkdir_p( $dir );
		}
		if ( is_dir( $dir ) ) {
			self::protect_dir( $dir );
		}
		return wp_normalize_path( $dir );
	}

	/** The backup directory's path, without creating anything. */
	private static function backup_path() {
		$uploads = wp_upload_dir();
		$base    = ! empty( $uploads['basedir'] ) ? $uploads['basedir'] : WP_CONTENT_DIR . '/uploads';
		return trailingslashit( wp_normalize_path( $base ) ) . self::BACKUP_DIRNAME;
	}

	/** @return true|WP_Error */
	private static function ensure_backup_dir() {
		$dir = self::backup_path();
		if ( ! is_dir( $dir ) && ! wp_mkdir_p( $dir ) ) {
			return new WP_Error( 'morpheus_no_backup_dir', 'Morpheus could not create its backup directory at ' . $dir . '.' );
		}
		if ( ! wp_is_writable( $dir ) ) {
			return new WP_Error( 'morpheus_no_backup_dir', 'Morpheus\'s backup directory at ' . $dir . ' is not writable by PHP.' );
		}
		self::protect_dir( $dir );
		return true;
	}

	/**
	 * Snapshots must not be listable (index.php) or downloadable (.htaccess).
	 * nginx ignores .htaccess, which is one more reason nothing here hands out a
	 * URL for them.
	 */
	private static function protect_dir( $dir ) {
		$index = trailingslashit( $dir ) . 'index.php';
		if ( ! file_exists( $index ) ) {
			@file_put_contents( $index, "<?php // Silence is golden.\n" );
		}
		$htaccess = trailingslashit( $dir ) . '.htaccess';
		if ( ! file_exists( $htaccess ) ) {
			@file_put_contents(
				$htaccess,
				"# Morpheus backups — never served, never listed.\n"
				. "Options -Indexes\n"
				. "<IfModule mod_authz_core.c>\n\tRequire all denied\n</IfModule>\n"
				. "<IfModule !mod_authz_core.c>\n\tOrder deny,allow\n\tDeny from all\n</IfModule>\n"
			);
		}
	}

	/**
	 * Resolve $kind + $id to the thing on disk that would be snapshotted.
	 *
	 * $id comes over the network, so this is a security boundary: the id must be
	 * a plain relative path with no "." or ".." segment, no leading slash, no
	 * backslash and no NUL, and the resolved path must sit strictly inside the
	 * plugin or theme root. realpath() is what actually decides.
	 *
	 * @return array|WP_Error array( 'root', 'target', 'rel', 'file_only', 'slug', 'version' )
	 */
	private static function resolve_target( $kind, $id, $must_exist = true ) {
		$roots = self::roots();
		if ( ! isset( $roots[ $kind ] ) ) {
			return new WP_Error( 'morpheus_bad_kind', 'Morpheus can snapshot a plugin or a theme, not "' . $kind . '".' );
		}
		if ( ! is_string( $id ) || '' === trim( $id ) ) {
			return new WP_Error( 'morpheus_bad_target', 'The target name was empty, so there was nothing to snapshot.' );
		}
		if ( false !== strpos( $id, "\0" ) || false !== strpos( $id, '\\' ) || '/' === substr( $id, 0, 1 ) ) {
			return new WP_Error( 'morpheus_bad_target', 'The target name "' . $id . '" is not a plain relative name, so Morpheus refused it.' );
		}

		$root_raw  = $roots[ $kind ];
		$root_real = realpath( $root_raw );
		if ( false === $root_real ) {
			return new WP_Error( 'morpheus_no_root', 'The ' . $kind . ' directory could not be found at ' . $root_raw . '.' );
		}
		$root_real = wp_normalize_path( $root_real );

		$id        = trim( $id, '/' );
		$file_only = false;
		if ( 'plugin' === $kind ) {
			$dir       = dirname( $id );
			$file_only = ( '.' === $dir );
			$rel       = $file_only ? $id : $dir;
		} else {
			$rel = $id;
		}

		foreach ( explode( '/', $rel ) as $segment ) {
			if ( '' === $segment || '.' === $segment || '..' === $segment ) {
				return new WP_Error( 'morpheus_target_escape', 'Morpheus refused "' . $id . '": it points outside the ' . $kind . ' directory. A target can only be a name inside ' . $root_real . '.' );
			}
		}

		$target_real = realpath( wp_normalize_path( $root_real . '/' . $rel ) );
		if ( false === $target_real ) {
			if ( $must_exist ) {
				return new WP_Error( 'morpheus_target_missing', 'Morpheus could not find "' . $id . '" at ' . wp_normalize_path( $root_real . '/' . $rel ) . ', so there was nothing to snapshot.' );
			}
			$target = wp_normalize_path( $root_real . '/' . $rel );
		} else {
			$target_real = wp_normalize_path( $target_real );
			if ( 0 !== strpos( $target_real . '/', $root_real . '/' ) ) {
				return new WP_Error( 'morpheus_target_escape', 'Morpheus refused "' . $id . '": once resolved it is at ' . $target_real . ', outside ' . $root_real . '.' );
			}
			$target = $target_real;
		}

		if ( $must_exist && $file_only && ! is_file( $target ) ) {
			return new WP_Error( 'morpheus_target_missing', 'Morpheus expected the plugin file ' . $target . ' but it is not a file.' );
		}

		return array(
			'root'      => $root_real,
			'target'    => $target,
			'rel'       => $rel,
			'file_only' => $file_only,
			'slug'      => sanitize_file_name( basename( $file_only ? $id : $rel ) ),
			'version'   => self::installed_version( 'plugin' === $kind ? 'plugin' : 'theme', $id ),
		);
	}

	/** Plugin root, theme root — as the site itself defines them. */
	private static function roots() {
		$plugin = defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins';
		return array(
			'plugin' => wp_normalize_path( untrailingslashit( $plugin ) ),
			'theme'  => wp_normalize_path( untrailingslashit( get_theme_root() ) ),
		);
	}

	/**
	 * Resolve a snapshot name to a file inside the backup directory, or fail.
	 * basename() throws away any directory the caller tried to name, and the
	 * realpath() prefix check is the boundary. Only .zip files pass, so
	 * delete_snapshot() can never be pointed at index.php or .htaccess.
	 *
	 * @return string|WP_Error absolute path
	 */
	private static function resolve_backup_file( $file ) {
		if ( ! is_string( $file ) || '' === trim( $file ) ) {
			return new WP_Error( 'morpheus_backup_name', 'No backup file was named.' );
		}
		if ( false !== strpos( $file, "\0" ) ) {
			return new WP_Error( 'morpheus_backup_name', 'That backup name is not a valid file name.' );
		}
		$name = basename( str_replace( '\\', '/', $file ) );
		if ( '' === $name || '.' === $name || '..' === $name || '.zip' !== strtolower( substr( $name, -4 ) ) ) {
			return new WP_Error( 'morpheus_backup_name', 'Morpheus only works with its own .zip snapshots; "' . $file . '" is not one.' );
		}

		$dir      = self::backup_path();
		$dir_real = realpath( $dir );
		$file_real = realpath( trailingslashit( $dir ) . $name );
		if ( false === $dir_real || false === $file_real ) {
			return new WP_Error( 'morpheus_backup_missing', 'The snapshot "' . $name . '" is not in Morpheus\'s backup directory (' . $dir . ').' );
		}
		$dir_real  = wp_normalize_path( $dir_real );
		$file_real = wp_normalize_path( $file_real );
		if ( 0 !== strpos( $file_real, $dir_real . '/' ) ) {
			return new WP_Error( 'morpheus_backup_escape', 'Morpheus refused "' . $file . '": once resolved it is at ' . $file_real . ', outside its backup directory.' );
		}
		if ( ! is_file( $file_real ) ) {
			return new WP_Error( 'morpheus_backup_missing', 'The snapshot "' . $name . '" is not a file.' );
		}
		return $file_real;
	}

	// ── Archive helpers ─────────────────────────────────────────────────────

	/**
	 * Add the target's files to $zip under paths relative to its root. A file
	 * that resolves outside the root (a symlink out of the plugin) is skipped
	 * rather than followed — an archive that reaches outside the target is not a
	 * snapshot of the target.
	 *
	 * @return true|WP_Error
	 */
	private static function zip_add_target( $zip, $target, $root ) {
		if ( is_file( $target ) ) {
			$rel = basename( $target );
			if ( ! $zip->addFile( $target, $rel ) ) {
				return new WP_Error( 'morpheus_zip_add', 'Morpheus could not add ' . $target . ' to the backup archive.' );
			}
			return true;
		}
		if ( ! is_dir( $target ) ) {
			return new WP_Error( 'morpheus_zip_target', 'Morpheus found nothing to back up at ' . $target . '.' );
		}

		$root_real = wp_normalize_path( (string) realpath( $root ) );
		$base_len  = strlen( trailingslashit( wp_normalize_path( $target ) ) );
		$added     = 0;
		$iterator  = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $target, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::SELF_FIRST
		);
		foreach ( $iterator as $info ) {
			$path = wp_normalize_path( $info->getPathname() );
			$real = realpath( $path );
			if ( false === $real ) {
				continue;
			}
			$real = wp_normalize_path( $real );
			if ( 0 !== strpos( $real . '/', $root_real . '/' ) ) {
				continue; // a link pointing out of the target root
			}
			$local = ltrim( substr( $path, $base_len ), '/' );
			if ( '' === $local ) {
				continue;
			}
			if ( $info->isDir() ) {
				$zip->addEmptyDir( $local );
				continue;
			}
			if ( $info->isFile() ) {
				if ( ! $zip->addFile( $path, $local ) ) {
					return new WP_Error( 'morpheus_zip_add', 'Morpheus could not add ' . $path . ' to the backup archive.' );
				}
				$added++;
			}
		}
		if ( 0 === $added ) {
			return new WP_Error( 'morpheus_zip_target', 'Morpheus found no files under ' . $target . ', so there was nothing to back up and nothing was updated.' );
		}
		return true;
	}

	/** Does a zip entry name try to leave the extraction root? */
	private static function entry_escapes( $entry, $expect ) {
		if ( ! is_string( $entry ) || '' === $entry ) {
			return true;
		}
		if ( false !== strpos( $entry, "\0" ) || false !== strpos( $entry, '\\' ) ) {
			return true;
		}
		if ( '/' === substr( $entry, 0, 1 ) || preg_match( '#^[A-Za-z]:#', $entry ) ) {
			return true;
		}
		foreach ( explode( '/', $entry ) as $segment ) {
			if ( '..' === $segment ) {
				return true;
			}
		}
		if ( null !== $expect ) {
			$name = ltrim( str_replace( '\\', '/', $entry ), '/' );
			if ( $name !== $expect && rtrim( $name, '/' ) !== $expect ) {
				return true;
			}
		}
		return false;
	}

	/** Empty a directory without removing the directory itself. */
	private static function clear_dir( $dir ) {
		if ( ! is_dir( $dir ) ) {
			return true;
		}
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::CHILD_FIRST
		);
		foreach ( $iterator as $info ) {
			$path = $info->getPathname();
			if ( $info->isDir() && ! $info->isLink() ) {
				if ( ! @rmdir( $path ) ) {
					return false;
				}
			} elseif ( ! @unlink( $path ) ) {
				return false;
			}
		}
		return true;
	}

	private static function has_files( $dir ) {
		if ( ! is_dir( $dir ) ) {
			return false;
		}
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $dir, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::LEAVES_ONLY
		);
		foreach ( $iterator as $info ) {
			if ( $info->isFile() ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Total size of a file or tree, in bytes, stopping as soon as it is over the
	 * limit — a refusal must not need to read a whole backup-sized tree.
	 */
	private static function measure( $target ) {
		if ( is_file( $target ) ) {
			return (int) filesize( $target );
		}
		if ( ! is_dir( $target ) ) {
			return 0;
		}
		$bytes    = 0;
		$iterator = new RecursiveIteratorIterator(
			new RecursiveDirectoryIterator( $target, FilesystemIterator::SKIP_DOTS ),
			RecursiveIteratorIterator::LEAVES_ONLY
		);
		foreach ( $iterator as $info ) {
			if ( ! $info->isFile() ) {
				continue;
			}
			$bytes += (int) $info->getSize();
			if ( $bytes > self::MAX_BACKUP_BYTES ) {
				return $bytes; // over the limit; the exact total does not matter
			}
		}
		return $bytes;
	}

	private static function snapshot_name( $kind, $slug, $version, $suffix = 0 ) {
		$version = sanitize_file_name( (string) $version );
		if ( '' === $version ) {
			$version = 'unknown';
		}
		$slug = sanitize_file_name( (string) $slug );
		if ( '' === $slug ) {
			$slug = 'target';
		}
		$name = $kind . '-' . $slug . '-' . $version . '-' . gmdate( 'Ymd-His' );
		if ( $suffix > 0 ) {
			$name .= '-' . (int) $suffix;
		}
		return $name . '.zip';
	}

	// ── Versions ────────────────────────────────────────────────────────────

	private static function installed_version( $kind, $id ) {
		if ( 'plugin' === $kind ) {
			if ( ! function_exists( 'get_plugins' ) ) {
				require_once ABSPATH . 'wp-admin/includes/plugin.php';
			}
			wp_clean_plugins_cache( false );
			$all = get_plugins();
			return isset( $all[ $id ]['Version'] ) ? (string) $all[ $id ]['Version'] : '';
		}
		if ( 'theme' === $kind ) {
			if ( function_exists( 'wp_clean_themes_cache' ) ) {
				wp_clean_themes_cache( false );
			}
			$theme = wp_get_theme( $id );
			if ( ! is_object( $theme ) || $theme->errors() ) {
				return '';
			}
			return (string) $theme->get( 'Version' );
		}

		// Core. get_bloginfo('version') reads the $wp_version global, and a core
		// update only rewrites that global when something re-reads version.php —
		// so read it, then ask WordPress, rather than trusting a stale global.
		$version_file = ABSPATH . WPINC . '/version.php';
		if ( file_exists( $version_file ) ) {
			global $wp_version;
			include $version_file;
		}
		return (string) get_bloginfo( 'version' );
	}

	private static function plugin_main_file( $id ) {
		$root = defined( 'WP_PLUGIN_DIR' ) ? WP_PLUGIN_DIR : WP_CONTENT_DIR . '/plugins';
		return wp_normalize_path( trailingslashit( $root ) . $id );
	}

	private static function plugin_is_active( $id ) {
		require_once ABSPATH . 'wp-admin/includes/plugin.php';
		if ( is_multisite() && function_exists( 'is_plugin_active_for_network' ) && is_plugin_active_for_network( $id ) ) {
			return true;
		}
		return is_plugin_active( $id );
	}

	/** The major version number, or 0 when the string is not a version at all. */
	private static function major( $version ) {
		$version = (string) $version;
		if ( '' === $version ) {
			return 0;
		}
		$parts = explode( '.', ltrim( $version, 'vV' ) );
		return ctype_digit( (string) $parts[0] ) ? (int) $parts[0] : 0;
	}

	// ── The host, and WordPress's own tests ─────────────────────────────────

	private static function admin_includes() {
		// The update*() functions are written for the admin screen and call
		// admin-only helpers, so the admin includes are not optional here — see
		// class-health.php, where their absence produced a fatal with no output.
		$files = array(
			'wp-admin/includes/admin.php',
			'wp-admin/includes/update.php',
			'wp-admin/includes/plugin.php',
			'wp-admin/includes/theme.php',
			'wp-admin/includes/file.php',
			'wp-admin/includes/misc.php',
		);
		foreach ( $files as $file ) {
			$path = ABSPATH . $file;
			if ( file_exists( $path ) ) {
				require_once $path;
			}
		}
	}

	/** Morpheus_Health's verdict on this host, reused rather than re-derived. */
	private static function host() {
		$scan = self::scan();
		if ( ! isset( $scan['host'] ) || ! is_array( $scan['host'] ) ) {
			// Fail closed: without the health scan Morpheus cannot confirm the
			// host is writable, and it does not assume it is.
			return array(
				'can_update_files' => false,
				'blockers'         => array( 'the site health scan is unavailable, so Morpheus cannot confirm that this site can write plugin and theme files' ),
			);
		}
		return $scan['host'];
	}

	private static function host_blockers( $host ) {
		if ( isset( $host['blockers'] ) && is_array( $host['blockers'] ) && $host['blockers'] ) {
			return array_values( $host['blockers'] );
		}
		return array();
	}

	/** The whole scan, cached by Morpheus_Health for a few minutes. */
	private static function scan() {
		if ( ! class_exists( 'Morpheus_Health' ) ) {
			return array();
		}
		$scan = Morpheus_Health::scan();
		return is_array( $scan ) ? $scan : array();
	}

	/**
	 * WordPress's own "Plugin and theme temporary backup directory is writable"
	 * test, read out of the scan's test list — never reimplemented. Matched by
	 * id first, then by label, so a WordPress release that renames the id still
	 * finds it.
	 *
	 * @return array( 'status' => good|recommended|critical|unknown, 'label', 'description' )
	 */
	private static function temp_backup_status() {
		$scan   = self::scan();
		$tests  = isset( $scan['tests'] ) && is_array( $scan['tests'] ) ? $scan['tests'] : array();
		$result = array(
			'status'      => 'unknown',
			'label'       => 'WordPress update temporary backup directory',
			'description' => 'WordPress\'s own test for the update temporary backup directory was not in the health scan.',
		);

		$found = null;
		foreach ( $tests as $test ) {
			if ( ! is_array( $test ) ) {
				continue;
			}
			if ( isset( $test['id'] ) && 'update_temp_backup_writable' === $test['id'] ) {
				$found = $test;
				break;
			}
		}
		if ( null === $found ) {
			foreach ( $tests as $test ) {
				if ( ! is_array( $test ) || ! isset( $test['label'] ) ) {
					continue;
				}
				$label = strtolower( (string) $test['label'] );
				if ( false !== strpos( $label, 'backup' ) && false !== strpos( $label, 'writ' ) ) {
					$found = $test;
					break;
				}
			}
		}
		if ( null === $found ) {
			return $result;
		}

		$result['status'] = isset( $found['status'] ) ? (string) $found['status'] : 'unknown';
		if ( isset( $found['label'] ) && '' !== $found['label'] ) {
			$result['label'] = (string) $found['label'];
		}
		if ( isset( $found['description'] ) && '' !== $found['description'] ) {
			$result['description'] = (string) $found['description'];
		}
		return $result;
	}

	private static function temp_backup_refusal( $check ) {
		return 'WordPress cannot use its own temporary backup directory for updates — its Site Health test "' . $check['label'] . '" reports "' . $check['status'] . '". A core update could not be undone, so Morpheus did not apply it. Nothing was changed. ' . $check['description'];
	}

	private static function too_big_message( $target, $bytes ) {
		return 'The backup for ' . $target . ' would be ' . self::human_size( $bytes ) . ', over Morpheus\'s ' . self::human_size( self::MAX_BACKUP_BYTES ) . ' limit per target. Morpheus refuses rather than store a half-written archive; update this one from Dashboard → Updates, which backs it up differently.';
	}

	private static function human_size( $bytes ) {
		$bytes = (int) $bytes;
		if ( $bytes >= 1048576 ) {
			return round( $bytes / 1048576, 1 ) . ' MB';
		}
		if ( $bytes >= 1024 ) {
			return round( $bytes / 1024 ) . ' KB';
		}
		return $bytes . ' bytes';
	}
}
