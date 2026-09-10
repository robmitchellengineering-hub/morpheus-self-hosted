<?php
/**
 * The deployer. v0.1: DRY-RUN ONLY — computes what a deploy would change
 * (from GitHub's diff for the merge commit) and returns a report. It never
 * writes, deletes, or rolls back anything.
 *
 * The write / snapshot / health-check / rollback path lands in v0.2, gated
 * behind the "armed" setting.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Deploy_Deployer {

	/** @var array settings */
	private $s;

	public function __construct( array $settings ) {
		$this->s = $settings;
	}

	/**
	 * @param string $commit_sha  the merge commit to deploy
	 * @param string $reason
	 * @return array|WP_Error
	 */
	public function dry_run( $commit_sha, $reason = '' ) {
		if ( empty( $this->s['repo'] ) || empty( $this->s['github_token'] ) ) {
			return new WP_Error( 'not_configured', 'Set the repo and GitHub token in Settings → Morpheus Deploy.', array( 'status' => 400 ) );
		}

		$gh = new Morpheus_Deploy_GitHub( $this->s['repo'], $this->s['github_token'] );

		// What did this merge change? Diff its first parent against it, so we
		// only look at the changed files — never hash the whole tree.
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

		$abs  = rtrim( ABSPATH, '/\\' );
		$plan = array(
			'create'    => array(),
			'update'    => array(),
			'delete'    => array(),
			'unchanged' => 0,
			'denied'    => array(),
			'unsafe'    => array(),
		);

		foreach ( $changed as $f ) {
			$rel    = $f['path'];
			$status = $f['status'];

			// A rename touches two paths.
			$paths = array( $rel );
			if ( $status === 'renamed' && ! empty( $f['previous_filename'] ) ) {
				$paths[] = $f['previous_filename'];
			}
			foreach ( $paths as $p ) {
				if ( ! morpheus_deploy_path_is_safe( $p ) ) {
					$plan['unsafe'][] = $p;
					continue 2;
				}
				if ( morpheus_deploy_is_denied( $p ) ) {
					$plan['denied'][] = $p;
					continue 2;
				}
			}

			$disk = $abs . '/' . $rel;

			if ( $status === 'removed' ) {
				if ( file_exists( $disk ) ) {
					$plan['delete'][] = $rel;
				}
				continue;
			}

			if ( ! file_exists( $disk ) ) {
				$plan['create'][] = $rel;
				continue;
			}

			// It's on disk — is it already what the merge produced?
			if ( $f['sha'] && morpheus_deploy_git_blob_sha( file_get_contents( $disk ) ) === $f['sha'] ) {
				$plan['unchanged']++;
			} else {
				$plan['update'][] = $rel;
			}

			if ( $status === 'renamed' && ! empty( $f['previous_filename'] ) && file_exists( $abs . '/' . $f['previous_filename'] ) ) {
				$plan['delete'][] = $f['previous_filename'];
			}
		}

		foreach ( array( 'create', 'update', 'delete', 'denied', 'unsafe' ) as $k ) {
			$plan[ $k ] = array_values( array_unique( $plan[ $k ] ) );
			sort( $plan[ $k ] );
		}

		$report = array(
			'ok'           => true,
			'dry_run'      => true,
			'commit'       => $commit_sha,
			'base'         => $base,
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
				array_map( function ( $p ) { return 'create ' . $p; }, $plan['create'] ),
				array_map( function ( $p ) { return 'update ' . $p; }, $plan['update'] ),
				array_map( function ( $p ) { return 'delete ' . $p; }, $plan['delete'] )
			), 0, 100 ),
			'note'         => 'Dry run — nothing was written. Enable writes in a later plugin version.',
		);

		morpheus_deploy_log( 'dry_run', array(
			'commit' => $commit_sha,
			'create' => $report['would_create'],
			'update' => $report['would_update'],
			'delete' => $report['would_delete'],
			'denied' => count( $plan['denied'] ),
			'unsafe' => count( $plan['unsafe'] ),
		) );

		return $report;
	}
}
