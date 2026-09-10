<?php
/**
 * Minimal GitHub API client — enough to read a commit's file tree and the
 * content of individual blobs. Uses the WP HTTP API (wp_remote_get), so it
 * respects the site's proxy / SSL config.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Deploy_GitHub {

	/** @var string owner/repo */
	private $repo;
	/** @var string */
	private $token;

	public function __construct( $repo, $token ) {
		$this->repo  = $repo;
		$this->token = $token;
	}

	private function get( $path, $accept = 'application/vnd.github+json' ) {
		$headers = array(
			'Accept'               => $accept,
			'X-GitHub-Api-Version' => '2022-11-28',
			'User-Agent'           => 'MorpheusDeploy/' . MORPHEUS_DEPLOY_VERSION,
		);
		// Only send the token when we have one — a public repo needs none,
		// and an empty Bearer is a 401.
		if ( is_string( $this->token ) && $this->token !== '' ) {
			$headers['Authorization'] = 'Bearer ' . $this->token;
		}
		$res = wp_remote_get( 'https://api.github.com/repos/' . $this->repo . $path, array(
			'timeout' => 20,
			'headers' => $headers,
		) );
		if ( is_wp_error( $res ) ) {
			return new WP_Error( 'github_http', $res->get_error_message() );
		}
		$code = wp_remote_retrieve_response_code( $res );
		$body = wp_remote_retrieve_body( $res );
		if ( $code < 200 || $code >= 300 ) {
			$msg = $body;
			$j   = json_decode( $body, true );
			if ( is_array( $j ) && ! empty( $j['message'] ) ) {
				$msg = $j['message'];
			}
			return new WP_Error( 'github_status', 'GitHub API ' . $code . ': ' . $msg, array( 'status' => $code ) );
		}
		return $body;
	}

	/**
	 * The full recursive blob tree at a commit / ref.
	 * @return array|WP_Error  [ 'path' => 'sha', ... ] (blobs only) + '__truncated' bool
	 */
	public function tree( $ref ) {
		$body = $this->get( '/git/trees/' . rawurlencode( $ref ) . '?recursive=1' );
		if ( is_wp_error( $body ) ) {
			return $body;
		}
		$data = json_decode( $body, true );
		if ( ! is_array( $data ) || ! isset( $data['tree'] ) ) {
			return new WP_Error( 'github_parse', 'Unexpected tree response' );
		}
		$out = array( '__truncated' => ! empty( $data['truncated'] ) );
		foreach ( $data['tree'] as $entry ) {
			if ( isset( $entry['type'] ) && $entry['type'] === 'blob' ) {
				$out[ $entry['path'] ] = $entry['sha'];
			}
		}
		return $out;
	}

	/**
	 * Raw bytes of one file at a ref.
	 * @return string|WP_Error
	 */
	public function file( $rel_path, $ref ) {
		$encoded = implode( '/', array_map( 'rawurlencode', explode( '/', $rel_path ) ) );
		$body    = $this->get( '/contents/' . $encoded . '?ref=' . rawurlencode( $ref ) );
		if ( is_wp_error( $body ) ) {
			return $body;
		}
		$data = json_decode( $body, true );
		if ( is_array( $data ) && isset( $data['content'] ) && ( $data['encoding'] ?? '' ) === 'base64' ) {
			return base64_decode( str_replace( "\n", '', $data['content'] ) );
		}
		if ( is_array( $data ) && isset( $data['download_url'] ) ) {
			// large file — Contents API omits content; fetch the raw blob
			$raw = wp_remote_get( $data['download_url'], array( 'timeout' => 30 ) );
			if ( ! is_wp_error( $raw ) && wp_remote_retrieve_response_code( $raw ) === 200 ) {
				return wp_remote_retrieve_body( $raw );
			}
		}
		return new WP_Error( 'github_parse', 'Could not read ' . $rel_path . ' at ' . $ref );
	}

	/** Metadata for one commit (message, parents). */
	public function commit( $sha ) {
		$body = $this->get( '/commits/' . rawurlencode( $sha ) );
		if ( is_wp_error( $body ) ) {
			return $body;
		}
		return json_decode( $body, true );
	}

	/**
	 * Files changed between two commits.
	 * @return array|WP_Error  [ [ 'path' => ..., 'status' => 'added|modified|removed|renamed', 'previous_filename' => ?, 'sha' => blobSha ], ... ]
	 */
	public function compare( $base, $head ) {
		$body = $this->get( '/compare/' . rawurlencode( $base ) . '...' . rawurlencode( $head ) );
		if ( is_wp_error( $body ) ) {
			return $body;
		}
		$data = json_decode( $body, true );
		if ( ! is_array( $data ) || ! isset( $data['files'] ) ) {
			return new WP_Error( 'github_parse', 'Unexpected compare response' );
		}
		$out = array();
		foreach ( $data['files'] as $f ) {
			$out[] = array(
				'path'              => $f['filename'],
				'status'            => $f['status'],
				'previous_filename' => $f['previous_filename'] ?? null,
				'sha'               => $f['sha'] ?? null,
			);
		}
		return $out;
	}
}
