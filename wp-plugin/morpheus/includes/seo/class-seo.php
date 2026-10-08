<?php
/**
 * The SEO module — Morpheus owns the site's SEO, with or without another
 * SEO plugin installed.
 *
 *   POST /wp-json/morpheus/v1/seo   { "action": "...", "data": { ... } }
 *
 * Signed the same way as /deploy and /store (HMAC-SHA256 over the raw body,
 * verified by Morpheus_REST::verified_body).
 *
 * WHY THIS EXISTS — and why "just write Yoast's fields" was the wrong call
 *
 * The Store module already writes Yoast's two postmeta keys, but it reports
 * `seo_available => defined('WPSEO_VERSION')` and the panel renders its SEO
 * fields only when that is true. So on a site without Yoast the operator gets
 * NO SEO AT ALL through the widget — the fields do not exist. That is a
 * dependency on someone else's plugin for a core capability, and it caps the
 * ceiling at whatever Yoast chooses to expose.
 *
 * Yoast's own numbers make the case sharper: the free plugin is free, but
 * Premium is $118.80/yr and AI+ is $358.80/yr, and Premium already includes
 * generated titles/descriptions and internal-link suggestions. Depending on it
 * means Morpheus cannot operate SEO unless the customer buys that.
 *
 * So Morpheus owns it. But there is one hard constraint that shapes the whole
 * design:
 *
 *   TWO PLUGINS EMITTING <title> AND META DESCRIPTION IS WORSE THAN ONE.
 *   Duplicate meta tags are actively harmful — search engines see two
 *   conflicting sources and pick for themselves.
 *
 * So the rule is:
 *
 *   - No third-party SEO plugin active  → Morpheus OWNS THE HEAD: it emits
 *     title, description, robots, Open Graph and Twitter tags itself, from its own
 *     postmeta, and OWNS THE CANONICAL rather than necessarily printing it: when
 *     core's own `rel_canonical()` is going to print a tag, ours is handed to it
 *     through core's `get_canonical_url` filter, so exactly one tag exists and its
 *     value is Morpheus's. Full control, all operable in the widget.
 *   - Yoast / Rank Math / AIOSEO / SEOPress active → Morpheus DRIVES THAT
 *     PLUGIN: it reads and writes that plugin's own keys so its output is what
 *     the widget controls, and emits nothing itself. No duplicates either way.
 *
 * Either way the widget has every field and every action. Which one is in
 * effect is reported as `owns_head` in seo_context, so the UI can say plainly
 * who is producing the tags.
 *
 * Actions:
 *   context       — who owns the head, active plugin, post types, counts,
 *                   site title/tagline, permalink structure, sitemap URL
 *   get_seo       — SEO fields for one post/page/product (by id or url)
 *   set_seo       — write fields for one item
 *   bulk_set_seo  — write fields for many at once (AI batches)
 *   list_content  — indexable content with its current SEO state
 *   read_content  — one item's title/excerpt/plain-text body, the grounding a
 *                   generator needs to WRITE new fields (bodies stay out of
 *                   list_content and bulk_set_seo so listings stay small)
 *   get_defaults  — the site-wide title/description templates
 *   set_defaults  — change them (tokens only: %title% %sitename% %tagline%
 *                   %excerpt% %content%; unknown tokens are removed)
 *   bulk_apply_defaults — write the templates into items that have nothing set
 *                   (dry_run returns what WOULD be written) — the path that
 *                   works even when another plugin owns the head
 *   bulk_add_links — wrap a phrase that ALREADY EXISTS in an item's text in a
 *                   link to another page on the same site (dry_run shows the
 *                   exact before/after context) — internal linking
 *   audit         — scan for real problems (missing/short/long/duplicate
 *                   titles and descriptions, noindex, thin content)
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

class Morpheus_SEO {

	// Our own meta keys. Prefixed so they can never collide with another
	// plugin's, and used only when Morpheus owns the head.
	const META_TITLE     = '_morpheus_seo_title';
	const META_DESC      = '_morpheus_seo_description';
	const META_KEYWORD   = '_morpheus_seo_focus_keyword';
	const META_CANONICAL = '_morpheus_seo_canonical';
	const META_ROBOTS    = '_morpheus_seo_robots';
	const META_OG_IMAGE  = '_morpheus_seo_og_image';
	// No META_SCHEMA: structured data is GENERATED from each item's own fields
	// by emit_schema(), so a stored override would be a field the emitter
	// ignores. Add one only alongside the code that reads it.

	// Content that can be indexed and therefore needs SEO. This used to be the
	// constant `array( 'post', 'page', 'product' )` — see
	// `morpheus_public_post_types()` in includes/helpers.php for why that is now
	// derived from the site instead: the live store publishes a `services` CPT and
	// a `portfolio` archive, and neither could be listed, audited or bulk-filled
	// here while the set was hard-coded.

	// Site-wide templates — the "Titles & Meta" defaults every SEO plugin has:
	// what the title and description look like for content nobody has set by
	// hand. Kept in their own option so the deploy settings screen's sanitiser
	// never has to know about them.
	const DEFAULTS_OPTION = 'morpheus_seo_defaults';

	// The only tokens a template may contain. Anything else is REMOVED rather
	// than left in place: a literal "%category%" sitting in a live <title> is
	// worse than the word simply not being there.
	const TEMPLATE_TOKENS = array( '%title%', '%sitename%', '%tagline%', '%excerpt%', '%content%' );

	// How much of a post's body %content% may contribute, and the longest a
	// stored template may be. Both bounds exist so a pasted essay or a runaway
	// script can't turn every page's <title> into nonsense.
	const CONTENT_WORDS = 30;
	const TEMPLATE_MAX  = 200;

	// Length guidance used by audit(). These are the widely-cited practical
	// limits, not hard rules: a title over ~60 chars is truncated in results,
	// a description over ~160 likewise.
	const TITLE_MIN = 15;
	const TITLE_MAX = 60;
	const DESC_MIN  = 70;
	const DESC_MAX  = 160;

	public static function register_routes() {
		register_rest_route( MORPHEUS_REST_NS, '/seo', array(
			'methods'             => 'POST',
			'permission_callback' => '__return_true',
			'callback'            => array( __CLASS__, 'handle' ),
		) );
	}

	public static function handle( WP_REST_Request $request ) {
		$body = Morpheus_REST::verified_body( $request );
		if ( $body instanceof WP_REST_Response ) {
			return $body;
		}
		$action = isset( $body['action'] ) ? sanitize_key( $body['action'] ) : '';
		$data   = isset( $body['data'] ) && is_array( $body['data'] ) ? $body['data'] : array();

		morpheus_log( 'seo', array( 'action' => $action ) );

		switch ( $action ) {
			case 'context':      $r = self::context(); break;
			case 'get_seo':      $r = self::get_action( $data ); break;
			case 'set_seo':      $r = self::set_action( $data ); break;
			case 'bulk_set_seo': $r = self::bulk_set_action( $data ); break;
			case 'list_content': $r = self::list_content( $data ); break;
			case 'read_content': $r = self::read_content( $data ); break;
			case 'get_defaults': $r = array( 'defaults' => self::get_defaults() ); break;
			case 'set_defaults': $r = self::set_defaults_action( $data ); break;
			case 'bulk_apply_defaults': $r = self::bulk_apply_defaults( $data ); break;
			case 'bulk_add_links': $r = self::bulk_add_links( $data ); break;
			case 'audit':        $r = self::audit( $data ); break;
			default:
				return Morpheus_REST::err( 'unknown_action', "Unknown seo action: {$action}", 400 );
		}

		if ( is_wp_error( $r ) ) {
			$d = $r->get_error_data();
			$s = is_array( $d ) && isset( $d['status'] ) ? $d['status'] : 422;
			return Morpheus_REST::err( $r->get_error_code(), $r->get_error_message(), $s );
		}

		// A cached page embeds the title, the description and the links, so a
		// write that does not clear the cache looks like it did nothing.
		if ( in_array( $action, array( 'set_seo', 'bulk_set_seo', 'bulk_apply_defaults', 'bulk_add_links' ), true ) ) {
			morpheus_purge_caches();
		}

		return new WP_REST_Response( array_merge( array( 'ok' => true, 'action' => $action ), $r ), 200 );
	}

	// ── who owns the head ──────────────────────────────────────────────────

	/**
	 * Which third-party SEO plugin is active, or null if none.
	 *
	 * Detection is by the plugin's own canonical constant/class rather than by
	 * checking for a particular file, because a site can install a plugin
	 * without activating it — "is the file present" is the wrong question.
	 */
	public static function active_plugin() {
		if ( defined( 'WPSEO_VERSION' ) ) {
			return 'yoast';
		}
		if ( defined( 'RANK_MATH_VERSION' ) || class_exists( 'RankMath' ) ) {
			return 'rankmath';
		}
		if ( defined( 'AIOSEO_VERSION' ) ) {
			return 'aioseo';
		}
		if ( defined( 'SEOPRESS_VERSION' ) ) {
			return 'seopress';
		}
		return null;
	}

	/** True when Morpheus is the thing producing the tags. */
	public static function owns_head() {
		return self::active_plugin() === null;
	}

	/**
	 * Where a given field lives for the ACTIVE plugin. Each plugin keeps the
	 * same concepts under different private keys; this is the one place that
	 * knows them, so every read and write below goes through it rather than
	 * spraying plugin-specific strings around.
	 *
	 * A null value means "this plugin has no separate key for that", in which
	 * case we fall back to our own meta rather than writing something the
	 * plugin will ignore — data in a key nothing reads is worse than no data.
	 */
	public static function keys_for( $plugin ) {
		switch ( $plugin ) {
			case 'yoast':
				return array(
					'title'     => '_yoast_wpseo_title',
					'desc'      => '_yoast_wpseo_metadesc',
					'keyword'   => '_yoast_wpseo_focuskw',
					'canonical' => '_yoast_wpseo_canonical',
					'robots'    => '_yoast_wpseo_meta-robots-noindex',
					'og_image'  => null,
				);
			case 'rankmath':
				return array(
					'title'     => 'rank_math_title',
					'desc'      => 'rank_math_description',
					'keyword'   => 'rank_math_focus_keyword',
					'canonical' => 'rank_math_canonical_url',
					'robots'    => 'rank_math_robots',
					'og_image'  => null,
				);
			case 'aioseo':
				return array(
					'title'     => '_aioseo_title',
					'desc'      => '_aioseo_description',
					'keyword'   => '_aioseo_keywords',
					'canonical' => '_aioseo_canonical_url',
					'robots'    => '_aioseo_robots_noindex',
					'og_image'  => '_aioseo_og_image_url',
				);
			case 'seopress':
				return array(
					'title'     => '_seopress_titles_title',
					'desc'      => '_seopress_titles_desc',
					'keyword'   => '_seopress_analysis_target_kw',
					'canonical' => '_seopress_robots_canonical',
					'robots'    => '_seopress_robots_index',
					'og_image'  => '_seopress_social_fb_img',
				);
			default:
				return array(
					'title'     => self::META_TITLE,
					'desc'      => self::META_DESC,
					'keyword'   => self::META_KEYWORD,
					'canonical' => self::META_CANONICAL,
					'robots'    => self::META_ROBOTS,
					'og_image'  => self::META_OG_IMAGE,
				);
		}
	}

	/** The key a field is stored under right now, ours or the active plugin's. */
	private static function key( $field ) {
		$keys = self::keys_for( self::active_plugin() );
		if ( isset( $keys[ $field ] ) && $keys[ $field ] ) {
			return $keys[ $field ];
		}
		// `self::META_$field` is not valid PHP — the constant has to be
		// resolved by name.
		return constant( 'self::META_' . strtoupper( $field ) );
	}

	// ── site-wide templates ────────────────────────────────────────────────

	/**
	 * What an un-set title/description looks like.
	 *
	 * The shipped defaults are deliberately useful rather than empty: every SEO
	 * plugin ships something like this, and "Page title | Site name" beats a
	 * bare page title in results. Nothing here overrides a value an operator
	 * (or the AI) has set on an item — a template only fills a gap.
	 *
	 * Description defaults to %excerpt%, which falls back to the first
	 * CONTENT_WORDS words of the body. An absent meta description is the most
	 * common real problem an audit finds, and WordPress's own derived value is
	 * what a search engine would improvise anyway — this just makes it
	 * deliberate and editable.
	 */
	public static function defaults() {
		$per_type = array();
		foreach ( morpheus_public_post_types() as $type ) {
			$per_type[ $type ] = array( 'title' => '', 'description' => '' );
		}
		return array(
			'enabled'     => true,
			'title'       => '%title% | %sitename%',
			'description' => '%excerpt%',
			'post_types'  => $per_type,
		);
	}

	/** The stored defaults, merged onto the shipped shape and sanitised. */
	public static function get_defaults() {
		$stored = get_option( self::DEFAULTS_OPTION, array() );
		$stored = is_array( $stored ) ? $stored : array();
		return self::sanitize_defaults( wp_parse_args( $stored, self::defaults() ) );
	}

	/**
	 * Coerce anything into a usable defaults array.
	 *
	 * Runs on BOTH write and read. On read it means a hand-edited option, an
	 * older shape from a previous version, or a partially-written value can
	 * never produce a broken <title> — the worst case is the shipped default.
	 */
	public static function sanitize_defaults( $raw ) {
		$raw  = is_array( $raw ) ? $raw : array();
		$base = self::defaults();
		$out  = array(
			'enabled'     => ! empty( $raw['enabled'] ) && 'false' !== $raw['enabled'] && '0' !== (string) $raw['enabled'],
			'title'       => self::clean_template( isset( $raw['title'] ) ? $raw['title'] : $base['title'] ),
			'description' => self::clean_template( isset( $raw['description'] ) ? $raw['description'] : $base['description'] ),
			'post_types'  => array(),
		);
		$per = isset( $raw['post_types'] ) && is_array( $raw['post_types'] ) ? $raw['post_types'] : array();
		foreach ( morpheus_public_post_types() as $type ) {
			$row = isset( $per[ $type ] ) && is_array( $per[ $type ] ) ? $per[ $type ] : array();
			$out['post_types'][ $type ] = array(
				'title'       => self::clean_template( isset( $row['title'] ) ? $row['title'] : '' ),
				'description' => self::clean_template( isset( $row['description'] ) ? $row['description'] : '' ),
			);
		}
		return $out;
	}

	/**
	 * One template string, made safe to store and print.
	 *
	 * Order matters: tags are stripped FIRST (so `%title%` inside markup can't
	 * survive as a bare token), then length is capped, then unknown tokens are
	 * removed. An unknown token is removed rather than escaped because leaving
	 * it would put literal "%category%" in a live title.
	 */
	public static function clean_template( $value ) {
		$s = wp_strip_all_tags( (string) $value );
		$s = trim( preg_replace( '/\s+/', ' ', $s ) );
		if ( mb_strlen( $s ) > self::TEMPLATE_MAX ) {
			$s = mb_substr( $s, 0, self::TEMPLATE_MAX );
		}
		// Remove only the tokens we do not understand. Stripping every %word%
		// (the first cut of this) deleted the valid tokens too, so every
		// template silently sanitised to an empty string.
		$s = preg_replace_callback(
			'/%[a-z_]+%/i',
			function ( $m ) {
				return in_array( strtolower( $m[0] ), self::TEMPLATE_TOKENS, true ) ? $m[0] : '';
			},
			$s
		);
		// Collapse again: removing a token from the middle leaves a double
		// space that would otherwise show up in the settings field.
		return trim( preg_replace( '/\s+/', ' ', $s ) );
	}

	/** The template that applies to one item: its post type's, then the site-wide one. */
	public static function template_for( $post_id, $field ) {
		$d = self::get_defaults();
		if ( empty( $d['enabled'] ) ) {
			return '';
		}
		$type = get_post_type( $post_id );
		if ( $type && isset( $d['post_types'][ $type ][ $field ] ) && $d['post_types'][ $type ][ $field ] !== '' ) {
			return $d['post_types'][ $type ][ $field ];
		}
		return isset( $d[ $field ] ) ? (string) $d[ $field ] : '';
	}

	/** First CONTENT_WORDS words of a post's body, plain text. */
	private static function content_excerpt( $post ) {
		$raw = preg_replace( '#<(?:h[1-6]|p|li|div|br|blockquote)(?:\s[^>]*)?/?>#i', ' ', (string) $post->post_content );
		$txt = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( strip_shortcodes( (string) $raw ) ) ) );
		if ( $txt === '' ) {
			return '';
		}
		$words = preg_split( '/\s+/', $txt );
		if ( count( $words ) > self::CONTENT_WORDS ) {
			$txt = implode( ' ', array_slice( $words, 0, self::CONTENT_WORDS ) ) . '…';
		}
		return $txt;
	}

	/**
	 * The site's own image: the Site Icon, or the custom logo — or nothing.
	 *
	 * ⚠️ ONE FUNCTION, TWO CALLERS, because the Organization schema node and an ARCHIVE's `og:image` want exactly
	 * the same picture, and "an empty og:image is worse than none" applies to both. A second copy of this lookup is
	 * a second place for the fallback order to differ.
	 */
	private static function site_image_url() {
		$logo = (string) get_site_icon_url( 512 );
		if ( $logo === '' ) {
			$custom = get_theme_mod( 'custom_logo' );
			if ( $custom ) {
				$logo = (string) wp_get_attachment_image_url( $custom, 'full' );
			}
		}
		return $logo;
	}

	/**
	 * Substitute the documented tokens. THE ONE PLACE the token list is applied.
	 *
	 * ⚠️ EXTRACTED SO AN ARCHIVE CAN USE IT. `apply_template()` needs a post id and an archive has none, so the
	 * alternative was a second `str_replace` over the same token list — and a second copy of a token list is how
	 * `%sitename%` ends up working in one place and printing literally in another.
	 *
	 * `%excerpt%` and `%content%` are separate arguments rather than one, because for a post they are different
	 * things (the hand-written excerpt, and the first words of the body) and collapsing them would change what
	 * every existing description says.
	 */
	private static function fill_template( $template, $title, $excerpt, $content ) {
		$out = str_replace(
			array( '%title%', '%sitename%', '%tagline%', '%excerpt%', '%content%' ),
			array(
				(string) $title,
				get_bloginfo( 'name' ),
				get_bloginfo( 'description' ),
				wp_strip_all_tags( (string) $excerpt ),
				wp_strip_all_tags( (string) $content ),
			),
			(string) $template
		);
		return trim( preg_replace( '/\s+/', ' ', $out ) );
	}

	/**
	 * Apply a template to one item.
	 *
	 * `%excerpt%` prefers the hand-written excerpt and falls back to the body,
	 * because a product's short description and a post's excerpt are exactly
	 * the sentence a description should be built from when there is one.
	 */
	public static function apply_template( $template, $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post ) {
			return '';
		}
		$excerpt = trim( (string) $post->post_excerpt );
		if ( $excerpt === '' ) {
			$excerpt = self::content_excerpt( $post );
		}
		return self::fill_template( $template, get_the_title( $post_id ), $excerpt, self::content_excerpt( $post ) );
	}

	/**
	 * Write the site-wide templates into items that have nothing set.
	 *
	 * This exists because a render-time template only helps when MORPHEUS emits
	 * the tags. On a site where Yoast owns the head, our template would never
	 * be consulted — so the operator gets an explicit, reviewable way to fill
	 * the gaps with the same values instead, which works with any plugin
	 * because it writes the per-item fields.
	 *
	 * `dry_run` returns exactly what WOULD be written without writing it, so the
	 * panel can show the values before anything lands on a live site.
	 */
	private static function bulk_apply_defaults( $data ) {
		$limit   = isset( $data['limit'] ) ? max( 1, min( 200, (int) $data['limit'] ) ) : 25;
		$dry     = ! empty( $data['dry_run'] );

		$args = array(
			'post_type'      => array_values( array_filter( morpheus_public_post_types(), 'post_type_exists' ) ),
			'post_status'    => array( 'publish', 'draft' ),
			'posts_per_page' => $limit,
			'orderby'        => 'modified',
			'order'          => 'DESC',
		);
		if ( ! $args['post_type'] ) {
			return array( 'preview' => array(), 'applied' => array(), 'failed' => array(), 'count' => 0, 'dry_run' => $dry, 'remaining' => 0 );
		}

		$preview = array();
		$applied = array();
		$failed  = array();
		$seen    = 0;

		foreach ( get_posts( $args ) as $p ) {
			$tpl_title = self::template_for( $p->ID, 'title' );
			$tpl_desc  = self::template_for( $p->ID, 'description' );
			$cur       = self::get_fields( $p->ID );
			if ( ! $cur ) {
				continue;
			}
			$write = array();
			// Only fill a gap: a value already on the item — written by the
			// operator, or by the AI — is never overwritten by a template.
			if ( $cur['seo_title'] === '' && $tpl_title !== '' ) {
				$v = self::apply_template( $tpl_title, $p->ID );
				if ( $v !== '' ) {
					$write['seo_title'] = $v;
				}
			}
			if ( $cur['seo_description'] === '' && $tpl_desc !== '' ) {
				$v = self::apply_template( $tpl_desc, $p->ID );
				if ( $v !== '' ) {
					$write['seo_description'] = $v;
				}
			}
			if ( ! $write ) {
				continue;
			}
			$seen++;
			$row = array_merge( array( 'id' => (int) $p->ID, 'title' => get_the_title( $p->ID ), 'type' => $p->post_type ), $write );
			$preview[] = $row;
			if ( $dry ) {
				continue;
			}
			$res = self::set_fields( $p->ID, $write );
			if ( is_wp_error( $res ) ) {
				$failed[] = array( 'id' => (int) $p->ID, 'error' => $res->get_error_message() );
			} else {
				$applied[] = $row;
			}
			if ( count( $preview ) >= $limit ) {
				break;
			}
		}

		return array(
			'preview'   => $preview,
			'applied'   => $applied,
			'failed'    => $failed,
			'count'     => $dry ? 0 : count( $applied ),
			'dry_run'   => $dry,
			'candidates'=> $seen,
			// Whether the cap was reached, so the panel can offer another pass
			// instead of implying the whole site was covered.
			'remaining' => max( 0, count( $preview ) >= $limit ? 1 : 0 ),
		);
	}

	/**
	 * Internal links: wrap a phrase that is ALREADY in an item's text.
	 *
	 * This is the operation every SEO plugin sells as internal linking, and it
	 * rewrites live content — so it refuses far more than it accepts:
	 *
	 *   * the anchor must exist VERBATIM in the item's own text (the caller is
	 *     an AI, and an invented phrase would either do nothing or corrupt a
	 *     sentence),
	 *   * only inside a text node — never inside an existing tag or another
	 *     link,
	 *   * a link to the same URL is never added twice,
	 *   * `dry_run` returns the exact sentence before and after, so what lands
	 *     on a live site has been seen first.
	 *
	 * The edit is one phrase wrapped in an <a>, nothing is deleted, and
	 * WordPress keeps a revision — which the harness asserts rather than
	 * assumes.
	 */
	private static function bulk_add_links( $data ) {
		$items = isset( $data['items'] ) && is_array( $data['items'] ) ? array_slice( $data['items'], 0, 25 ) : array();
		$dry   = ! empty( $data['dry_run'] );
		if ( ! $items ) {
			return new WP_Error( 'no_items', 'Provide items: [{id, anchor, url}].', array( 'status' => 400 ) );
		}

		$added   = array();
		$skipped = array();

		foreach ( $items as $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}
			$id     = isset( $item['id'] ) ? (int) $item['id'] : 0;
			$anchor = isset( $item['anchor'] ) ? trim( (string) $item['anchor'] ) : '';
			$url    = isset( $item['url'] ) ? esc_url_raw( trim( (string) $item['url'] ) ) : '';
			$post   = $id ? get_post( $id ) : null;

			$refuse = function ( $why ) use ( &$skipped, $id, $anchor ) {
				$skipped[] = array( 'id' => $id, 'anchor' => $anchor, 'reason' => $why );
			};

			if ( ! $post ) { $refuse( 'no such item' ); continue; }
			if ( $anchor === '' ) { $refuse( 'empty anchor' ); continue; }
			if ( mb_strlen( $anchor ) < 2 || mb_strlen( $anchor ) > 80 ) { $refuse( 'anchor length is outside 2-80 characters' ); continue; }
			if ( $url === '' ) { $refuse( 'empty url' ); continue; }
			// A page linking to itself is noise, not SEO.
			if ( untrailingslashit( $url ) === untrailingslashit( (string) get_permalink( $post ) ) ) { $refuse( 'the target is this page' ); continue; }
			// Already linked: checked as an href, not as a bare string — a URL
			// shown as plain text in the copy is not a link.
			if ( preg_match( '#<a[^>]+href=["\']' . preg_quote( $url, '#' ) . '["\']#i', (string) $post->post_content ) ) {
				$refuse( 'this page already links to that URL' );
				continue;
			}

			$linked = self::wrap_phrase( (string) $post->post_content, $anchor, $url );
			if ( is_wp_error( $linked ) ) { $refuse( $linked->get_error_message() ); continue; }

			$after = $linked['content'];
			$row    = array(
				'id'      => $id,
				'title'   => get_the_title( $id ),
				'anchor'  => $linked['matched'],
				'url'     => $url,
				'context' => self::link_context( $after, $url, $linked['matched'] ),
			);

			if ( $dry ) {
				$added[] = $row;
				continue;
			}

			$res = wp_update_post( array( 'ID' => $id, 'post_content' => $after ), true );
			if ( is_wp_error( $res ) ) {
				$refuse( $res->get_error_message() );
				continue;
			}
			// Reported, not assumed: the harness asserts a revision really
			// exists, because that is the operator's undo.
			$row['revision'] = count( wp_get_post_revisions( $id ) );
			$added[] = $row;
		}

		return array(
			'added'    => $added,
			'skipped'  => $skipped,
			'count'    => $dry ? 0 : count( $added ),
			'would'    => count( $added ),
			'dry_run'  => $dry,
			'revisions' => ! $dry,
		);
	}

	/**
	 * Wrap the first occurrence of `$anchor` that sits in a text node.
	 *
	 * Returns a WP_Error with the reason rather than a bare false, because
	 * "why was this refused" is the whole value of the dry run.
	 */
	private static function wrap_phrase( $content, $anchor, $url ) {
		// Split into tags and the text between them; only text is eligible.
		$parts    = preg_split( '/(<[^>]*>)/', $content, -1, PREG_SPLIT_DELIM_CAPTURE );
		$inside_a = false;
		foreach ( $parts as $i => $part ) {
			if ( $part === '' || $part === null ) {
				continue;
			}
			if ( $part[0] === '<' ) {
				if ( preg_match( '#^<a[\s>]#i', $part ) ) {
					$inside_a = true;
				} elseif ( preg_match( '#^</a#i', $part ) ) {
					$inside_a = false;
				}
				continue;
			}
			if ( $inside_a ) {
				continue;
			}
			$pos = mb_stripos( $part, $anchor );
			if ( $pos === false ) {
				continue;
			}
			$found      = mb_substr( $part, $pos, mb_strlen( $anchor ) );
			$parts[ $i ] = mb_substr( $part, 0, $pos )
				. '<a href="' . esc_url( $url ) . '">' . $found . '</a>'
				. mb_substr( $part, $pos + mb_strlen( $anchor ) );
			return array( 'content' => implode( '', $parts ), 'matched' => $found );
		}
		return new WP_Error( 'not_found', 'that phrase is not in the item text (or only inside an existing link)' );
	}

	/** The sentence the change landed in, so a dry run shows something human. */
	private static function link_context( $content, $url, $anchor ) {
		$needle = '<a href="' . esc_url( $url ) . '">' . $anchor . '</a>';
		$at     = strpos( $content, $needle );
		if ( $at === false ) {
			return '';
		}
		$start = max( 0, $at - 180 );
		$chunk = substr( $content, $start, 360 + strlen( $needle ) );
		return ( $start > 0 ? '…' : '' ) . $chunk . ( strlen( $chunk ) + $start < strlen( $content ) ? '…' : '' );
	}

	private static function set_defaults_action( $data ) {
		$current = self::get_defaults();
		$incoming = isset( $data['defaults'] ) && is_array( $data['defaults'] ) ? $data['defaults'] : $data;
		// Merge onto what is stored so a caller can change one field (the common
		// case from the widget) without having to echo the whole shape back.
		$merged = array_merge( $current, is_array( $incoming ) ? $incoming : array() );
		if ( isset( $incoming['post_types'] ) && is_array( $incoming['post_types'] ) ) {
			$merged['post_types'] = array_merge( $current['post_types'], $incoming['post_types'] );
		}
		$clean = self::sanitize_defaults( $merged );
		update_option( self::DEFAULTS_OPTION, $clean );
		return array( 'defaults' => $clean );
	}

	// ── read / write ───────────────────────────────────────────────────────

	/** Resolve an id-or-url to a post id, or 0. */
	private static function resolve_post( $data ) {
		if ( ! empty( $data['id'] ) ) {
			return (int) $data['id'];
		}
		if ( ! empty( $data['url'] ) ) {
			$id = url_to_postid( esc_url_raw( $data['url'] ) );
			if ( $id ) {
				return (int) $id;
			}
		}
		return 0;
	}

	/**
	 * Read every SEO field for one post, whichever plugin is authoritative.
	 *
	 * `title`/`desc` fall back to what WordPress would derive on its own (the
	 * post title and the excerpt) so the widget can show the operator what is
	 * ACTUALLY going out, rather than an empty box that hides a live value.
	 */
	public static function get_fields( $post_id ) {
		$post = get_post( $post_id );
		if ( ! $post ) {
			return null;
		}
		$plugin = self::active_plugin();
		$keys   = self::keys_for( $plugin );

		$raw = function ( $field ) use ( $keys, $post_id ) {
			$k = isset( $keys[ $field ] ) && $keys[ $field ] ? $keys[ $field ] : constant( 'self::META_' . strtoupper( $field ) );
			return (string) get_post_meta( $post_id, $k, true );
		};

		$title = $raw( 'title' );
		$desc  = $raw( 'desc' );

		$derived_title = get_the_title( $post_id );
		$derived_desc  = $post->post_excerpt ? wp_strip_all_tags( $post->post_excerpt ) : '';

		// A site-wide template fills the gap when nothing is set on the item.
		// It is resolved HERE rather than only at render time so the audit, the
		// content list and the emitter all agree on what actually goes out — an
		// audit that calls a templated title "missing" would be lying, and an
		// emitter that ignored the template would disagree with the panel.
		// ONLY when Morpheus produces the tags. With Yoast (or another SEO
		// plugin) active, that plugin's own title/description templates decide
		// what a search engine sees — reporting ours as the "effective" value
		// would tell the operator something false about their live site. On
		// those sites the templates are still usable: bulk_apply_defaults()
		// writes them into the items that have nothing set.
		$ours      = self::owns_head();
		$tpl_title = ( $ours && $title === '' ) ? self::template_for( $post_id, 'title' ) : '';
		$tpl_desc  = ( $ours && $desc === '' ) ? self::template_for( $post_id, 'description' ) : '';
		$inh_title = $tpl_title !== '' ? self::apply_template( $tpl_title, $post_id ) : '';
		$inh_desc  = $tpl_desc !== '' ? self::apply_template( $tpl_desc, $post_id ) : '';

		return array(
			'id'             => (int) $post_id,
			'type'           => $post->post_type,
			'status'         => $post->post_status,
			'url'            => get_permalink( $post_id ),
			'edit_url'       => get_edit_post_link( $post_id, 'raw' ),
			// What is set, and what would go out if nothing were set.
			'seo_title'      => $title,
			'seo_description'=> $desc,
			'effective_title'=> $title !== '' ? $title : ( $inh_title !== '' ? $inh_title : $derived_title ),
			'effective_description' => $desc !== '' ? $desc : ( $inh_desc !== '' ? $inh_desc : $derived_desc ),
			// Whether the effective value came from the site default rather than
			// from anything set on this item — the panel says so instead of
			// implying an operator wrote it.
			'inherited_title'       => $title === '' && $inh_title !== '',
			'inherited_description' => $desc === '' && $inh_desc !== '',
			'focus_keyword'  => $raw( 'keyword' ),
			'canonical'      => $raw( 'canonical' ),
			'noindex'        => self::is_noindex( $post_id ),
			'og_image'       => $raw( 'og_image' ),
			// Whether the values above came from us or from the active plugin,
			// so the UI can be honest about who is producing the tags.
			'source'         => $plugin ?: 'morpheus',
			'owns_head'      => self::owns_head(),
		);
	}

	/** Is this post set to noindex, per whichever plugin is authoritative? */
	public static function is_noindex( $post_id ) {
		$plugin = self::active_plugin();
		$keys   = self::keys_for( $plugin );
		$val    = (string) get_post_meta( $post_id, $keys['robots'], true );

		switch ( $plugin ) {
			case 'yoast':
				return $val === '1';            // Yoast stores "1" for noindex
			case 'seopress':
				return $val === 'no';           // SEOPress stores 'no' to de-index
			default:
				return in_array( strtolower( $val ), array( '1', 'noindex', 'no', 'true' ), true );
		}
	}

	/** Write the fields that were actually provided. Absent keys are left alone. */
	public static function set_fields( $post_id, $data ) {
		$post = get_post( $post_id );
		if ( ! $post ) {
			return new WP_Error( 'not_found', "No post with id {$post_id}.", array( 'status' => 404 ) );
		}

		$map = array(
			'title'     => 'seo_title',
			'desc'      => 'seo_description',
			'keyword'   => 'focus_keyword',
			'canonical' => 'canonical',
			'og_image'  => 'og_image',
		);

		foreach ( $map as $field => $input ) {
			if ( ! array_key_exists( $input, $data ) ) {
				continue;
			}
			$key = self::key( $field );
			if ( ! $key ) {
				continue; // the active plugin has nowhere to put this
			}
			$value = trim( (string) $data[ $input ] );
			if ( $value === '' ) {
				delete_post_meta( $post_id, $key );
			} elseif ( $field === 'canonical' || $field === 'og_image' ) {
				update_post_meta( $post_id, $key, esc_url_raw( $value ) );
			} else {
				update_post_meta( $post_id, $key, sanitize_text_field( $value ) );
			}
		}

		// noindex is stored differently per plugin, so it gets its own branch
		// rather than being squeezed into the generic loop.
		if ( array_key_exists( 'noindex', $data ) ) {
			$plugin = self::active_plugin();
			$key    = self::keys_for( $plugin )['robots'];
			$on     = (bool) $data['noindex'];
			if ( $plugin === 'yoast' ) {
				$on ? update_post_meta( $post_id, $key, '1' ) : delete_post_meta( $post_id, $key );
			} elseif ( $plugin === 'seopress' ) {
				$on ? update_post_meta( $post_id, $key, 'no' ) : delete_post_meta( $post_id, $key );
			} else {
				$on ? update_post_meta( $post_id, $key, '1' ) : delete_post_meta( $post_id, $key );
			}
		}

		return self::get_fields( $post_id );
	}

	// ── actions ────────────────────────────────────────────────────────────

	private static function context() {
		$active = self::active_plugin();
		$counts = array();
		foreach ( morpheus_public_post_types() as $type ) {
			if ( ! post_type_exists( $type ) ) {
				continue;
			}
			$c = wp_count_posts( $type );
			$counts[ $type ] = isset( $c->publish ) ? (int) $c->publish : 0;
		}

		return array(
			// The two facts the widget needs to explain itself honestly.
			'active_plugin' => $active,
			'owns_head'     => self::owns_head(),
			// WordPress has shipped its own sitemap since 5.5 — surfacing it
			// beats building a second one that would compete with it.
			'sitemap_url'   => home_url( '/wp-sitemap.xml' ),
			'blog_public'   => (int) get_option( 'blog_public' ) === 1,
			'site_title'    => get_bloginfo( 'name' ),
			'tagline'       => get_bloginfo( 'description' ),
			'permalink_structure' => get_option( 'permalink_structure' ),
			'post_types'    => morpheus_public_post_types(),
			'published_counts' => $counts,
			// The site-wide templates, so the panel can show and edit them.
			'defaults'      => self::get_defaults(),
			'tokens'        => self::TEMPLATE_TOKENS,
			'content_words' => self::CONTENT_WORDS,
			'limits'        => array(
				'title_min' => self::TITLE_MIN,
				'title_max' => self::TITLE_MAX,
				'desc_min'  => self::DESC_MIN,
				'desc_max'  => self::DESC_MAX,
			),
		);
	}

	private static function get_action( $data ) {
		$id = self::resolve_post( $data );
		if ( ! $id ) {
			return new WP_Error( 'not_found', 'Provide an id or a url that resolves to content.', array( 'status' => 404 ) );
		}
		return array( 'item' => self::get_fields( $id ) );
	}

	private static function set_action( $data ) {
		$id = self::resolve_post( $data );
		if ( ! $id ) {
			return new WP_Error( 'not_found', 'Provide an id or a url that resolves to content.', array( 'status' => 404 ) );
		}
		return array( 'item' => self::set_fields( $id, $data ) );
	}

	/**
	 * Apply many updates in one signed call — the shape AI generation produces
	 * (one pass over a content list). Per-item failures are collected rather
	 * than aborting the batch, because a partial apply the operator can see is
	 * more useful than a rolled-back nothing.
	 */
	private static function bulk_set_action( $data ) {
		$items = isset( $data['items'] ) && is_array( $data['items'] ) ? $data['items'] : array();
		if ( ! $items ) {
			return new WP_Error( 'no_items', 'Provide items: [{id, seo_title, seo_description, ...}].', array( 'status' => 400 ) );
		}
		$updated = array();
		$failed  = array();
		foreach ( $items as $item ) {
			if ( ! is_array( $item ) ) {
				continue;
			}
			$id = self::resolve_post( $item );
			if ( ! $id ) {
				$failed[] = array( 'id' => isset( $item['id'] ) ? $item['id'] : null, 'error' => 'not found' );
				continue;
			}
			$res = self::set_fields( $id, $item );
			if ( is_wp_error( $res ) ) {
				$failed[] = array( 'id' => $id, 'error' => $res->get_error_message() );
			} else {
				$updated[] = $res;
			}
		}
		return array( 'updated' => $updated, 'failed' => $failed, 'count' => count( $updated ) );
	}

	/** Indexable content with its current SEO state — the widget's main list. */
	private static function list_content( $data ) {
		$types  = isset( $data['types'] ) && is_array( $data['types'] ) ? array_map( 'sanitize_key', $data['types'] ) : morpheus_public_post_types();
		$types  = array_values( array_filter( $types, 'post_type_exists' ) );
		$limit  = isset( $data['limit'] ) ? max( 1, min( 200, (int) $data['limit'] ) ) : 50;
		$search = isset( $data['search'] ) ? sanitize_text_field( $data['search'] ) : '';

		if ( ! $types ) {
			return array( 'items' => array(), 'count' => 0 );
		}

		$args = array(
			'post_type'      => $types,
			'post_status'    => array( 'publish', 'draft' ),
			'posts_per_page' => $limit,
			'orderby'        => 'modified',
			'order'          => 'DESC',
		);
		if ( $search !== '' ) {
			$args['s'] = $search;
		}

		$items = array();
		foreach ( get_posts( $args ) as $p ) {
			$f = self::get_fields( $p->ID );
			// Only the fields the list view needs — a content list is not the
			// place to ship every post's body back over the wire.
			$items[] = array(
				'id'                    => $f['id'],
				'type'                  => $f['type'],
				'status'                => $f['status'],
				'title'                 => get_the_title( $p->ID ),
				'url'                   => $f['url'],
				'seo_title'             => $f['seo_title'],
				'seo_description'       => $f['seo_description'],
				'effective_title'       => $f['effective_title'],
				'effective_description' => $f['effective_description'],
				'inherited_title'       => $f['inherited_title'],
				'inherited_description' => $f['inherited_description'],
				'focus_keyword'         => $f['focus_keyword'],
				'noindex'               => $f['noindex'],
				'modified'              => $p->post_modified_gmt,
				'word_count'            => str_word_count( wp_strip_all_tags( $p->post_content ) ),
			);
		}

		return array( 'items' => $items, 'count' => count( $items ) );
	}

	/**
	 * The text a generator needs in order to WRITE SEO for one item: its title,
	 * excerpt and a trimmed plain-text body.
	 *
	 * Kept out of get_seo() and list_content() on purpose — writing a good
	 * title needs the body, but nobody wants dozens of post bodies riding back
	 * on a list or a bulk_set_seo response. The caller asks for this only for
	 * the items it is actually generating for.
	 */
	private static function read_content( $data ) {
		$id = self::resolve_post( $data );
		if ( ! $id ) {
			return new WP_Error( 'not_found', 'Provide an id or a url that resolves to content.', array( 'status' => 404 ) );
		}
		$post = get_post( $id );
		if ( ! $post ) {
			return new WP_Error( 'not_found', "No post with id {$id}.", array( 'status' => 404 ) );
		}

		// Block-level tags become a separator BEFORE the tags are stripped.
		// Without this, "</h2><p>We repair…" collapses to "properlyWe repair…",
		// which is exactly the kind of mangled text that makes a generator
		// produce a title about the wrong thing.
		$raw = preg_replace( '#<(?:h[1-6]|p|li|ul|ol|div|section|article|br|tr|td|th|blockquote|figcaption)(?:\s[^>]*)?/?>#i', "\n", (string) $post->post_content );
		$raw = preg_replace( '#</(?:h[1-6]|p|li|ul|ol|div|section|article|tr|td|th|blockquote|figcaption)>#i', "\n", $raw );
		$text  = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( strip_shortcodes( $raw ) ) ) );
		$limit = isset( $data['chars'] ) ? max( 200, min( 6000, (int) $data['chars'] ) ) : 1500;

		return array(
			'item' => array(
				'id'             => (int) $id,
				'type'           => $post->post_type,
				'status'         => $post->post_status,
				'title'          => get_the_title( $id ),
				'url'            => get_permalink( $id ),
				'excerpt'        => wp_strip_all_tags( (string) $post->post_excerpt ),
				'content_text'   => mb_substr( $text, 0, $limit ),
				'content_length' => mb_strlen( $text ),
				'word_count'     => str_word_count( $text ),
				'truncated'      => mb_strlen( $text ) > $limit,
			),
		);
	}

	/**
	 * Find real, fixable problems. Deliberately limited to things that are
	 * unambiguous and actionable — a vague "SEO score" that cannot say what to
	 * change is worse than no score, because it invites optimisation theatre.
	 */
	private static function audit( $data ) {
		$list = self::list_content( array_merge( $data, array( 'limit' => isset( $data['limit'] ) ? $data['limit'] : 100 ) ) );
		$issues   = array();
		$by_title = array();
		$by_desc  = array();

		foreach ( $list['items'] as $it ) {
			$id = $it['id'];
			$t  = (string) $it['effective_title'];
			$d  = (string) $it['effective_description'];

			if ( $it['status'] === 'publish' ) {
				if ( trim( $t ) === '' ) {
					$issues[] = array( 'id' => $id, 'severity' => 'high', 'code' => 'missing_title', 'message' => 'No SEO title — search results will use the post title verbatim.' );
				} elseif ( mb_strlen( $t ) > self::TITLE_MAX ) {
					$issues[] = array( 'id' => $id, 'severity' => 'medium', 'code' => 'title_too_long', 'message' => 'Title is ' . mb_strlen( $t ) . ' characters; results truncate around ' . self::TITLE_MAX . '.' );
				} elseif ( mb_strlen( $t ) < self::TITLE_MIN ) {
					$issues[] = array( 'id' => $id, 'severity' => 'low', 'code' => 'title_too_short', 'message' => 'Title is only ' . mb_strlen( $t ) . ' characters — there is room to say more.' );
				}

				if ( trim( $d ) === '' ) {
					$issues[] = array( 'id' => $id, 'severity' => 'high', 'code' => 'missing_description', 'message' => 'No meta description — the search engine will invent one.' );
				} elseif ( mb_strlen( $d ) > self::DESC_MAX ) {
					$issues[] = array( 'id' => $id, 'severity' => 'medium', 'code' => 'description_too_long', 'message' => 'Description is ' . mb_strlen( $d ) . ' characters; results truncate around ' . self::DESC_MAX . '.' );
				} elseif ( mb_strlen( $d ) < self::DESC_MIN ) {
					$issues[] = array( 'id' => $id, 'severity' => 'low', 'code' => 'description_too_short', 'message' => 'Description is only ' . mb_strlen( $d ) . ' characters — there is room to say more.' );
				}

				if ( $it['word_count'] > 0 && $it['word_count'] < 300 ) {
					$issues[] = array( 'id' => $id, 'severity' => 'low', 'code' => 'thin_content', 'message' => 'Only ' . $it['word_count'] . ' words of content.' );
				}

				if ( $it['focus_keyword'] === '' ) {
					$issues[] = array( 'id' => $id, 'severity' => 'low', 'code' => 'no_focus_keyword', 'message' => 'No focus keyword set, so nothing is being targeted deliberately.' );
				} elseif ( $t !== '' && mb_stripos( $t, $it['focus_keyword'] ) === false ) {
					$issues[] = array( 'id' => $id, 'severity' => 'medium', 'code' => 'keyword_not_in_title', 'message' => "Focus keyword \"{$it['focus_keyword']}\" does not appear in the title." );
				}
			}

			if ( $it['noindex'] ) {
				$issues[] = array( 'id' => $id, 'severity' => 'high', 'code' => 'noindex', 'message' => 'This item is set to noindex — it is published but will not appear in search.' );
			}

			// Duplicates are only a problem for identical NON-empty values.
			if ( trim( $t ) !== '' ) {
				$by_title[ $t ][] = $id;
			}
			if ( trim( $d ) !== '' ) {
				$by_desc[ $d ][] = $id;
			}
		}

		foreach ( $by_title as $text => $ids ) {
			if ( count( $ids ) > 1 ) {
				foreach ( $ids as $id ) {
					$issues[] = array( 'id' => $id, 'severity' => 'high', 'code' => 'duplicate_title', 'message' => 'This title is shared with ' . ( count( $ids ) - 1 ) . ' other item(s): "' . mb_substr( $text, 0, 60 ) . '"' );
				}
			}
		}
		foreach ( $by_desc as $text => $ids ) {
			if ( count( $ids ) > 1 ) {
				foreach ( $ids as $id ) {
					$issues[] = array( 'id' => $id, 'severity' => 'medium', 'code' => 'duplicate_description', 'message' => 'This description is shared with ' . ( count( $ids ) - 1 ) . ' other item(s).' );
				}
			}
		}

		$counts = array( 'high' => 0, 'medium' => 0, 'low' => 0 );
		foreach ( $issues as $i ) {
			$counts[ $i['severity'] ]++;
		}

		return array(
			'issues'      => $issues,
			'counts'      => $counts,
			'scanned'     => $list['count'],
			'owns_head'   => self::owns_head(),
			'active_plugin' => self::active_plugin(),
		);
	}

	// ── emission: only when Morpheus owns the head ─────────────────────────

	/**
	 * Hook everything that produces tags. Called from morpheus.php on `init`,
	 * and short-circuits entirely when another SEO plugin is active — that is
	 * the duplicate-tag rule, enforced in one place.
	 */
	public static function bootstrap() {
		if ( ! self::owns_head() ) {
			return;
		}
		add_filter( 'pre_get_document_title', array( __CLASS__, 'filter_title' ), 20 );
		add_action( 'wp_head', array( __CLASS__, 'emit_head' ), 1 );
		add_filter( 'robots_txt', array( __CLASS__, 'filter_robots_txt' ), 20, 2 );
		// A removed SEO plugin leaves its own sitemap path 404ing while robots.txt
		// (often cached for a month), Search Console submissions and third-party
		// links still point at it. Serve the old path — bootstrap() runs on `init`,
		// which is the hook add_rewrite_rule() requires.
		add_action( 'template_redirect', array( __CLASS__, 'maybe_redirect_legacy_sitemap' ) );
		self::register_legacy_sitemap_redirect();
	}

	/** Our title replaces the derived one for a singular view. */
	public static function filter_title( $title ) {
		if ( ! is_singular() ) {
			return $title;
		}
		$id     = get_queried_object_id();
		$custom = get_post_meta( $id, self::META_TITLE, true );
		if ( $custom !== '' ) {
			return $custom;
		}
		$tpl = self::template_for( $id, 'title' );
		if ( $tpl !== '' ) {
			$applied = self::apply_template( $tpl, $id );
			if ( $applied !== '' ) {
				return $applied;
			}
		}
		return $title;
	}

	/**
	 * The tags Morpheus is responsible for. Everything here is escaped at the
	 * point of output — these values are operator- and AI-authored, so they
	 * are untrusted input as far as the theme is concerned.
	 */
	public static function emit_head() {
		if ( ! is_singular() ) {
			// ⭐ THE OTHER HALF OF OWNING THE HEAD. On a site where Morpheus owns it (`owns_head` true, no SEO
			// plugin active), what this function skips, NOBODY emits — and it used to skip every archive: the
			// shop, product categories, tags, the blog index. Measured on the live store before this branch
			// existed: `/shop/` had title 1, description 0, canonical 0, og 0, twitter 0.
			//
			// ⚠️ IT MATTERS MOST ON A WOOCOMMERCE STORE, which is where the URLs multiply: `?orderby=`,
			// `?filter_…` and `?paged=` are the near-duplicate addresses a self-referencing canonical exists to
			// collapse, and there were none on any of them.
			if ( self::is_archive_view() ) {
				self::emit_archive_head();
			}
			return;
		}
		$id = get_queried_object_id();
		$f  = self::get_fields( $id );
		if ( ! $f ) {
			return;
		}

		$title = (string) $f['effective_title'];
		$desc  = (string) $f['effective_description'];
		$url   = (string) $f['url'];
		$image = (string) $f['og_image'];

		if ( $f['noindex'] ) {
			echo "\n\t<meta name=\"robots\" content=\"noindex, nofollow\" />\n";
		}
		if ( $desc !== '' ) {
			echo "\n\t<meta name=\"description\" content=\"" . esc_attr( wp_strip_all_tags( $desc ) ) . "\" />\n";
		}
		// ⚠️ ONE CANONICAL TAG, AND WE OWN ITS VALUE — not necessarily the tag.
		//
		// WordPress core hooks its own `rel_canonical()` onto `wp_head` at priority 10, and we emit at priority 1,
		// so printing our own tag produced TWO identical `<link rel="canonical">` tags on every singular view —
		// which the live store's homepage did, verified by fetching it. Two canonical tags are a defect even when
		// they agree: a consumer has to decide which to believe, and the day they disagree is the day the wrong
		// URL gets indexed.
		//
		// The fix is not to delete anybody's tag. It is to decide WHO OWNS WHAT: when core is going to print one,
		// we hand it OUR value through core's own `get_canonical_url` filter and print nothing ourselves. One tag,
		// our value, no deletion — and if something has removed core's callback, we print it as before.
		$canonical = $f['canonical'] !== '' ? $f['canonical'] : $url;
		if ( $canonical ) {
			if ( self::core_prints_canonical() ) {
				// Added here, at priority 1, so it is in place well before core's callback runs at 10.
				add_filter( 'get_canonical_url', static function () use ( $canonical ) {
					return $canonical;
				}, 20 );
			} else {
				echo "\t<link rel=\"canonical\" href=\"" . esc_url( $canonical ) . "\" />\n";
			}
		}

		// Open Graph + Twitter. og:image is only emitted when there IS one —
		// an empty og:image is worse than none, since scrapers cache it.
		echo "\t<meta property=\"og:type\" content=\"" . ( is_singular( 'post' ) ? 'article' : 'website' ) . "\" />\n";
		echo "\t<meta property=\"og:title\" content=\"" . esc_attr( $title ) . "\" />\n";
		if ( $desc !== '' ) {
			echo "\t<meta property=\"og:description\" content=\"" . esc_attr( wp_strip_all_tags( $desc ) ) . "\" />\n";
		}
		echo "\t<meta property=\"og:url\" content=\"" . esc_url( $url ) . "\" />\n";
		echo "\t<meta property=\"og:site_name\" content=\"" . esc_attr( get_bloginfo( 'name' ) ) . "\" />\n";
		if ( $image !== '' ) {
			echo "\t<meta property=\"og:image\" content=\"" . esc_url( $image ) . "\" />\n";
		}
		echo "\t<meta name=\"twitter:card\" content=\"" . ( $image !== '' ? 'summary_large_image' : 'summary' ) . "\" />\n";
		echo "\t<meta name=\"twitter:title\" content=\"" . esc_attr( $title ) . "\" />\n";
		if ( $desc !== '' ) {
			echo "\t<meta name=\"twitter:description\" content=\"" . esc_attr( wp_strip_all_tags( $desc ) ) . "\" />\n";
		}

		self::emit_schema( $id, $f );
	}

	/**
	 * Is this a view Morpheus should describe but which is NOT a single post?
	 *
	 * ⚠️ SEARCH AND 404 ARE DELIBERATELY OUT. A 404 must never carry a canonical — the whole point of a 404 is
	 * that there is nothing canonical here — and a search result page is a query, not a page. Both are left to
	 * the theme, which is where the decision belongs.
	 */
	private static function is_archive_view() {
		if ( is_search() || is_404() || is_feed() ) {
			return false;
		}
		// `is_home()` is the blog index when a static front page is set; `is_archive()` covers categories, tags,
		// custom taxonomies (product_cat, product_tag), post type archives (`/shop/`), authors and dates.
		return is_home() || is_archive();
	}

	/**
	 * The canonical URL of an archive: its own address, WITHOUT any query string.
	 *
	 * ⭐ THE STRIPPING IS THE FEATURE. `?orderby=price`, `?filter_colour=red` and every other facet WooCommerce
	 * offers are the same page sorted or filtered differently, and a crawler that finds twelve of them indexes
	 * twelve near-copies. Building the URL from the archive's own permalink rather than from `REQUEST_URI` is what
	 * collapses them — `get_pagenum_link()` would not, because it keeps the query string.
	 *
	 * ⚠️ AND WE ARE THE ONLY EMITTER HERE. Core's `rel_canonical()` is SINGULAR-ONLY — it returns before printing
	 * on an archive — so unlike the singular path there is nobody to hand the value to and nobody to duplicate.
	 * That is also why this does not go through `core_prints_canonical()`: it would answer "yes, core will print
	 * one" and we would print nothing, leaving the archive with no canonical at all. Verified against the live
	 * site, where `/shop/` rendered zero canonical tags before this existed.
	 */
	private static function archive_canonical() {
		$base = '';
		if ( is_home() ) {
			$posts_page = (int) get_option( 'page_for_posts' );
			$base       = $posts_page ? (string) get_permalink( $posts_page ) : home_url( '/' );
		} elseif ( is_category() || is_tag() || is_tax() ) {
			$term = get_queried_object();
			if ( $term instanceof WP_Term ) {
				$link = get_term_link( $term );
				if ( ! is_wp_error( $link ) ) {
					$base = (string) $link;
				}
			}
		} elseif ( is_post_type_archive() ) {
			$type = get_query_var( 'post_type' );
			if ( is_array( $type ) ) {
				$type = reset( $type );
			}
			$base = (string) get_post_type_archive_link( (string) $type );
		} elseif ( is_author() ) {
			$base = (string) get_author_posts_url( (int) get_queried_object_id() );
		} elseif ( is_year() || is_month() || is_day() ) {
			$y = (int) get_query_var( 'year' );
			$m = (int) get_query_var( 'monthnum' );
			$d = (int) get_query_var( 'day' );
			if ( $y && $m && $d ) {
				$base = (string) get_day_link( $y, $m, $d );
			} elseif ( $y && $m ) {
				$base = (string) get_month_link( $y, $m );
			} elseif ( $y ) {
				$base = (string) get_year_link( $y );
			}
		}
		if ( $base === '' ) {
			return '';
		}
		// Paged archives point at THEMSELVES, not at page one: page 3 of a category is a real page with its own
		// content, and telling a search engine it is page one is how pages get dropped from the index.
		$paged = max( 1, (int) get_query_var( 'paged' ) );
		if ( $paged > 1 ) {
			$base = trailingslashit( $base ) . user_trailingslashit( 'page/' . $paged );
		}
		return $base;
	}

	/** The archive's own name, without WordPress's "Category: " prefix — what `%title%` means in a template. */
	private static function archive_title() {
		if ( is_category() || is_tag() || is_tax() ) {
			return (string) single_term_title( '', false );
		}
		if ( is_post_type_archive() ) {
			return (string) post_type_archive_title( '', false );
		}
		if ( is_author() ) {
			return (string) get_the_author_meta( 'display_name', (int) get_queried_object_id() );
		}
		if ( is_home() ) {
			$posts_page = (int) get_option( 'page_for_posts' );
			return $posts_page ? (string) get_the_title( $posts_page ) : (string) get_bloginfo( 'name' );
		}
		return (string) get_the_archive_title();
	}

	/**
	 * The page that carries a post-type archive's own copy, when there is one — or null.
	 *
	 * ⚠️ WOOCOMMERCE KEEPS `/shop/`'s WORDS ON A REAL PAGE, and that is the only place an operator can write
	 * them: the `product` post type itself has no description, so `/shop/` and `/shop/page/2/` rendered with no
	 * meta description at all while `/blog/` and `/` had one — verified by fetching the live store, 2026-10-07.
	 * The page is not synthesised and nothing is generated from the product list; it is the same page WordPress
	 * serves the archive from, so its words are the operator's own, which is the rule this whole chain follows.
	 */
	private static function archive_backing_page() {
		if ( ! is_post_type_archive() ) {
			return null;
		}
		$type = get_query_var( 'post_type' );
		if ( is_array( $type ) ) {
			$type = reset( $type );
		}
		// Only WooCommerce's shop is known to work this way. Another post type would need its own mapping
		// here rather than a guess, because a wrong page is a wrong description on a live site.
		if ( 'product' !== (string) $type || ! function_exists( 'wc_get_page_id' ) ) {
			return null;
		}
		$id = (int) wc_get_page_id( 'shop' );
		if ( $id <= 0 ) {
			return null;
		}
		$page = get_post( $id );
		return $page instanceof WP_Post ? $page : null;
	}

	/**
	 * Plain text for a meta tag, from a source that may be RICH: shortcodes rendered, tags stripped,
	 * whitespace collapsed, and cut at the length a meta description is actually for.
	 *
	 * ⚠️ RENDERED, NOT DISCARDED — THE LITERAL SHORTCODE WAS LIVE. A product category's description on the store
	 * is the page-builder shortcode `[html_block id="2419"]`, and `wp_strip_all_tags` does not run shortcodes, so
	 * those characters reached three tags on `/product-category/backline/`:
	 *
	 *     <meta name="description" content="[html_block id=&quot;2419&quot;]" />
	 *
	 * — fetched from the live site, 2026-10-07, which is how it was found. Rendering the operator's own block is
	 * what turns that tag back into a sentence; simply stripping it would leave the archive with NO description
	 * instead, which is why this does not just widen the strip.
	 *
	 * ⚠️ `strip_shortcodes()` IS NOT ENOUGH ON ITS OWN, AND THE HARNESS PROVED IT. It builds its pattern from
	 * `$shortcode_tags` — the REGISTERED shortcodes — so `[a_plugin_that_was_deactivated id="1"]` passes it
	 * through untouched and reaches the tag as those characters. That is the same defect one step further out,
	 * so a leftover shortcode-shaped token is removed by pattern. It cannot be told apart from a bracketed word
	 * like `[sic]`; a leaked shortcode in a search result is the worse of the two, so the token goes.
	 *
	 * `wp_html_excerpt()` is what truncates, not `substr`: it cuts on a word boundary and respects multibyte
	 * text, and the live block's own first sentence is well past a search result's width.
	 */
	private static function plain_text( $raw ) {
		$raw = (string) $raw;
		if ( $raw === '' ) {
			return '';
		}
		if ( strpos( $raw, '[' ) !== false ) {
			$raw = do_shortcode( $raw );
			$raw = strip_shortcodes( $raw );
			$raw = preg_replace( '/\[[a-z0-9_-]+(?:\s[^\]]*)?\]/i', ' ', $raw );
		}
		$txt = trim( preg_replace( '/\s+/', ' ', wp_strip_all_tags( $raw ) ) );
		if ( $txt === '' ) {
			return '';
		}
		return trim( wp_html_excerpt( $txt, self::DESC_MAX, '…' ) );
	}

	/**
	 * What an archive should say about itself — from a real source, in order, or nothing.
	 *
	 * ⚠️ FOUR SOURCES AND NO FIFTH. The term's own description is what somebody wrote about THAT category; a
	 * post-type archive's own PAGE is what somebody wrote about the shop; the site-wide description template is
	 * what the operator asked for by name; the tagline is a sentence that already exists. If all four are empty
	 * the tag is omitted rather than filled with a generated sentence — the same rule as `og:image` and the same
	 * rule as the schema, and for the same reason: a claim nobody made.
	 */
	private static function archive_description() {
		if ( is_category() || is_tag() || is_tax() ) {
			$term = get_queried_object();
			if ( $term instanceof WP_Term ) {
				$own = self::plain_text( term_description( $term->term_id, $term->taxonomy ) );
				if ( $own !== '' ) {
					return $own;
				}
			}
		}
		$page = self::archive_backing_page();
		if ( $page ) {
			// The operator's own field first, then the excerpt, then the body — the same order
			// `apply_template()` uses, so a value set in the SEO panel beats the raw page copy.
			foreach ( array( get_post_meta( $page->ID, self::META_DESC, true ), $page->post_excerpt, $page->post_content ) as $raw ) {
				$own = self::plain_text( $raw );
				if ( $own !== '' ) {
					return $own;
				}
			}
		}
		$d = self::get_defaults();
		if ( ! empty( $d['enabled'] ) && ! empty( $d['description'] ) ) {
			$applied = self::fill_template( $d['description'], self::archive_title(), '', '' );
			if ( $applied !== '' ) {
				return $applied;
			}
		}
		$tagline = trim( (string) get_bloginfo( 'description' ) );
		return $tagline === '' ? '' : $tagline;
	}

	/**
	 * The head for an archive: the same set of tags as a single view, from the archive's own sources.
	 *
	 * ⚠️ NO `robots` TAG, AND NO SCHEMA. The theme emits its own robots meta on these pages (measured on the live
	 * `/shop/`), so a second one is the duplicate-tag defect this module exists to prevent — and a
	 * `BreadcrumbList` or `LocalBusiness` here would duplicate the theme's, which is the duplicate-ENTITY version
	 * of the same mistake. What is missing on an archive is the canonical, the description and the social tags,
	 * so that is exactly what this emits.
	 */
	private static function emit_archive_head() {
		$canonical   = self::archive_canonical();
		$title       = (string) wp_get_document_title();
		$description = self::archive_description();
		$image       = self::site_image_url();

		if ( $canonical !== '' ) {
			echo "\t<link rel=\"canonical\" href=\"" . esc_url( $canonical ) . "\" />\n";
		}
		if ( $description !== '' ) {
			echo "\t<meta name=\"description\" content=\"" . esc_attr( $description ) . "\" />\n";
		}
		// `website` rather than `article`: an archive is not a piece of content with an author and a date, and
		// saying it is confuses the thing that reads the tag.
		echo "\t<meta property=\"og:type\" content=\"website\" />\n";
		echo "\t<meta property=\"og:title\" content=\"" . esc_attr( $title ) . "\" />\n";
		if ( $description !== '' ) {
			echo "\t<meta property=\"og:description\" content=\"" . esc_attr( $description ) . "\" />\n";
		}
		if ( $canonical !== '' ) {
			echo "\t<meta property=\"og:url\" content=\"" . esc_url( $canonical ) . "\" />\n";
		}
		echo "\t<meta property=\"og:site_name\" content=\"" . esc_attr( get_bloginfo( 'name' ) ) . "\" />\n";
		if ( $image !== '' ) {
			echo "\t<meta property=\"og:image\" content=\"" . esc_url( $image ) . "\" />\n";
		}
		echo "\t<meta name=\"twitter:card\" content=\"" . ( $image !== '' ? 'summary_large_image' : 'summary' ) . "\" />\n";
		echo "\t<meta name=\"twitter:title\" content=\"" . esc_attr( $title ) . "\" />\n";
		if ( $description !== '' ) {
			echo "\t<meta name=\"twitter:description\" content=\"" . esc_attr( $description ) . "\" />\n";
		}
	}

	/**
	 * JSON-LD structured data. Kept small and honest: Article for posts,
	 * Product for products (when WooCommerce gives us a price), WebPage
	 * otherwise — plus the site's OWN entity, which describes the site rather
	 * than the page and so belongs on every page.
	 *
	 * Two things this deliberately does not do:
	 *
	 *   * No `LocalBusiness`/`Store` node. Our address, phone and opening hours
	 *     are not in WooCommerce's store options, and a storefront entity
	 *     without them is a partial one — see `site_entity_nodes()` and the
	 *     schema rules in the build library's seo card. (This doc-comment used
	 *     to claim an organization node was emitted here when none was. It is
	 *     emitted now; the comment and the code agree.)
	 *   * No invented ratings, review counts or offers.
	 */
	private static function emit_schema( $post_id, $f ) {
		$type = 'WebPage';
		if ( get_post_type( $post_id ) === 'post' ) {
			$type = 'Article';
		} elseif ( get_post_type( $post_id ) === 'product' ) {
			$type = 'Product';
		}

		$node = array(
			'@context'    => 'https://schema.org',
			'@type'       => $type,
			'name'        => $f['effective_title'],
			'url'         => $f['url'],
		);
		if ( $f['effective_description'] !== '' ) {
			$node['description'] = wp_strip_all_tags( $f['effective_description'] );
		}
		if ( $type === 'Product' && function_exists( 'wc_get_product' ) ) {
			$p = wc_get_product( $post_id );
			if ( $p ) {
				$node['sku'] = $p->get_sku();
				$price = $p->get_price();
				if ( $price !== '' ) {
					$node['offers'] = array(
						'@type'         => 'Offer',
						'price'         => $price,
						'priceCurrency' => function_exists( 'get_woocommerce_currency' ) ? get_woocommerce_currency() : 'USD',
						'url'           => $f['url'],
						'availability'  => $p->is_in_stock() ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
					);
				}
			}
		}
		// ONE FLAT array of nodes. `site_entity_nodes()` returns a LIST of two
		// (Organization, WebSite), so appending it as a single element — which is
		// what this did until 2026-10-08 — nested a list inside the list:
		// `[{…page…},[{…Organization…},{…WebSite…}]]`. That shipped on every page
		// of every site. Conforming consumers flatten arrays of arrays, so Google
		// most likely read it anyway; a consumer that does not dropped both site
		// nodes, silently, from every page.
		//
		// Nothing could see it: the substring assertions in
		// `tests/harness-noyoast.php` are satisfied by a nested array, and so is
		// "every block parses" — a nested array is valid JSON. The harness now
		// asserts the SHAPE (flat top level, three nodes), which is the assertion
		// that has to go red if this ever regresses. Merge, do not append.
		$nodes = array_merge( array( $node ), self::site_entity_nodes() );
		echo "\t<script type=\"application/ld+json\">" . wp_json_encode( $nodes ) . "</script>\n";
	}

	/**
	 * Is WordPress core going to print a canonical tag of its own?
	 *
	 * Core adds `rel_canonical` to `wp_head` at priority 10 (`wp-includes/default-filters.php`), and the function
	 * is also CALLED DIRECTLY by many themes. Either way the tag appears, and either way `has_action` is the right
	 * question to ask — a theme calling it directly is still core's function printing core's tag.
	 *
	 * ⚠️ THIS IS WHY THE DUPLICATE EXISTED AND WHY IT IS FIXABLE RATHER THAN A TASTE QUESTION. The two emitters
	 * are OURS and CORE'S, both of them known, so nobody has to guess who is printing the second tag — and the
	 * value core prints can be ours, because `rel_canonical()` runs `wp_get_canonical_url()`, which applies the
	 * `get_canonical_url` filter.
	 */
	private static function core_prints_canonical() {
		return (bool) has_action( 'wp_head', 'rel_canonical' );
	}

	/**
	 * The nodes that describe the SITE, emitted on every page.
	 *
	 * Every field traces to a real source, and a field with no source is absent
	 * rather than guessed:
	 *
	 *   name     get_bloginfo( 'name' )
	 *   url      home_url( '/' )
	 *   logo     the Site Icon, or the custom logo if one is set — otherwise the
	 *            field is omitted entirely (an empty logo is worse than none:
	 *            consumers cache it)
	 *   sameAs   nothing yet. There is no configured social-profile setting in
	 *            this plugin, and inventing profile URLs is exactly the kind of
	 *            claim this repo does not make. Add the setting first.
	 *
	 * The two nodes are emitted as one array in a single script block, with @id
	 * values so WebSite can point at Organization. The @id fragments are ours
	 * (#organization / #website) and deliberately do not collide with the
	 * `#business` id a theme may already use for its own entity.
	 *
	 * @return array Node array, or empty array when even the name/url are missing.
	 */
	public static function site_entity_nodes() {
		$name = trim( (string) get_bloginfo( 'name' ) );
		$home = home_url( '/' );
		if ( $name === '' || $home === '' ) {
			return array();
		}

		$logo = self::site_image_url();

		$organization = array(
			'@type' => 'Organization',
			'@id'   => $home . '#organization',
			'name'  => $name,
			'url'   => $home,
		);
		if ( $logo !== '' ) {
			$organization['logo'] = $logo;
		}

		$website = array(
			'@type'           => 'WebSite',
			'@id'             => $home . '#website',
			'name'            => $name,
			'url'             => $home,
			'publisher'       => array( '@id' => $home . '#organization' ),
			'potentialAction' => array(
				'@type'       => 'SearchAction',
				'target'      => array(
					'@type'       => 'EntryPoint',
					'urlTemplate' => $home . '?s={search_term_string}',
				),
				'query-input' => 'required name=search_term_string',
			),
		);

		return array( $organization, $website );
	}

	/**
	 * Point robots.txt at a sitemap that EXISTS.
	 *
	 * Core has appended its own Sitemap line since 5.5, so on a normal site this
	 * finds a live one already there and does nothing. Two cases matter:
	 *
	 *   1. Nothing advertises a sitemap at all — a security or caching plugin
	 *      filtered it out — so ours is appended.
	 *   2. The only advertised sitemap is a path that belonged to an SEO plugin
	 *      which is no longer active. That line is stale, it 404s, and deferring
	 *      to it hides the sitemap the site actually serves. Seen live: a site
	 *      that removed Yoast kept `Sitemap: /sitemap_index.xml` in a
	 *      month-cached robots.txt while `/wp-sitemap.xml` answered 200 and went
	 *      unadvertised.
	 *
	 * Conservative by construction. We only ever judge a URL on OUR host whose
	 * path this class can attribute to one of the plugins it detects, and this
	 * filter does not run at all while such a plugin is active (see
	 * bootstrap()). Another host, an unknown path, or somebody else's sitemap
	 * index is left exactly as it was: we are not the arbiter of other people's
	 * sitemaps.
	 */
	public static function filter_robots_txt( $output, $public ) {
		if ( ! $public ) {
			return $output;
		}

		$ours  = 'Sitemap: ' . home_url( '/wp-sitemap.xml' );
		$lines = preg_split( '/\R/', (string) $output );
		$kept  = array();
		$live  = 0;

		foreach ( $lines as $line ) {
			if ( ! preg_match( '/^\s*Sitemap:\s*(\S+)/i', $line, $m ) ) {
				$kept[] = $line;
				continue;
			}
			if ( self::sitemap_url_is_dead( $m[1] ) ) {
				continue; // advertising a 404 is worse than advertising nothing
			}
			$live++;
			$kept[] = $line;
		}

		if ( $live > 0 ) {
			return $output; // a real sitemap is advertised: leave the file alone
		}

		$body = rtrim( implode( "\n", $kept ) );

		return ( $body === '' ? '' : $body . "\n" ) . "\n" . $ours . "\n";
	}

	/**
	 * Is an advertised sitemap URL one we can PROVE is dead?
	 *
	 * True only for our own host AND a path attributable to an SEO plugin this
	 * class knows about (see active_plugin()) that is not the active one.
	 * Everything else is "not dead", which leaves it alone.
	 *
	 * No HTTP request on purpose: robots.txt is served on every crawl and a
	 * lookup here would be a performance trap, so the judgement is by
	 * attribution rather than by fetching. That also means the worst case is
	 * appending a line, never removing a working one.
	 */
	public static function sitemap_url_is_dead( $url ) {
		$host     = wp_parse_url( home_url( '/' ), PHP_URL_HOST );
		$url_host = wp_parse_url( $url, PHP_URL_HOST );
		$path     = wp_parse_url( $url, PHP_URL_PATH );
		if ( ! is_string( $host ) || $host === '' || ! is_string( $path ) || $path === '' ) {
			return false;
		}
		if ( is_string( $url_host ) && $url_host !== '' && strtolower( $url_host ) !== strtolower( $host ) ) {
			return false; // another host: not ours to judge
		}

		// The conventional paths, by the plugin that serves them. A path we do not
		// recognise is never judged dead.
		$owned = array(
			'/sitemap_index.xml' => array( 'yoast', 'rankmath' ),
			'/sitemap.xml'       => array( 'aioseo' ),
			'/sitemaps.xml'      => array( 'seopress' ),
		);
		$path = '/' . ltrim( strtolower( $path ), '/' );
		if ( ! isset( $owned[ $path ] ) ) {
			return false;
		}

		// Dead only when the plugin that would serve that path is NOT the active one.
		// While such a plugin is active this filter does not even run, so this is a
		// second belt on the same braces.
		return ! in_array( self::active_plugin(), $owned[ $path ], true );
	}

	// ── a stale PHYSICAL robots.txt, and how it is judged ──────────────────

	/** The file the web server serves at /robots.txt, relative to ABSPATH. */
	const ROBOTS_FILE = 'robots.txt';

	/** How many advertised sitemap URLs one scan will fetch before stopping. */
	const ROBOTS_SITEMAP_LIMIT = 3;

	/**
	 * How many times the /robots.txt read is attempted before "it did not
	 * answer" is reported. See fetch_robots_txt() — the answer decides whether a
	 * file is moved, so a single blip must not decide it.
	 */
	const ROBOTS_FETCH_ATTEMPTS = 5;

	/** The ceiling on any one fetch's attempts. Keeps a broken site bounded. */
	const FETCH_MAX_ATTEMPTS = 5;

	/**
	 * What is being served at /robots.txt, and whether it has gone stale.
	 *
	 * THE PROBLEM
	 *
	 * WordPress serves /robots.txt DYNAMICALLY — core builds it, this class's
	 * filter_robots_txt() adds the sitemap line — but only while no physical
	 * file exists. A physical file always wins, and it is invisible to
	 * WordPress: the filter never runs, nothing in wp-admin mentions it, and a
	 * sitemap line can sit there pointing at a path that 404s since the SEO
	 * plugin that owned it was removed. Seen live: valiantmusic.com.au served a
	 * leftover `# START YOAST BLOCK` advertising /sitemap_index.xml (404) while
	 * /wp-sitemap.xml answered 200 and went unadvertised — and the owner's
	 * cPanel was held by a third party, so deleting the file was not available
	 * to him. Hence a quarantine the operator can undo, not a delete.
	 *
	 * HOW IT DECIDES — three steps, and every one of them can end the question
	 * with "nothing here" rather than with a guess. An over-eager finding is
	 * worse than none, because the fix MOVES A FILE THE OWNER MAY HAVE WRITTEN.
	 *
	 *   1. A physical file has to exist at ABSPATH . 'robots.txt', and be
	 *      readable. ABSPATH is what WordPress calls the site root; on a host
	 *      whose docroot is somewhere else, step 2 is what catches it.
	 *
	 *   2. It has to be the file actually being SERVED. Verified by fetching the
	 *      site's own /robots.txt — wp_remote_get( home_url( '/robots.txt' ) ),
	 *      i.e. exactly what a crawler gets — and comparing those bytes with the
	 *      bytes on disk. A file that is not served is not a problem: WordPress
	 *      is already building robots.txt, this class's filter is already
	 *      running, and the file is just debris. If the fetch fails (a host that
	 *      blocks loopback) nothing is decided at all — the scan reports no
	 *      check rather than inventing one.
	 *
	 *   3. It has to be STALE, judged against the sitemap the site actually
	 *      serves (dynamic_sitemap_urls() — the Sitemap lines WordPress's own
	 *      robots.txt filter chain emits right now):
	 *
	 *        a. it advertises a sitemap URL that does not answer 200, or
	 *        b. it advertises no live sitemap at all while the site's own
	 *           sitemap is itself live.
	 *
	 *      Clause (b) is deliberately narrower than "it lacks the site's
	 *      sitemap". A file that already points crawlers at a DIFFERENT live
	 *      sitemap (a hand-rolled one, a CDN's) is doing its job; quarantining
	 *      it would take its Disallow rules out of service for no gain. The
	 *      question that matters is "can a crawler find a working sitemap", not
	 *      "is this byte-for-byte what WordPress would have written".
	 *
	 * A GOOD file therefore produces NO finding: served, and advertising a live
	 * sitemap. So does no file at all, so does a file that is shadowed, and so
	 * does an unreadable/unreachable one. The check is reported as `good` in all
	 * of those cases, never as a silent omission.
	 *
	 * @return array|null Null when the question cannot be answered honestly
	 *                    (unreadable file, or the site did not answer).
	 */
	public static function robots_txt_state() {
		$file = ABSPATH . self::ROBOTS_FILE;
		$base = array(
			'file'                 => $file,
			'physical'             => false,
			'served'               => false,
			'stale'                => false,
			'reason'               => null,
			'advertised'           => array(),
			'dead'                 => array(),
			'dynamic_sitemaps'     => array(),
			'missing_site_sitemap' => false,
		);

		if ( ! file_exists( $file ) ) {
			return $base;
		}
		$body = @file_get_contents( $file );
		if ( ! is_string( $body ) || '' === trim( $body ) ) {
			return null; // There, but we cannot read it — so we cannot judge it.
		}
		$base['physical'] = true;

		$served = self::fetch_robots_txt();
		if ( null === $served ) {
			// The site did not answer for its own robots.txt. Which file is being
			// served is then unknowable from in here, and guessing is how a
			// finding gets invented for a file nobody is serving.
			return null;
		}
		if ( ! self::bodies_match( $body, $served ) ) {
			return $base; // A physical file exists but is NOT the one being served.
		}
		$base['served'] = true;

		$public = (bool) get_option( 'blog_public' );
		if ( ! $public ) {
			// The whole point of the dynamic file on a private site is
			// "Disallow: /" — there is no sitemap to advertise to anyone, so a
			// physical file cannot be stale in the sense this check means.
			$base['reason'] = 'This site is set to discourage search engines, so there is no sitemap to advertise and nothing here needs changing.';
			return $base;
		}

		$advertised               = self::sitemap_urls_in( $body );
		$base['advertised']       = $advertised;
		$base['dynamic_sitemaps'] = self::dynamic_sitemap_urls();

		$checked = array_slice( $advertised, 0, self::ROBOTS_SITEMAP_LIMIT );
		$dead    = array();
		foreach ( $checked as $url ) {
			if ( 200 !== self::fetch_url( $url, false )['code'] ) {
				$dead[] = $url;
			}
		}
		$base['dead'] = $dead;

		// Counted over the URLs actually checked, so "no live sitemap" is a fact
		// about this run rather than an assumption about the lines we skipped.
		$live_advertised = count( $checked ) - count( $dead );
		$missing         = array();
		foreach ( $base['dynamic_sitemaps'] as $url ) {
			if ( ! self::advertises( $body, $url ) ) {
				$missing[] = $url;
			}
		}
		// Only demand the site's own sitemap when that sitemap is real.
		$site_sitemap_live = array();
		foreach ( array_slice( $missing, 0, self::ROBOTS_SITEMAP_LIMIT ) as $url ) {
			if ( 200 === self::fetch_url( $url, false )['code'] ) {
				$site_sitemap_live[] = $url;
			}
		}
		$base['missing_site_sitemap'] = ! empty( $site_sitemap_live );

		if ( $dead ) {
			$base['stale']  = true;
			$base['reason'] = 'A physical robots.txt file — not WordPress — is serving /robots.txt on this site, so Morpheus\'s own robots.txt filter never runs. It advertises '
				. implode( ', ', $dead ) . ', which does not answer (a sitemap that 404s tells search engines to trust a file that is not there). '
				. self::sitemap_advice( $base['dynamic_sitemaps'] );
			return $base;
		}

		if ( $base['missing_site_sitemap'] && 0 === $live_advertised ) {
			$base['stale']  = true;
			$base['reason'] = 'A physical robots.txt file — not WordPress — is serving /robots.txt on this site, and it advertises no sitemap at all. '
				. self::sitemap_advice( $site_sitemap_live );
			return $base;
		}

		// Served, and nothing it advertises is broken. The sentence still has to be
		// TRUE when it advertises nothing at all — "every sitemap it advertises
		// answers" is vacuously true there, and reads as though a sitemap exists.
		$base['reason'] = $advertised
			? 'A physical robots.txt file is being served, and every sitemap it advertises answers — so it is doing its job and needs nothing.'
			: 'A physical robots.txt file is being served, and this site has no sitemap for it to advertise, so there is nothing stale about it.';
		return $base;
	}

	/** The sentence naming the sitemap(s) that should be advertised. */
	private static function sitemap_advice( $urls ) {
		if ( ! $urls ) {
			return 'WordPress would serve its own robots.txt in its place.';
		}
		return 'WordPress would advertise ' . implode( ', ', $urls ) . ' in its place.';
	}

	/**
	 * The Sitemap: URLs a robots.txt body advertises, in the order they appear.
	 *
	 * Sitemap directives are a whitespace-separated line (`Sitemap: <url>`), and
	 * anything that is not one is not our business — comments, User-agent and
	 * Disallow rules are all left to the file's author.
	 */
	public static function sitemap_urls_in( $body ) {
		$out = array();
		foreach ( preg_split( '/\R/', (string) $body ) as $line ) {
			if ( preg_match( '/^\s*Sitemap:\s*(\S+)/i', $line, $m ) ) {
				$out[] = $m[1];
			}
		}
		return $out;
	}

	/** Does a robots.txt body advertise exactly this URL? */
	public static function advertises( $body, $url ) {
		foreach ( self::sitemap_urls_in( $body ) as $found ) {
			if ( self::same_url( $found, $url ) ) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Do two robots.txt bodies carry the same bytes?
	 *
	 * Line endings and trailing whitespace are normalised, because a host (or a
	 * proxy) can rewrite those on the way out without changing a single
	 * directive — and a byte-for-byte compare that is one `\r` too strict would
	 * decide a served file is "not served", which is the failure that matters
	 * here (the finding would never be offered on the site that needs it).
	 * Everything else has to match: this test is what proves the physical file
	 * is the one a crawler receives.
	 *
	 * The implementation MOVED to helpers.php (morpheus_bodies_match) when the
	 * same question was asked about wp-content/debug.log: one rule, two files
	 * asking it. This method stays so every existing caller is unchanged, and it
	 * delegates rather than keeping a second copy that could drift.
	 */
	public static function bodies_match( $a, $b ) {
		return morpheus_bodies_match( $a, $b );
	}

	/** Do two URLs point at the same sitemap? Scheme and a trailing slash are not the difference. */
	public static function same_url( $a, $b ) {
		$norm = function ( $u ) {
			$u = strtolower( trim( (string) $u ) );
			$u = preg_replace( '#^https?://#', '', $u );
			return rtrim( $u, '/' );
		};
		return $norm( $a ) === $norm( $b ) && '' !== $norm( $a );
	}

	/**
	 * The Sitemap: URLs this site's robots.txt advertises when NO physical file
	 * is in the way — the file's own author, core and this plugin, in the order
	 * the filter chain runs.
	 *
	 * Asking the filter chain rather than assuming `home_url( '/wp-sitemap.xml' )`
	 * is the whole point: which sitemap exists is the site's answer, not ours.
	 * With Yoast or Rank Math active it is THEIR path; with core alone it is
	 * /wp-sitemap.xml; with somebody's custom filter it is whatever they emit.
	 * Hard-coding ours would make every correctly-Yoast-configured physical file
	 * look stale, and the fix would then take a working robots.txt away.
	 *
	 * The seed body is the shape core's do_robots() builds, so a filter that
	 * appends or rewrites sees something realistic. This is a string filter that
	 * runs on every crawl; calling it here is the same work, not a side effect.
	 */
	public static function dynamic_sitemap_urls() {
		$public = (bool) get_option( 'blog_public' );
		if ( ! $public ) {
			return array();
		}
		$body = "User-agent: *\nDisallow: /wp-admin/\nAllow: /wp-admin/admin-ajax.php\n";
		return self::sitemap_urls_in( (string) apply_filters( 'robots_txt', $body, $public ) );
	}

	/**
	 * GET a URL and report its status and body, with caching defeated.
	 *
	 * Deliberately timid: this only ever runs from the health scan (cached for
	 * five minutes), never from filter_robots_txt(), because robots.txt is
	 * fetched on every crawl and a request there would be a performance trap —
	 * see sitemap_url_is_dead(), which judges by attribution for that reason.
	 * Here the question is the opposite one ("does this URL answer?") and only a
	 * real request can answer it.
	 *
	 * `$follow` is the difference between the two questions this answers, and it
	 * is not a detail:
	 *
	 *   * fetching /robots.txt FOLLOWS a redirect, because the bytes a crawler
	 *     ends up with are exactly what is being compared with the file on disk;
	 *   * judging a SITEMAP does not. "It advertises a sitemap URL that does not
	 *     return 200" is about the URL the file actually names: a 301 to
	 *     somewhere else is not that sitemap answering, and following redirects
	 *     would let a redirect to any 200 page — the front page, a soft 404 —
	 *     read as a working sitemap. It also keeps this honest about a site
	 *     where THIS plugin's legacy-sitemap redirect (see
	 *     register_legacy_sitemap_redirect()) turns the removed plugin's path
	 *     into a 301: the file is still naming a location that is not the
	 *     sitemap, and still hiding the one the site serves.
	 *
	 * @return array{code:int, body:?string, error:?string}
	 */
	public static function fetch_url( $url, $follow = true, $attempts = 1 ) {
		if ( ! is_string( $url ) || '' === $url ) {
			return array( 'code' => 0, 'body' => null, 'error' => 'empty url' );
		}
		$attempts = max( 1, min( self::FETCH_MAX_ATTEMPTS, (int) $attempts ) );
		$last     = array( 'code' => 0, 'body' => null, 'error' => 'no attempt was made' );

		for ( $i = 0; $i < $attempts; $i++ ) {
			if ( $i > 0 ) {
				// A blip, not a load test: five tries spread over well under a
				// second still cost far less than a wrong verdict.
				usleep( 150000 );
			}
			$res = wp_remote_get( $url, array(
				'timeout'     => 8,
				'redirection' => $follow ? 2 : 0,
				// A verification fetch must not be answered out of a cache
				// holding the very file that was just moved.
				'headers'     => array( 'Cache-Control' => 'no-cache', 'Pragma' => 'no-cache' ),
			) );
			if ( is_wp_error( $res ) ) {
				$last = array( 'code' => 0, 'body' => null, 'error' => $res->get_error_message() );
				continue;
			}
			$code = (int) wp_remote_retrieve_response_code( $res );
			$last = array( 'code' => $code, 'body' => (string) wp_remote_retrieve_body( $res ), 'error' => null );
			// A 5xx is "the site did not answer", not an answer about the file.
			// Anything below it — 200, 404, 410, a 3xx we chose not to follow —
			// IS an answer, and retrying it would only make the check slow.
			if ( $code < 500 ) {
				return $last;
			}
		}
		return $last;
	}

	/**
	 * GET a robots.txt URL and return its body, or null when the site did not
	 * answer after several attempts.
	 *
	 * THE RETRY IS PART OF THE HONESTY, not a performance nicety. This answer
	 * decides whether Morpheus MOVES A FILE IN THE SITE ROOT, and (after a
	 * quarantine) whether it puts that file back. A single 5xx is a blip — a
	 * momentarily overloaded host, a proxy hiccup — and concluding "the site did
	 * not answer" from it would either hide a real finding or, worse, roll back a
	 * fix that actually worked. So the question is asked up to
	 * ROBOTS_FETCH_ATTEMPTS times, and only a site that will not answer at all is
	 * reported as not answering.
	 */
	public static function fetch_robots_txt( $url = null ) {
		$url = is_string( $url ) && '' !== $url ? $url : home_url( '/robots.txt' );
		$res = self::fetch_url( $url, true, self::ROBOTS_FETCH_ATTEMPTS );
		return ( 200 === $res['code'] && is_string( $res['body'] ) ) ? $res['body'] : null;
	}

	/**
	 * Serve the sitemap path a removed SEO plugin used to own.
	 *
	 * `/sitemap_index.xml` 404s the moment Yoast or Rank Math is deactivated, but
	 * the URL lives on: in robots.txt (cached for a month by caching plugins), in
	 * Search Console submissions, in third-party links. A 301 to the sitemap core
	 * actually serves repairs all three at once, and the assertion in
	 * tests/harness-noyoast.php pins that it is only registered in that case.
	 */
	public static function register_legacy_sitemap_redirect() {
		if ( ! self::owns_head() ) {
			return; // someone else legitimately serves this path — do not touch it
		}
		add_rewrite_rule( '^sitemap_index\.xml$', 'index.php?morpheus_legacy_sitemap=1', 'top' );
		add_rewrite_tag( '%morpheus_legacy_sitemap%', '1' );
	}

	/** The redirect itself, on the query var the rewrite sets. */
	public static function maybe_redirect_legacy_sitemap() {
		if ( ! get_query_var( 'morpheus_legacy_sitemap' ) ) {
			return;
		}
		wp_safe_redirect( home_url( '/wp-sitemap.xml' ), 301 );
		exit;
	}
}
