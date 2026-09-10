<?php
/**
 * The deployer.
 *
 *  dry_run($sha)  — report what a deploy would change; writes nothing.
 *  deploy($sha)   — the armed path: snapshot → write the changed files →
 *                   health-check → auto-rollback from the snapshot on
 *                   failure. Only runs when the "armed" setting is on.
 *
 * The change set comes from GitHub's `compare` of the merge commit's first
 * parent against it, so we only ever look at the files that changed — never
 * hash the whole tree. Every path is checked against the hard deny-list and
 * path-safety rules here in PHP, whatever the pushed tree contains.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Deploy {

	const MAX_FILE_BYTES = 10 * 1024 * 1024; // refuse a deploy that ships a file bigger than this
	const KEEP_SNAPSHOTS = 5;

	/** @var array */    private $s;
	/** @var string */   private $root;
	/** @var object|null */ private $gh;

	/**
	 * @param array       $settings
	 * @param string|null $root    site root to write under (defaults to ABSPATH) — overridable for tests
	 * @param object|null $github  a client with tree()/file()/commit()/compare() (defaults to the real one) — for tests
	 */
	public function __construct( array $settings, $root = null, $github = null ) {
		$this->s    = $settings;
		$this->root = rtrim( $root ?: ABSPATH, '/\\' );
		$this->gh   = $github;
	}

	private function github() {
		if ( ! $this->gh ) {
			$this->gh = new Morpheus_GitHub( $this->s['repo'], $this->s['github_token'] );
		}
		return $this->gh;
	}

	// ── Plan ────────────────────────────────────────────────────────────────

	/**
	 * @return array|WP_Error  { base, changed: [ { path, status, sha } ], plan: { create, update, delete, unchanged, denied, unsafe, oversize } }
	 */
	private function compute_plan( $commit_sha ) {
		if ( empty( $this->s['repo'] ) ) {
			return new WP_Error( 'not_configured', 'Set the repo in Settings → Morpheus.', array( 'status' => 400 ) );
		}

		$gh     = $this->github();
		$commit = $gh->commit( $commit_sha );
		if ( is_wp_error( $commit ) ) {
			return $commit;
		}
		$base = $commit['parents'][0]['sha'] ?? null;
		if ( ! $base ) {
			return new WP_Error( 'no_parent', 'That commit has no parent to diff against.', array( 'status' => 400 ) );
		}

		$changed = $gh->compare( $base, $commit_sha );
		if ( is_wp_error( $changed ) ) {
			return $changed;
		}

		$plan = array(
			'create' => array(), 'update' => array(), 'delete' => array(),
			'unchanged' => 0, 'denied' => array(), 'unsafe' => array(), 'oversize' => array(),
		);

		foreach ( $changed as $f ) {
			$rel    = $f['path'];
			$status = $f['status'];

			$paths = array( $rel );
			if ( $status === 'renamed' && ! empty( $f['previous_filename'] ) ) {
				$paths[] = $f['previous_filename'];
			}
			$bad = false;
			foreach ( $paths as $p ) {
				if ( ! morpheus_path_is_safe( $p ) ) { $plan['unsafe'][] = $p; $bad = true; }
				elseif ( morpheus_is_denied( $p ) )  { $plan['denied'][] = $p; $bad = true; }
			}
			if ( $bad ) {
				continue;
			}

			$disk = $this->root . '/' . $rel;

			if ( $status === 'removed' ) {
				if ( file_exists( $disk ) ) {
					$plan['delete'][] = $rel;
				}
				continue;
			}

			if ( ! file_exists( $disk ) ) {
				$plan['create'][] = $rel;
			} elseif ( $f['sha'] && morpheus_git_blob_sha( file_get_contents( $disk ) ) === $f['sha'] ) {
				$plan['unchanged']++;
			} else {
				$plan['update'][] = $rel;
			}

			if ( $status === 'renamed' && ! empty( $f['previous_filename'] ) && file_exists( $this->root . '/' . $f['previous_filename'] ) ) {
				$plan['delete'][] = $f['previous_filename'];
			}
		}

		foreach ( array( 'create', 'update', 'delete', 'denied', 'unsafe', 'oversize' ) as $k ) {
			$plan[ $k ] = array_values( array_unique( $plan[ $k ] ) );
			sort( $plan[ $k ] );
		}

		return array( 'base' => $base, 'changed' => $changed, 'plan' => $plan );
	}

	// ── Dry run ─────────────────────────────────────────────────────────────

	public function dry_run( $commit_sha, $reason = '' ) {
		$p = $this->compute_plan( $commit_sha );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		$plan = $p['plan'];

		morpheus_log( 'dry_run', array( 'commit' => $commit_sha, 'create' => count( $plan['create'] ), 'update' => count( $plan['update'] ), 'delete' => count( $plan['delete'] ), 'denied' => count( $plan['denied'] ), 'unsafe' => count( $plan['unsafe'] ) ) );

		return array(
			'ok'           => true,
			'dry_run'      => true,
			'commit'       => $commit_sha,
			'base'         => $p['base'],
			'reason'       => $reason,
			'repo'         => $this->s['repo'],
			'branch'       => $this->s['branch'],
			'would_create' => count( $plan['create'] ),
			'would_update' => count( $plan['update'] ),
			'would_delete' => count( $plan['delete'] ),
			'unchanged'    => $plan['unchanged'],
			'denied'       => $plan['denied'],
			'unsafe'       => $plan['unsafe'],
			'files'        => array_slice( array_merge(
				array_map( function ( $x ) { return "create $x"; }, $plan['create'] ),
				array_map( function ( $x ) { return "update $x"; }, $plan['update'] ),
				array_map( function ( $x ) { return "delete $x"; }, $plan['delete'] )
			), 0, 100 ),
			'note'         => 'Dry run — nothing was written.',
		);
	}

	// ── Deploy (armed) ──────────────────────────────────────────────────────

	public function deploy( $commit_sha, $reason = '' ) {
		$p = $this->compute_plan( $commit_sha );
		if ( is_wp_error( $p ) ) {
			return $p;
		}
		$plan = $p['plan'];

		// An unsafe path in the change set is an attack signature — abort,
		// touch nothing.
		if ( ! empty( $plan['unsafe'] ) ) {
			morpheus_log( 'aborted', array( 'why' => 'unsafe paths', 'paths' => $plan['unsafe'] ) );
			return new WP_Error( 'unsafe_paths', 'Change touches unsafe paths; nothing was written.', array( 'status' => 422, 'unsafe' => $plan['unsafe'] ) );
		}

		if ( empty( $plan['create'] ) && empty( $plan['update'] ) && empty( $plan['delete'] ) ) {
			return array( 'ok' => true, 'deployed' => false, 'reason' => 'no-op', 'commit' => $commit_sha, 'unchanged' => $plan['unchanged'], 'denied' => $plan['denied'] );
		}

		$deploy_id = gmdate( 'Ymd-His' ) . '-' . substr( md5( $commit_sha . microtime() ), 0, 6 );
		$snap_dir  = MORPHEUS_STATE_DIR . '/snapshots/' . $deploy_id;
		wp_mkdir_p( $snap_dir );

		$writes  = array_merge( $plan['create'], $plan['update'] );
		$deletes = $plan['delete'];

		// 1. Snapshot every path we're about to touch.
		$snapshot = array();
		foreach ( array_merge( $writes, $deletes ) as $rel ) {
			$disk    = $this->root . '/' . $rel;
			$existed = file_exists( $disk );
			$entry   = array( 'path' => $rel, 'existed' => $existed );
			if ( $existed ) {
				$safe = str_replace( '/', '__', $rel );
				@copy( $disk, $snap_dir . '/' . $safe );
				$entry['snap'] = $safe;
			}
			$snapshot[] = $entry;
		}
		$manifest = array( 'deploy_id' => $deploy_id, 'at' => gmdate( 'c' ), 'commit' => $commit_sha, 'base' => $p['base'], 'root' => $this->root, 'entries' => $snapshot );
		@file_put_contents( $snap_dir . '/manifest.json', wp_json_encode( $manifest ) );

		// 2. Fetch + write each changed file, verifying the blob sha.
		$gh      = $this->github();
		$written = array();
		$failed  = null;
		$by_path = array();
		foreach ( $p['changed'] as $f ) {
			$by_path[ $f['path'] ] = $f['sha'];
		}

		foreach ( $writes as $rel ) {
			$content = $gh->file( $rel, $commit_sha );
			if ( is_wp_error( $content ) ) {
				$failed = "fetch $rel: " . $content->get_error_message();
				break;
			}
			if ( strlen( $content ) > self::MAX_FILE_BYTES ) {
				$failed = "$rel is larger than " . size_format( self::MAX_FILE_BYTES ) . " — keep large assets out of the repo";
				break;
			}
			$want = $by_path[ $rel ] ?? null;
			if ( $want && morpheus_git_blob_sha( $content ) !== $want ) {
				$failed = "content of $rel did not match the expected git hash";
				break;
			}
			$disk = $this->root . '/' . $rel;
			if ( ! wp_mkdir_p( dirname( $disk ) ) || file_put_contents( $disk, $content ) === false ) {
				$failed = "could not write $rel";
				break;
			}
			$written[] = $rel;
		}

		// 3. Deletions (only if nothing failed above).
		$deleted = array();
		if ( ! $failed ) {
			foreach ( $deletes as $rel ) {
				$disk = $this->root . '/' . $rel;
				if ( file_exists( $disk ) && @unlink( $disk ) ) {
					$deleted[] = $rel;
				}
			}
		}

		if ( function_exists( 'opcache_reset' ) ) {
			@opcache_reset();
		}

		// 4. Health check.
		$health = $failed ? array( 'ok' => false, 'skipped' => true, 'reason' => $failed ) : $this->health_check();

		// 5. Roll back on failure.
		$rolled_back = false;
		if ( $failed || empty( $health['ok'] ) ) {
			$this->restore( $snapshot, $snap_dir );
			if ( function_exists( 'opcache_reset' ) ) {
				@opcache_reset();
			}
			$rolled_back = true;
			$health_after = $this->health_check();
			morpheus_log( 'rolled_back', array( 'deploy_id' => $deploy_id, 'commit' => $commit_sha, 'why' => $failed ?: 'health check failed', 'health_after' => $health_after ) );

			$this->finish( $deploy_id, $commit_sha, false, $reason );
			return array(
				'ok'           => false,
				'deployed'     => false,
				'rolled_back'  => true,
				'deploy_id'    => $deploy_id,
				'commit'       => $commit_sha,
				'reason'       => $reason,
				'why'          => $failed ?: 'post-deploy health check failed',
				'written'      => $written,
				'deleted'      => $deleted,
				'health'       => $health,
				'health_after_rollback' => $health_after,
			);
		}

		// 6. Success.
		$this->update_managed_manifest( $written, $deleted );
		$this->finish( $deploy_id, $commit_sha, true, $reason );
		morpheus_log( 'deployed', array( 'deploy_id' => $deploy_id, 'commit' => $commit_sha, 'created' => count( $plan['create'] ), 'updated' => count( $plan['update'] ), 'deleted' => count( $deleted ) ) );

		return array(
			'ok'          => true,
			'deployed'    => true,
			'rolled_back' => false,
			'deploy_id'   => $deploy_id,
			'commit'      => $commit_sha,
			'base'        => $p['base'],
			'reason'      => $reason,
			'created'     => count( $plan['create'] ),
			'updated'     => count( $plan['update'] ),
			'deleted'     => count( $deleted ),
			'skipped_denied' => $plan['denied'],
			'written'     => $written,
			'health'      => $health,
		);
	}

	// ── Rollback support ────────────────────────────────────────────────────

	private function restore( array $snapshot, $snap_dir ) {
		foreach ( $snapshot as $e ) {
			$disk = $this->root . '/' . $e['path'];
			if ( ! empty( $e['existed'] ) && ! empty( $e['snap'] ) ) {
				$src = $snap_dir . '/' . $e['snap'];
				if ( file_exists( $src ) ) {
					wp_mkdir_p( dirname( $disk ) );
					@copy( $src, $disk );
				}
			} elseif ( empty( $e['existed'] ) && file_exists( $disk ) ) {
				@unlink( $disk ); // it was newly created — remove it
			}
		}
	}

	/** Restore the most recent successful deploy's snapshot — the operator "undo". */
	public function rollback_last() {
		$last = get_option( 'morpheus_deploy_last', array() );
		$id   = $last['deploy_id'] ?? null;
		if ( ! $id ) {
			return new WP_Error( 'nothing_to_roll_back', 'No recorded deploy to roll back.', array( 'status' => 400 ) );
		}
		$snap_dir = MORPHEUS_STATE_DIR . '/snapshots/' . $id;
		$mf       = @file_get_contents( $snap_dir . '/manifest.json' );
		$manifest = $mf ? json_decode( $mf, true ) : null;
		if ( ! is_array( $manifest ) || empty( $manifest['entries'] ) ) {
			return new WP_Error( 'snapshot_missing', 'That deploy\'s snapshot is gone.', array( 'status' => 410 ) );
		}
		$this->restore( $manifest['entries'], $snap_dir );
		if ( function_exists( 'opcache_reset' ) ) {
			@opcache_reset();
		}
		$health = $this->health_check();
		morpheus_log( 'manual_rollback', array( 'deploy_id' => $id, 'health' => $health ) );
		return array( 'ok' => (bool) $health['ok'], 'rolled_back_deploy' => $id, 'commit' => $manifest['commit'] ?? null, 'health' => $health );
	}

	// ── Health check ────────────────────────────────────────────────────────

	public function health_check() {
		$base = rtrim( $this->s['site_url'] ?: home_url(), '/' );
		$fatal = array( 'There has been a critical error', 'Error establishing a database connection' );

		$paths = array( '/' );
		foreach ( preg_split( '/\r\n|\r|\n/', (string) ( $this->s['health_paths'] ?? '' ) ) as $l ) {
			$l = trim( $l );
			if ( $l !== '' && $l !== '/' ) {
				$paths[] = $l;
			}
		}
		$paths = array_slice( array_unique( $paths ), 0, 15 );

		$checks = array();
		foreach ( $paths as $path ) {
			$res = wp_remote_get( $base . $path, array( 'timeout' => 15, 'redirection' => 2, 'headers' => array( 'User-Agent' => 'MorpheusDeploy-healthcheck' ) ) );
			if ( is_wp_error( $res ) ) {
				$checks[] = array( 'path' => $path, 'ok' => false, 'detail' => $res->get_error_message() );
				continue;
			}
			$code = wp_remote_retrieve_response_code( $res );
			$body = wp_remote_retrieve_body( $res );
			$fatal_hit = false;
			foreach ( $fatal as $needle ) {
				if ( stripos( $body, $needle ) !== false ) { $fatal_hit = true; }
			}
			$ok = ( $code >= 200 && $code < 400 ) && ! $fatal_hit;
			$checks[] = array( 'path' => $path, 'ok' => $ok, 'detail' => $code . ( $fatal_hit ? ' + error page' : '' ) );
		}

		$failing = array();
		foreach ( $checks as $c ) {
			if ( ! $c['ok'] ) { $failing[] = $c['path']; }
		}
		return array( 'ok' => empty( $failing ), 'checks' => $checks, 'failing' => $failing, 'base' => $base );
	}

	// ── Bookkeeping ─────────────────────────────────────────────────────────

	private function finish( $deploy_id, $commit, $success, $reason ) {
		update_option( 'morpheus_deploy_last', array(
			'deploy_id' => $deploy_id, 'at' => gmdate( 'c' ), 'commit' => $commit,
			'reason' => $reason, 'success' => (bool) $success,
		), false );
		$this->prune_snapshots();
	}

	private function prune_snapshots() {
		$dir = MORPHEUS_STATE_DIR . '/snapshots';
		if ( ! is_dir( $dir ) ) {
			return;
		}
		$snaps = array_filter( glob( $dir . '/*' ), 'is_dir' );
		if ( count( $snaps ) <= self::KEEP_SNAPSHOTS ) {
			return;
		}
		usort( $snaps, function ( $a, $b ) { return filemtime( $a ) <=> filemtime( $b ); } );
		foreach ( array_slice( $snaps, 0, count( $snaps ) - self::KEEP_SNAPSHOTS ) as $old ) {
			foreach ( (array) glob( $old . '/*' ) as $f ) {
				@unlink( $f );
			}
			@rmdir( $old );
		}
	}

	private function update_managed_manifest( array $written, array $deleted ) {
		$path = MORPHEUS_STATE_DIR . '/managed.json';
		$set  = array();
		$cur  = @file_get_contents( $path );
		if ( $cur ) {
			foreach ( (array) json_decode( $cur, true ) as $p ) {
				$set[ $p ] = true;
			}
		}
		foreach ( $written as $p ) {
			$set[ $p ] = true;
		}
		foreach ( $deleted as $p ) {
			unset( $set[ $p ] );
		}
		@file_put_contents( $path, wp_json_encode( array_keys( $set ) ) );
	}
}
