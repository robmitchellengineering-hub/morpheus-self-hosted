<?php
/**
 * The wp-admin settings screen: Settings → Morpheus.
 * Stores everything in one option array, the option 'morpheus_settings'.
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_Settings {

	const OPTION = 'morpheus_settings';

	public static function defaults() {
		return array(
			'repo'          => '',   // "owner/repo"
			'branch'        => 'main',
			'github_token'  => '',   // a fine-grained PAT / GitHub App token with Contents:read on the repo
			'webhook_secret' => '',   // shared HMAC secret, also set on the Morpheus side
			'site_url'      => '',    // used for the post-deploy health check; defaults to home_url()
			'health_paths'  => "/\n/shop/\n/cart/", // one per line
			'armed'         => 0,     // 0 = the deploy endpoint reports only; 1 = it writes files
		);
	}

	public static function get( $key = null ) {
		$opt = wp_parse_args( (array) get_option( self::OPTION, array() ), self::defaults() );
		if ( $key === null ) {
			return $opt;
		}
		return isset( $opt[ $key ] ) ? $opt[ $key ] : null;
	}

	/**
	 * The Connect panel's buttons: issue a fresh code, or disconnect.
	 *
	 * Both are nonce-checked and capability-checked — a code is a credential,
	 * so only an administrator may mint one.
	 */
	public static function handle_pair_action() {
		if ( ! isset( $_GET['morpheus_pair_action'] ) ) {
			return;
		}
		if ( ! current_user_can( 'manage_options' ) ) {
			wp_die( 'Not allowed.' );
		}
		$action = sanitize_key( wp_unslash( $_GET['morpheus_pair_action'] ) );
		check_admin_referer( 'morpheus_pair_' . $action );
		if ( 'rotate' === $action ) {
			Morpheus_Pairing::rotate();
		} elseif ( 'disconnect' === $action ) {
			Morpheus_Pairing::disconnect();
		}
		wp_safe_redirect( admin_url( 'options-general.php?page=morpheus&morpheus_done=' . $action ) );
		exit;
	}

	public static function register_menu() {
		add_options_page(
			'Morpheus',
			'Morpheus',
			'manage_options',
			'morpheus',
			array( __CLASS__, 'render' )
		);
	}

	public static function register_settings() {
		register_setting( 'morpheus_deploy', self::OPTION, array( __CLASS__, 'sanitize' ) );
	}

	public static function sanitize( $input ) {
		$out = self::get();
		$in  = is_array( $input ) ? $input : array();

		if ( isset( $in['repo'] ) ) {
			$repo = trim( sanitize_text_field( $in['repo'] ) );
			$out['repo'] = preg_match( '#^[\w.-]+/[\w.-]+$#', $repo ) ? $repo : '';
		}
		if ( isset( $in['branch'] ) ) {
			$branch = trim( sanitize_text_field( $in['branch'] ) );
			$out['branch'] = preg_match( '#^[\w./-]{1,120}$#', $branch ) ? $branch : 'main';
		}
		if ( isset( $in['github_token'] ) ) {
			$tok = trim( $in['github_token'] );
			// keep the stored token if the field was left blank (masked on render)
			if ( $tok !== '' && $tok !== self::mask( $out['github_token'] ) ) {
				$out['github_token'] = sanitize_text_field( $tok );
			}
		}
		if ( isset( $in['webhook_secret'] ) ) {
			$sec = trim( $in['webhook_secret'] );
			if ( $sec !== '' && $sec !== self::mask( $out['webhook_secret'] ) ) {
				$out['webhook_secret'] = sanitize_text_field( $sec );
			}
		}
		if ( isset( $in['site_url'] ) ) {
			$out['site_url'] = esc_url_raw( trim( $in['site_url'] ) );
		}
		if ( isset( $in['health_paths'] ) ) {
			$lines = array();
			foreach ( preg_split( '/\r\n|\r|\n/', (string) $in['health_paths'] ) as $l ) {
				$l = trim( $l );
				if ( $l !== '' && $l[0] === '/' && ! preg_match( '#[\s<>"\']#', $l ) ) {
					$lines[] = $l;
				}
			}
			$out['health_paths'] = implode( "\n", array_slice( $lines, 0, 20 ) );
		}
		$out['armed'] = empty( $in['armed'] ) ? 0 : 1;

		return $out;
	}

	/** Show a token/secret as fixed-length dots so it's never echoed back. */
	public static function mask( $val ) {
		return $val ? str_repeat( '•', 12 ) : '';
	}

	public static function health_paths_array() {
		$raw = self::get( 'health_paths' );
		$out = array();
		foreach ( preg_split( '/\r\n|\r|\n/', (string) $raw ) as $l ) {
			$l = trim( $l );
			if ( $l !== '' ) {
				$out[] = $l;
			}
		}
		return $out;
	}

	public static function render() {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$o        = self::get();
		$endpoint = esc_url( rest_url( MORPHEUS_REST_NS . '/deploy' ) );
		$last     = get_option( 'morpheus_deploy_last', array() );
		$paired   = Morpheus_Pairing::is_paired();
		$code     = $paired ? '' : Morpheus_Pairing::current_code();
		$left     = $paired ? 0 : Morpheus_Pairing::seconds_left();
		$done     = isset( $_GET['morpheus_done'] ) ? sanitize_key( wp_unslash( $_GET['morpheus_done'] ) ) : '';
		?>
		<div class="wrap">
			<h1>Morpheus <span style="font-size:13px;color:#888;">v<?php echo esc_html( MORPHEUS_VERSION ); ?></span></h1>

			<?php if ( 'rotate' === $done ) : ?>
				<div class="notice notice-success is-dismissible"><p>New code issued. It is valid for 20 minutes and can be used once.</p></div>
			<?php elseif ( 'disconnect' === $done ) : ?>
				<div class="notice notice-warning is-dismissible"><p>Disconnected. Morpheus can no longer reach this site until you connect it again.</p></div>
			<?php endif; ?>

			<h2>Connect to Morpheus</h2>
			<?php if ( $paired ) : ?>
				<p style="color:#1f7a4d;"><strong>Connected.</strong> This site answers Morpheus requests signed with the shared secret set when it was paired.</p>
				<p>
					<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'options-general.php?page=morpheus&morpheus_pair_action=rotate' ), 'morpheus_pair_rotate' ) ); ?>">Issue a new code</a>
					<a class="button" href="<?php echo esc_url( wp_nonce_url( admin_url( 'options-general.php?page=morpheus&morpheus_pair_action=disconnect' ), 'morpheus_pair_disconnect' ) ); ?>" onclick="return confirm('Disconnect this site from Morpheus? Deploys and the Store/SEO panels stop working until you connect again.');">Disconnect</a>
				</p>
				<p class="description">Issuing a new code does not break the existing connection — the secret only changes when a code is actually used. Disconnecting clears the secret immediately.</p>
			<?php else : ?>
				<p>Type this code into Morpheus to connect this site. It is valid for <strong>20 minutes</strong>, can be used <strong>once</strong>, and five wrong attempts cancel it.</p>
				<p style="margin:18px 0;">
					<span id="morpheus-pair-code" style="font-family:Menlo,Consolas,monospace;font-size:30px;letter-spacing:4px;background:#f6f7f4;border:1px solid #dde3dd;border-radius:6px;padding:12px 18px;display:inline-block;"><?php echo esc_html( $code ); ?></span>
					<button type="button" class="button" style="margin-left:10px;vertical-align:middle;"
						onclick="navigator.clipboard.writeText('<?php echo esc_js( str_replace( '-', '', $code ) ); ?>').then(function(){this.textContent='Copied';}.bind(this));">Copy</button>
				</p>
				<p class="description">
					Expires in about <?php echo (int) ceil( $left / 60 ); ?> minute<?php echo $left > 60 ? 's' : ''; ?>.
					<a href="<?php echo esc_url( wp_nonce_url( admin_url( 'options-general.php?page=morpheus&morpheus_pair_action=rotate' ), 'morpheus_pair_rotate' ) ); ?>">Issue a new one</a>
					if it runs out — the code above is the only thing Morpheus needs from this screen.
				</p>
			<?php endif; ?>
			<p>Deploys code to this site from a connected GitHub repo — no FTP. Morpheus opens a pull request, and once its checks pass and it merges, it calls this endpoint:</p>
			<p><code><?php echo $endpoint; ?></code></p>
			<p style="color:<?php echo $o['armed'] ? '#1f7a4d' : '#b26a00'; ?>;">
				<strong><?php echo $o['armed'] ? 'Armed' : 'Not armed'; ?></strong> —
				<?php echo $o['armed']
					? 'a deploy request writes the changed files, health-checks the site, and rolls back on failure.'
					: 'a deploy request only reports what it would change. Nothing is written until you tick “Armed” below.'; ?>
			</p>

			<?php if ( ! empty( $last ) ) : ?>
				<h2>Last request</h2>
				<pre style="background:#f6f7f4;border:1px solid #dde3dd;padding:12px;overflow:auto;"><?php echo esc_html( wp_json_encode( $last, JSON_PRETTY_PRINT ) ); ?></pre>
			<?php endif; ?>

			<form method="post" action="options.php">
				<?php settings_fields( 'morpheus_deploy' ); ?>
				<table class="form-table" role="presentation">
					<tr>
						<th><label for="md-repo">GitHub repo</label></th>
						<td><input name="<?php echo self::OPTION; ?>[repo]" id="md-repo" type="text" class="regular-text" value="<?php echo esc_attr( $o['repo'] ); ?>" placeholder="owner/repo"></td>
					</tr>
					<tr>
						<th><label for="md-branch">Branch</label></th>
						<td><input name="<?php echo self::OPTION; ?>[branch]" id="md-branch" type="text" class="regular-text" value="<?php echo esc_attr( $o['branch'] ); ?>"></td>
					</tr>
					<tr>
						<th><label for="md-token">GitHub token</label></th>
						<td>
							<input name="<?php echo self::OPTION; ?>[github_token]" id="md-token" type="password" class="regular-text" value="<?php echo esc_attr( self::mask( $o['github_token'] ) ); ?>" autocomplete="off">
							<p class="description">A fine-grained token with <strong>Contents: read</strong> on the repo. Leave blank to keep the stored value.</p>
						</td>
					</tr>
					<tr>
						<th><label for="md-secret">Shared secret</label></th>
						<td>
							<input name="<?php echo self::OPTION; ?>[webhook_secret]" id="md-secret" type="password" class="regular-text" value="<?php echo esc_attr( self::mask( $o['webhook_secret'] ) ); ?>" autocomplete="off">
							<p class="description">
								Normally set for you by the pairing code above — you only need this field if you are matching a secret that was entered by hand on the Morpheus side.
								Every request is HMAC-SHA256 signed with it.
							</p>
						</td>
					</tr>
					<tr>
						<th><label for="md-siteurl">Site URL for health check</label></th>
						<td><input name="<?php echo self::OPTION; ?>[site_url]" id="md-siteurl" type="url" class="regular-text" value="<?php echo esc_attr( $o['site_url'] ); ?>" placeholder="<?php echo esc_attr( home_url() ); ?>"></td>
					</tr>
					<tr>
						<th><label for="md-health">Health-check paths</label></th>
						<td>
							<textarea name="<?php echo self::OPTION; ?>[health_paths]" id="md-health" rows="4" class="large-text code"><?php echo esc_textarea( $o['health_paths'] ); ?></textarea>
							<p class="description">One path per line. Checked after every deploy; a failure rolls the deploy back.</p>
						</td>
					</tr>
					<tr>
						<th>Armed</th>
						<td>
							<label><input name="<?php echo self::OPTION; ?>[armed]" type="checkbox" value="1" <?php checked( $o['armed'], 1 ); ?>> Let a deploy request write files</label>
							<p class="description">Off: the endpoint reports what it would change. On: it writes the changed files, health-checks the site, and restores a snapshot if anything breaks. Add <code>?dry=1</code> to the endpoint URL to force a report even when armed.</p>
						</td>
					</tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}
}
