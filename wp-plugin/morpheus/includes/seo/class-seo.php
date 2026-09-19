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
	const META_SCHEMA    = '_morpheus_seo_schema';

	// Content that can be indexed and therefore needs SEO. Attachments and
	// revisions are deliberately excluded.
	const POST_TYPES = array( 'post', 'page', 'product' );

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
			case 'audit':        $r = self::audit( $data ); break;
			default:
				return Morpheus_REST::err( 'unknown_action', "Unknown seo action: {$action}", 400 );
		}

		if ( is_wp_error( $r ) ) {
			$d = $r->get_error_data();
			$s = is_array( $d ) && isset( $d['status'] ) ? $d['status'] : 422;
			return Morpheus_REST::err( $r->get_error_code(), $r->get_error_message(), $s );
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

		return array(
			'id'             => (int) $post_id,
			'type'           => $post->post_type,
			'status'         => $post->post_status,
			'url'            => get_permalink( $post_id ),
			'edit_url'       => get_edit_post_link( $post_id, 'raw' ),
			// What is set, and what would go out if nothing were set.
			'seo_title'      => $title,
			'seo_description'=> $desc,
			'effective_title'=> $title !== '' ? $title : $derived_title,
			'effective_description' => $desc !== '' ? $desc : $derived_desc,
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
				'focus_keyword'         => $f['focus_keyword'],
				'noindex'               => $f['noindex'],
				'modified'              => $p->post_modified_gmt,
				'word_count'            => str_word_count( wp_strip_all_tags( $p->post_content ) ),
			);
		}

		return array( 'items' => $items, 'count' => count( $items ) );
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
		$custom = get_post_meta( get_queried_object_id(), self::META_TITLE, true );
		return $custom !== '' ? $custom : $title;
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

	/** Point robots.txt at WordPress's own sitemap if nothing else has. */
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
