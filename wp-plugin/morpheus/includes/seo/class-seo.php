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
 *     title, description, canonical, robots, Open Graph and Twitter tags
 *     itself, from its own postmeta. Full control, all operable in the widget.
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

	// Content that can be indexed and therefore needs SEO. Attachments and
	// revisions are deliberately excluded.
	const POST_TYPES = array( 'post', 'page', 'product' );

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
		foreach ( self::POST_TYPES as $type ) {
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
		foreach ( self::POST_TYPES as $type ) {
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
		$out = str_replace(
			array( '%title%', '%sitename%', '%tagline%', '%excerpt%', '%content%' ),
			array(
				get_the_title( $post_id ),
				get_bloginfo( 'name' ),
				get_bloginfo( 'description' ),
				wp_strip_all_tags( $excerpt ),
				self::content_excerpt( $post ),
			),
			(string) $template
		);
		return trim( preg_replace( '/\s+/', ' ', $out ) );
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
			'post_type'      => array_values( array_filter( self::POST_TYPES, 'post_type_exists' ) ),
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
		foreach ( self::POST_TYPES as $type ) {
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
			'post_types'    => self::POST_TYPES,
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
		$types  = isset( $data['types'] ) && is_array( $data['types'] ) ? array_map( 'sanitize_key', $data['types'] ) : self::POST_TYPES;
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
		$canonical = $f['canonical'] !== '' ? $f['canonical'] : $url;
		if ( $canonical ) {
			echo "\t<link rel=\"canonical\" href=\"" . esc_url( $canonical ) . "\" />\n";
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
	 * JSON-LD structured data. Kept small and honest: Article for posts,
	 * Product for products (when WooCommerce gives us a price), WebPage
	 * otherwise, plus the site's own organization node on every page. No
	 * invented ratings or offers.
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
		echo "\t<script type=\"application/ld+json\">" . wp_json_encode( $node ) . "</script>\n";
	}

	/**
	 * Point robots.txt at WordPress's own sitemap if nothing else has.
	 *
	 * A backstop, not the usual source: core has appended its own Sitemap line
	 * since 5.5, so on a normal site this finds one already there and does
	 * nothing (asserted in tests/harness-noyoast.php, which removes core's
	 * filter to test this one on its own). It matters when something else has
	 * filtered the output — a security or caching plugin that rewrites
	 * robots.txt would otherwise leave the site's sitemap undiscoverable.
	 */
	public static function filter_robots_txt( $output, $public ) {
		if ( ! $public ) {
			return $output;
		}
		if ( stripos( $output, 'Sitemap:' ) === false ) {
			$output .= "\nSitemap: " . home_url( '/wp-sitemap.xml' ) . "\n";
		}
		return $output;
	}
}
